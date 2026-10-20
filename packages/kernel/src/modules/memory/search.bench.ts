import { performance } from "node:perf_hooks";
import { cpus } from "node:os";
import { writeFile } from "node:fs/promises";
import { withTransaction } from "@crossover/db";
import { createTestDatabase } from "@crossover/db/testing";
import { newId } from "@crossover/protocol";
import { expect, it } from "vitest";
import { allowAll, Dispatcher } from "../../dispatcher.js";
import { MemoryEmbeddingIndexer } from "./embedding-index.js";
import { HashEmbeddingProvider } from "./embeddings.js";
import { putMemory } from "./memory.js";
import { registerMemorySearchCommand } from "./search.js";

const ENTRIES = Number(process.env["BENCH_MEMORY_ENTRIES"] ?? 5_000);
const RUNS = Number(process.env["BENCH_RUNS"] ?? 20);

/** Seeded PRNG (mulberry32), so every run writes the same entries. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Nearest rank, as in workspace.bench.ts. */
function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]!.toFixed(3));
}

it("measures memory.search and the embedding index on 5,000 entries", async () => {
  const db = await createTestDatabase();
  try {
    const random = prng(1583);
    const words = Array.from({ length: 2_000 }, () => {
      let word = "";
      for (let i = 4 + Math.floor(random() * 8); i > 0; i--)
        word += String.fromCharCode(97 + Math.floor(random() * 26));
      return word;
    });
    const text = (min: number, max: number): string => {
      const target = min + Math.floor(random() * (max - min));
      let value = "# Note\n\n";
      while (value.length < target)
        value += `${words[Math.floor(random() * words.length)]!}${random() < 0.1 ? "\n\n" : " "}`;
      return value.slice(0, target);
    };

    const room = newId("room");
    await db.pool.query(
      "INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'Bench', 'Memory', 'actor')",
      [room],
    );
    const author = newId("part");
    await db.pool.query(
      `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status)
       VALUES ($1, $2, 'HUMAN', 'Bench', 'OWNER', 'LEAD', 'ACTIVE')`,
      [author, room],
    );
    for (let start = 0; start < ENTRIES; start += 500) {
      await withTransaction(db.pool, async (client) => {
        for (let index = start; index < Math.min(ENTRIES, start + 500); index++)
          await putMemory(client, room, author, {
            key: `topic${Math.floor(index / 100)}/note${index % 100}`,
            value: text(200, 2_000),
            content_type: "text/markdown",
            expected_revision: 0,
            source_refs: [],
          });
      });
    }

    const provider = new HashEmbeddingProvider();
    const indexer = new MemoryEmbeddingIndexer({ pool: db.pool, provider, onError: () => {} });
    const synced = performance.now();
    const result = await indexer.syncRoom(room, new AbortController().signal);
    const embed_all_ms = performance.now() - synced;
    expect(result.embedded).toBe(ENTRIES);

    const dispatcher = new Dispatcher({ pool: db.pool, authorize: allowAll, nodeId: room });
    registerMemorySearchCommand(dispatcher, { provider });
    const principal = {
      room_id: room,
      participant_id: author,
      kind: "HUMAN" as const,
      authority: "OWNER" as const,
      role: "LEAD" as const,
    };
    const samples: number[] = [];
    for (let query = 0; query < 30; query++) {
      const params = {
        query: [0, 1, 2, 3].map(() => words[Math.floor(random() * words.length)]!).join(" "),
        limit: 10,
        // Half of the queries are scoped to one topic.
        ...(query % 2 === 0 ? {} : { prefix: `topic${Math.floor(random() * (ENTRIES / 100))}/` }),
      };
      for (let run = 0; run < RUNS; run++) {
        const started = performance.now();
        const answer = await dispatcher.dispatch(principal, {
          id: newId("cmd"),
          method: "memory.search",
          params,
        });
        samples.push(performance.now() - started);
        expect((answer.response as { results: unknown[] }).results.length).toBeGreaterThan(0);
      }
    }

    const report = {
      node: process.version,
      platform: process.platform,
      cpu: cpus()[0]?.model,
      entries: ENTRIES,
      dimensions: provider.dimensions,
      runs: RUNS,
      embed_all_ms: Math.round(embed_all_ms),
      search: {
        p50: percentile(samples, 0.5),
        p95: percentile(samples, 0.95),
        max: percentile(samples, 1),
      },
      targets: {
        search_p95_ms: 250,
        sync_ms: 60_000,
        search_p95_met: percentile(samples, 0.95) <= 250,
        sync_met: embed_all_ms <= 60_000,
      },
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (process.env["BENCH_OUTPUT_MEMORY"])
      await writeFile(process.env["BENCH_OUTPUT_MEMORY"], JSON.stringify(report, null, 2));
  } finally {
    await db.drop();
  }
});
