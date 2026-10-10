import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isId } from "@crossover/protocol";

export type SandboxExecReason =
  "exit" | "cancelled" | "timed_out" | "revoked" | "sandbox_stopped" | "start_failed";

export interface SandboxExecLogMetadata {
  exec_id: string;
  room_id: string;
  sandbox_id: string;
  participant_id: string;
  command: string;
  cwd: string;
  timeout_s: number;
  started_at: string;
  finished_at?: string;
  exit_code?: number | null;
  duration_ms?: number;
  reason?: SandboxExecReason;
  output_bytes: number;
  truncated: boolean;
}

export type SandboxOutputChunk =
  | { cursor: number; kind: "data"; stream: "stdout" | "stderr"; data: Uint8Array }
  | { cursor: number; kind: "truncated" };

export type SandboxOutputUpdate =
  | { kind: "chunk"; chunk: SandboxOutputChunk }
  | { kind: "finished"; metadata: SandboxExecLogMetadata };

/** Chunked, private execution logs. Implementations must not expose these objects publicly. */
export interface LogStore {
  create(metadata: SandboxExecLogMetadata): Promise<void>;
  append(execId: string, chunk: SandboxOutputChunk): Promise<void>;
  get(execId: string): Promise<SandboxExecLogMetadata | undefined>;
  read(execId: string, afterCursor: number, limit: number): Promise<SandboxOutputChunk[]>;
  update(execId: string, patch: Partial<SandboxExecLogMetadata>): Promise<void>;
  sweepExpired(now?: number): Promise<number>;
}

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_READ_CHUNKS = 500;

function assertExecId(value: string): void {
  if (!isId(value, "exec")) throw new Error("Invalid sandbox execution id");
}

function encode(chunk: SandboxOutputChunk): string {
  return JSON.stringify(
    chunk.kind === "data"
      ? {
          cursor: chunk.cursor,
          kind: chunk.kind,
          stream: chunk.stream,
          data: Buffer.from(chunk.data).toString("base64"),
        }
      : chunk,
  );
}

function decode(value: string): SandboxOutputChunk {
  const parsed = JSON.parse(value) as Record<string, unknown>;
  if (parsed["kind"] === "truncated" && Number.isSafeInteger(parsed["cursor"]))
    return { cursor: parsed["cursor"] as number, kind: "truncated" };
  if (
    parsed["kind"] === "data" &&
    (parsed["stream"] === "stdout" || parsed["stream"] === "stderr") &&
    Number.isSafeInteger(parsed["cursor"]) &&
    typeof parsed["data"] === "string"
  ) {
    return {
      cursor: parsed["cursor"] as number,
      kind: "data",
      stream: parsed["stream"],
      data: Buffer.from(parsed["data"], "base64"),
    };
  }
  throw new Error("Invalid sandbox log chunk");
}

/** Local durable adapter for development and single-node deployments; S3 can implement LogStore. */
export class FileLogStore implements LogStore {
  constructor(readonly root: string) {}

  private directory(execId: string): string {
    assertExecId(execId);
    return join(this.root, execId);
  }

  async create(metadata: SandboxExecLogMetadata): Promise<void> {
    const directory = this.directory(metadata.exec_id);
    await mkdir(join(directory, "chunks"), { recursive: true, mode: 0o700 });
    await writeFile(join(directory, "metadata.json"), JSON.stringify(metadata), {
      flag: "wx",
      mode: 0o600,
    });
  }

  async append(execId: string, chunk: SandboxOutputChunk): Promise<void> {
    if (!Number.isSafeInteger(chunk.cursor) || chunk.cursor < 1)
      throw new Error("Invalid sandbox log cursor");
    const path = join(
      this.directory(execId),
      "chunks",
      `${String(chunk.cursor).padStart(10, "0")}.json`,
    );
    const file = await open(path, "wx", 0o600);
    try {
      await file.writeFile(encode(chunk));
      await file.sync();
    } finally {
      await file.close();
    }
  }

  async get(execId: string): Promise<SandboxExecLogMetadata | undefined> {
    try {
      return JSON.parse(
        await readFile(join(this.directory(execId), "metadata.json"), "utf8"),
      ) as SandboxExecLogMetadata;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async read(execId: string, afterCursor: number, limit: number): Promise<SandboxOutputChunk[]> {
    const boundedLimit = Math.min(MAX_READ_CHUNKS, Math.max(1, Math.floor(limit)));
    const directory = join(this.directory(execId), "chunks");
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const selected = names
      .filter((name) => /^\d{10}\.json$/.test(name) && Number(name.slice(0, 10)) > afterCursor)
      .sort()
      .slice(0, boundedLimit);
    return Promise.all(
      selected.map(async (name) => decode(await readFile(join(directory, name), "utf8"))),
    );
  }

  async update(execId: string, patch: Partial<SandboxExecLogMetadata>): Promise<void> {
    const directory = this.directory(execId);
    const path = join(directory, "metadata.json");
    const current = await this.get(execId);
    if (!current) throw new Error("Sandbox execution log not found");
    if (patch.exec_id !== undefined && patch.exec_id !== execId)
      throw new Error("Sandbox execution id is immutable");
    const temporary = join(directory, `metadata.${process.pid}.${Date.now()}.tmp`);
    await writeFile(temporary, JSON.stringify({ ...current, ...patch }), {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, path);
  }

  async sweepExpired(now = Date.now()): Promise<number> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const names = await readdir(this.root);
    let removed = 0;
    for (const name of names) {
      if (!isId(name, "exec")) continue;
      const path = this.directory(name);
      let metadata: SandboxExecLogMetadata | undefined;
      try {
        metadata = JSON.parse(
          await readFile(join(path, "metadata.json"), "utf8"),
        ) as SandboxExecLogMetadata;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const createdAt = metadata ? Date.parse(metadata.started_at) : (await stat(path)).mtimeMs;
      if (Number.isFinite(createdAt) && now - createdAt >= RETENTION_MS) {
        await rm(path, { recursive: true, force: true });
        removed++;
      }
    }
    return removed;
  }
}

/** In-memory store for focused tests; production paths inject a durable LogStore. */
export class MemoryLogStore implements LogStore {
  private readonly metadata = new Map<string, SandboxExecLogMetadata>();
  private readonly chunks = new Map<string, SandboxOutputChunk[]>();

  async create(metadata: SandboxExecLogMetadata): Promise<void> {
    assertExecId(metadata.exec_id);
    if (this.metadata.has(metadata.exec_id))
      throw new Error("Sandbox execution log already exists");
    this.metadata.set(metadata.exec_id, structuredClone(metadata));
    this.chunks.set(metadata.exec_id, []);
  }
  async append(execId: string, chunk: SandboxOutputChunk): Promise<void> {
    const chunks = this.chunks.get(execId);
    if (!chunks) throw new Error("Sandbox execution log not found");
    chunks.push(chunk.kind === "data" ? { ...chunk, data: Buffer.from(chunk.data) } : chunk);
  }
  async get(execId: string): Promise<SandboxExecLogMetadata | undefined> {
    const metadata = this.metadata.get(execId);
    return metadata ? structuredClone(metadata) : undefined;
  }
  async read(execId: string, afterCursor: number, limit: number): Promise<SandboxOutputChunk[]> {
    return (this.chunks.get(execId) ?? [])
      .filter((chunk) => chunk.cursor > afterCursor)
      .slice(0, Math.min(MAX_READ_CHUNKS, Math.max(1, Math.floor(limit))))
      .map((chunk) =>
        chunk.kind === "data" ? { ...chunk, data: Buffer.from(chunk.data) } : chunk,
      );
  }
  async update(execId: string, patch: Partial<SandboxExecLogMetadata>): Promise<void> {
    const current = this.metadata.get(execId);
    if (!current) throw new Error("Sandbox execution log not found");
    this.metadata.set(execId, { ...current, ...patch });
  }
  async sweepExpired(now = Date.now()): Promise<number> {
    let removed = 0;
    for (const [execId, metadata] of this.metadata) {
      if (now - Date.parse(metadata.started_at) >= RETENTION_MS) {
        this.metadata.delete(execId);
        this.chunks.delete(execId);
        removed++;
      }
    }
    return removed;
  }
}

/** Small in-process fanout; a slow WebSocket is isolated by its own bounded sender. */
export class SandboxOutputHub {
  private readonly listeners = new Map<string, Set<(update: SandboxOutputUpdate) => void>>();

  publish(execId: string, chunk: SandboxOutputChunk): void {
    this.dispatch(execId, { kind: "chunk", chunk });
  }

  publishFinished(execId: string, metadata: SandboxExecLogMetadata): void {
    this.dispatch(execId, { kind: "finished", metadata });
  }

  private dispatch(execId: string, update: SandboxOutputUpdate): void {
    for (const listener of this.listeners.get(execId) ?? []) {
      try {
        listener(update);
      } catch {
        // One slow or closed consumer cannot stop the sandbox process or another subscriber.
      }
    }
  }

  subscribe(execId: string, listener: (update: SandboxOutputUpdate) => void): () => void {
    let listeners = this.listeners.get(execId);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(execId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners!.delete(listener);
      if (listeners!.size === 0) this.listeners.delete(execId);
    };
  }
}
