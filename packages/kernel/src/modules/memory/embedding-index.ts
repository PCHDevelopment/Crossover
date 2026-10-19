import type { Pool } from "@crossover/db";
import { embeddingText, encodeVector, normalize, type EmbeddingProvider } from "./embeddings.js";

export interface MemoryEmbeddingIndexerOptions {
  pool: Pool;
  provider: EmbeddingProvider;
  batchSize?: number;
  timeoutMs?: number;
  sweepIntervalMs?: number;
  onError?: (error: unknown, roomId: string) => void;
}

type Entry = { key: string; value: string; revision: number };

/** Rebuildable, off-actor index of the authoritative memory_entries table. */
export class MemoryEmbeddingIndexer {
  private readonly pool: Pool;
  private readonly provider: EmbeddingProvider;
  private readonly batchSize: number;
  private readonly timeoutMs: number;
  private readonly sweepIntervalMs: number;
  private readonly onError: (error: unknown, roomId: string) => void;
  private readonly controller = new AbortController();
  private readonly running = new Map<string, Promise<void>>();
  private readonly pending = new Set<string>();
  private timer: NodeJS.Timeout | undefined;

  constructor(options: MemoryEmbeddingIndexerOptions) {
    this.pool = options.pool;
    this.provider = options.provider;
    this.batchSize = options.batchSize ?? 32;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.sweepIntervalMs = options.sweepIntervalMs ?? 60_000;
    this.onError =
      options.onError ??
      ((error, roomId) =>
        console.error(
          "memory index",
          roomId,
          error instanceof Error ? error.name : "unknown error",
        ));
    if (
      this.batchSize < 1 ||
      this.batchSize > 256 ||
      this.timeoutMs < 1 ||
      this.sweepIntervalMs < 1
    )
      throw new RangeError("Invalid memory indexer limits");
    if (this.provider.dimensions < 1 || this.provider.dimensions > 4096)
      throw new RangeError("Invalid embedding dimensions");
  }

  /** Coalesce notifications to one active sync and at most one follow-up per room. */
  schedule(roomId: string): void {
    if (this.controller.signal.aborted) return;
    if (this.running.has(roomId)) {
      this.pending.add(roomId);
      return;
    }
    const work = (async () => {
      do {
        this.pending.delete(roomId);
        try {
          await this.syncRoom(roomId, this.controller.signal);
        } catch (error) {
          if (!this.controller.signal.aborted) this.onError(error, roomId);
          break;
        }
      } while (this.pending.has(roomId) && !this.controller.signal.aborted);
    })().finally(() => this.running.delete(roomId));
    this.running.set(roomId, work);
  }

  /** Synchronize a room without holding a room actor or SQL transaction during embedding. */
  async syncRoom(
    roomId: string,
    signal: AbortSignal,
  ): Promise<{ embedded: number; removed: number }> {
    signal.throwIfAborted();
    const room = await this.pool.query<{ purge_started_at: Date | null }>(
      "SELECT purge_started_at FROM rooms WHERE id = $1",
      [roomId],
    );
    if (!room.rows[0] || room.rows[0].purge_started_at) return { embedded: 0, removed: 0 };
    const removed = await this.pool.query(
      `DELETE FROM memory_embeddings e USING memory_entries m
       WHERE e.room_id = $1 AND m.room_id = e.room_id AND m.key = e.key
         AND (m.deleted OR m.redacted OR e.model <> $2)`,
      [roomId, this.provider.model],
    );
    let embedded = 0;
    while (true) {
      signal.throwIfAborted();
      const pending = await this.pool.query<Entry>(
        `SELECT m.key, m.value, m.revision FROM memory_entries m
         LEFT JOIN memory_embeddings e ON e.room_id = m.room_id AND e.key = m.key AND e.model = $2
         WHERE m.room_id = $1 AND NOT m.deleted AND NOT m.redacted
           AND (e.revision IS NULL OR e.revision <> m.revision)
         ORDER BY m.updated_at, m.key LIMIT 256`,
        [roomId, this.provider.model],
      );
      if (pending.rows.length === 0) break;
      let wrote = 0;
      for (let i = 0; i < pending.rows.length; i += this.batchSize) {
        const batch = pending.rows.slice(i, i + this.batchSize);
        const batchSignal = AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]);
        const vectors = await this.provider.embed(
          batch.map((entry) => embeddingText(entry.key, entry.value, this.provider.maxInputChars)),
          batchSignal,
        );
        batchSignal.throwIfAborted();
        if (vectors.length !== batch.length) throw new RangeError("Embedding count mismatch");
        for (let j = 0; j < batch.length; j += 1) {
          const entry = batch[j]!;
          const vector = vectors[j]!;
          if (vector.length !== this.provider.dimensions)
            throw new RangeError("Embedding dimensions mismatch");
          const result = await this.pool.query(
            `INSERT INTO memory_embeddings (room_id, key, model, revision, dims, embedding)
             SELECT $1, $2, $3, $4, $5, $6 FROM memory_entries
              WHERE room_id = $1 AND key = $2 AND revision = $4
                AND NOT deleted AND NOT redacted
             ON CONFLICT (room_id, key, model) DO UPDATE
               SET revision = EXCLUDED.revision, dims = EXCLUDED.dims,
                   embedding = EXCLUDED.embedding, created_at = clock_timestamp()`,
            [
              roomId,
              entry.key,
              this.provider.model,
              entry.revision,
              this.provider.dimensions,
              encodeVector(normalize(vector)),
            ],
          );
          wrote += result.rowCount ?? 0;
        }
      }
      embedded += wrote;
      // A continuously changing row should be retried by the next notification or sweep.
      if (wrote === 0) break;
    }
    return { embedded, removed: removed.rowCount ?? 0 };
  }

  /** Find rooms with missing, stale or removable vectors, including after missed publication. */
  async sweep(): Promise<void> {
    if (this.controller.signal.aborted) return;
    const rooms = await this.pool.query<{ room_id: string }>(
      `SELECT DISTINCT m.room_id FROM memory_entries m
       JOIN rooms r ON r.id = m.room_id AND r.purge_started_at IS NULL
       LEFT JOIN memory_embeddings e ON e.room_id = m.room_id AND e.key = m.key AND e.model = $1
       WHERE (NOT m.deleted AND NOT m.redacted AND (e.revision IS NULL OR e.revision <> m.revision))
          OR (e.room_id IS NOT NULL AND (m.deleted OR m.redacted))
          OR EXISTS (SELECT 1 FROM memory_embeddings old
                     WHERE old.room_id = m.room_id AND old.key = m.key AND old.model <> $1)
       LIMIT 100`,
      [this.provider.model],
    );
    for (const room of rooms.rows) this.schedule(room.room_id);
  }

  async rebuild(roomId: string): Promise<void> {
    await this.pool.query("DELETE FROM memory_embeddings WHERE room_id = $1 AND model = $2", [
      roomId,
      this.provider.model,
    ]);
    await this.syncRoom(roomId, this.controller.signal);
  }

  start(): void {
    if (this.timer || this.controller.signal.aborted) return;
    void this.sweep().catch((error) => this.onError(error, "<sweep>"));
    this.timer = setInterval(() => {
      void this.sweep().catch((error) => this.onError(error, "<sweep>"));
    }, this.sweepIntervalMs);
    this.timer.unref();
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.controller.abort();
    this.pending.clear();
    await Promise.all(this.running.values());
  }
}
