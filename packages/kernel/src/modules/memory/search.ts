import { CrossoverError } from "@crossover/protocol";
import { z } from "zod";
import type { Dispatcher } from "../../dispatcher.js";
import { loadAuthorKinds, provenanceOf } from "../provenance.js";
import { cosine, decodeVector, normalize, type EmbeddingProvider } from "./embeddings.js";
import { likePrefix } from "./memory.js";

export const MAX_MEMORY_SEARCH_RESULTS = 50;
/** Candidates ranked per search; past this the answer is `partial`. */
export const MEMORY_SEARCH_MAX_SCAN = 20_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const SNIPPET_CODE_POINTS = 300;

export const memorySearchParams = z.strictObject({
  query: z
    .string()
    .min(1)
    .max(2_000)
    .refine((q) => !q.includes("\0")),
  /** Same literal-prefix semantics as memory.list. */
  prefix: z.string().max(200).default(""),
  limit: z.number().int().min(1).max(MAX_MEMORY_SEARCH_RESULTS).default(10),
});

interface Candidate {
  key: string;
  revision: number;
  dims: number;
  embedding: Buffer;
}

interface EntryRow {
  key: string;
  revision: number;
  content_type: string;
  author_id: string;
  updated_at: Date;
  value: string;
}

/**
 * Register `memory.search { query, prefix?, limit? }` (T1580, §18.4): the entries most related
 * to a question, ranked by embedding similarity (cosine, highest first, ties by key bytewise
 * like `memory.list`). It reads the derived `memory_embeddings` index but **joins every candidate
 * to its authoritative `memory_entries` row**: a deleted, redacted or since-changed entry is
 * never ranked. It has `memory.get`'s scope and capability (`memory.read`, room-wide).
 *
 * - Without a provider the server answers `VALIDATION` `memory_search_disabled`.
 * - A provider that fails or times out is `UNAVAILABLE` `embedding_provider_unavailable`; the
 *   provider's own error text (which can carry credentials or URLs) is never returned.
 * - At most {@link MEMORY_SEARCH_MAX_SCAN} candidates (the most recently updated) are scored;
 *   `partial: true` says there were more. `pending` counts live entries under the prefix that
 *   the index has not caught up with yet, so a fresh write may be missing from the results.
 */
export function registerMemorySearchCommand(
  dispatcher: Dispatcher,
  options: { provider?: EmbeddingProvider; timeoutMs?: number; maxScan?: number } = {},
): void {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxScan = options.maxScan ?? MEMORY_SEARCH_MAX_SCAN;
  dispatcher.registerCommand({
    method: "memory.search",
    action: "memory.read",
    mutating: false,
    view: "none",
    view_reason:
      "memory keys are room-shared, readable alike by every member (§18.3); no events, paths or denials",
    params: memorySearchParams,
    execute: async (ctx, p) => {
      const provider = options.provider;
      if (!provider)
        throw new CrossoverError("VALIDATION", "Memory search is not enabled on this server", {
          details: { reason: "memory_search_disabled" },
        });
      let query: Float32Array;
      try {
        const [vector] = await provider.embed([p.query], AbortSignal.timeout(timeoutMs));
        if (!vector || vector.length !== provider.dimensions) throw new Error("bad vector");
        query = normalize(vector);
      } catch {
        throw new CrossoverError("UNAVAILABLE", "Embedding provider unavailable", {
          details: { reason: "embedding_provider_unavailable" },
        });
      }
      const pattern = likePrefix(p.prefix);
      // The join to the authoritative row is the security property of this command.
      const { rows: found } = await ctx.client.query<Candidate>(
        `SELECT e.key, e.revision, e.dims, e.embedding
           FROM memory_embeddings e
           JOIN memory_entries m ON m.room_id = e.room_id AND m.key = e.key AND m.revision = e.revision
          WHERE e.room_id = $1 AND e.model = $2 AND NOT m.deleted AND NOT m.redacted
            AND m.key LIKE $3 ESCAPE '\\'
          ORDER BY m.updated_at DESC
          LIMIT $4`,
        [ctx.room_id, provider.model, pattern, maxScan + 1],
      );
      const partial = found.length > maxScan;
      const scored = found.slice(0, maxScan).flatMap((row) => {
        if (row.dims !== provider.dimensions) return [];
        return [{ row, score: cosine(query, decodeVector(row.embedding, row.dims)) }];
      });
      scored.sort(
        (a, b) =>
          b.score - a.score || Buffer.compare(Buffer.from(a.row.key), Buffer.from(b.row.key)),
      );
      const top = scored.slice(0, p.limit);

      const entries = new Map<string, EntryRow>();
      if (top.length > 0) {
        const { rows } = await ctx.client.query<EntryRow>(
          `SELECT key, revision, content_type, author_id, updated_at, left(value, 2000) AS value
             FROM memory_entries
            WHERE room_id = $1 AND key = ANY($2::text[]) AND NOT deleted AND NOT redacted`,
          [ctx.room_id, top.map(({ row }) => row.key)],
        );
        for (const row of rows) entries.set(row.key, row);
      }
      // Drop anything that changed between the two queries.
      const kept = top.flatMap(({ row, score }) => {
        const entry = entries.get(row.key);
        return entry && entry.revision === row.revision ? [{ entry, score }] : [];
      });
      const kinds = await loadAuthorKinds(
        ctx.client,
        ctx.room_id,
        kept.map(({ entry }) => entry.author_id),
      );
      const { rows: pending } = await ctx.client.query<{ n: string }>(
        `SELECT count(*) AS n
           FROM memory_entries m
           LEFT JOIN memory_embeddings e ON e.room_id = m.room_id AND e.key = m.key AND e.model = $2
          WHERE m.room_id = $1 AND NOT m.deleted AND NOT m.redacted
            AND m.key LIKE $3 ESCAPE '\\'
            AND (e.revision IS NULL OR e.revision <> m.revision)`,
        [ctx.room_id, provider.model, pattern],
      );
      return {
        response: {
          results: kept.map(({ entry, score }) => {
            const snippet = new RegExp(`^.{0,${SNIPPET_CODE_POINTS}}`, "su").exec(entry.value)![0];
            return {
              key: entry.key,
              revision: entry.revision,
              score: Math.round(score * 10_000) / 10_000,
              content_type: entry.content_type,
              author_id: entry.author_id,
              updated_at: entry.updated_at.toISOString(),
              snippet,
              snippet_truncated: snippet.length < entry.value.length,
              provenance: provenanceOf(kinds, entry.author_id),
            };
          }),
          model: provider.model,
          pending: Number(pending[0]?.n ?? 0),
          partial,
        },
      };
    },
  });
}
