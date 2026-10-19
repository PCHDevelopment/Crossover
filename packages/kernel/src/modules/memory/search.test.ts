import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { authorize } from "@crossover/policy";
import { CrossoverError, newId } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Dispatcher, type Authorizer } from "../../dispatcher.js";
import type { Principal } from "../../principal.js";
import { registerEventsRedactCommand } from "../rooms/redact-event.js";
import { registerMemoryAccessCommands } from "./access.js";
import { MemoryEmbeddingIndexer } from "./embedding-index.js";
import { HashEmbeddingProvider, type EmbeddingProvider } from "./embeddings.js";
import { registerMemoryCommands } from "./memory.js";
import { registerMemorySearchCommand } from "./search.js";

let db: TestDatabase;
let pool: Pool;
let n = 0;

beforeAll(async () => {
  db = await createTestDatabase();
  pool = db.pool;
});
afterAll(async () => {
  await db.drop();
});

/** A provider that counts the calls it gets and can be made to fail. */
class StubProvider extends HashEmbeddingProvider implements EmbeddingProvider {
  calls = 0;
  failWith: Error | undefined;
  override async embed(texts: string[], signal: AbortSignal): Promise<Float32Array[]> {
    this.calls++;
    if (this.failWith) throw this.failWith;
    return super.embed(texts, signal);
  }
}

async function add(room: string, role: string, authority: "MEMBER" | "OWNER" = "MEMBER") {
  const id = newId("part");
  // Only a human can be the owner (D8).
  const kind = authority === "OWNER" ? "HUMAN" : "AGENT";
  await pool.query(
    `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status)
     VALUES ($1, $2, $5, $1, $4, $3, 'ACTIVE')`,
    [id, room, role, authority, kind],
  );
  return { participant_id: id, room_id: room, kind, authority, role } as Principal;
}

async function setup(
  options: {
    provider?: StubProvider | null;
    authorizer?: Authorizer;
    maxScan?: number;
  } = {},
) {
  const provider = options.provider === null ? undefined : (options.provider ?? new StubProvider());
  const d = new Dispatcher({
    pool,
    authorize: options.authorizer ?? authorize,
    nodeId: `node-${++n}`,
  });
  registerMemoryCommands(d);
  registerMemoryAccessCommands(d);
  registerEventsRedactCommand(d);
  registerMemorySearchCommand(d, {
    ...(provider ? { provider } : {}),
    ...(options.maxScan === undefined ? {} : { maxScan: options.maxScan }),
  });
  const room = newId("room");
  await pool.query(
    "INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'n', 'o', 'x')",
    [room],
  );
  const indexer = new MemoryEmbeddingIndexer({
    pool,
    provider: provider ?? new HashEmbeddingProvider(),
    onError: () => {},
  });
  return {
    d,
    room,
    provider,
    indexer,
    dev: await add(room, "DEVELOPER"),
    observer: await add(room, "OBSERVER"),
    owner: await add(room, "DEVELOPER", "OWNER"),
  };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const request = (method: string, params: Record<string, unknown>, mutating = false) => ({
  id: newId("cmd"),
  method,
  params,
  ...(mutating ? { idempotency_key: `k-${++n}` } : {}),
});
const put = (s: Setup, key: string, value: string, expected = 0) =>
  s.d.dispatch(s.dev, request("memory.put", { key, value, expected_revision: expected }, true));
const sync = (s: Setup) => s.indexer.syncRoom(s.room, new AbortController().signal);

interface Result {
  key: string;
  revision: number;
  score: number;
  snippet: string;
  snippet_truncated: boolean;
  provenance: { author_kind: string };
}
interface SearchResponse {
  results: Result[];
  model: string;
  pending: number;
  partial: boolean;
}
const search = async (s: Setup, params: Record<string, unknown>, who: Principal = s.dev) =>
  (
    await s.d.dispatch(
      who,
      request("memory.search", { query: "postgres database security", ...params }),
    )
  ).response as SearchResponse;

const reason = async (promise: Promise<unknown>) => {
  const error = (await promise.catch((e: unknown) => e)) as CrossoverError;
  return {
    code: error.code,
    reason: (error.details as { reason?: string } | undefined)?.reason,
    error,
  };
};

describe("memory.search (T1580)", () => {
  it("ranks related entries first", async () => {
    const s = await setup();
    await put(s, "ui/colors", "Primary button colour is teal");
    await put(s, "architecture/database", "We use PostgreSQL 16 with row-level security");
    await sync(s);
    const found = await search(s, {});
    expect(found.results.map((r) => r.key)).toEqual(["architecture/database", "ui/colors"]);
    const scores = found.results.map((r) => r.score);
    expect(scores[0]!).toBeGreaterThan(scores[1]!);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    expect(found).toMatchObject({ model: "local-hash-v1", pending: 0, partial: false });
    expect(found.results[0]).toMatchObject({
      revision: 1,
      snippet: "We use PostgreSQL 16 with row-level security",
      snippet_truncated: false,
      provenance: { author_kind: "AGENT" },
    });
  });

  it("truncates a long snippet to 300 code points", async () => {
    const s = await setup();
    await put(s, "notes/long", `database ${"é".repeat(400)}`);
    await sync(s);
    const [first] = (await search(s, {})).results;
    expect([...first!.snippet]).toHaveLength(300);
    expect(first!.snippet_truncated).toBe(true);
  });

  it("applies prefix literally and limit", async () => {
    const s = await setup();
    await put(s, "a_b/x", "postgres database one");
    await put(s, "aXb/x", "postgres database two");
    await put(s, "a_b/y", "postgres database three");
    await sync(s);
    expect((await search(s, { prefix: "a_b" })).results.map((r) => r.key).sort()).toEqual([
      "a_b/x",
      "a_b/y",
    ]);
    expect((await search(s, { prefix: "%" })).results).toEqual([]);
    expect((await search(s, { limit: 1 })).results).toHaveLength(1);
  });

  it("never returns deleted, redacted or changed entries", async () => {
    const s = await setup();
    await put(s, "notes/gone", "postgres database to delete");
    await put(s, "notes/secret", "postgres database sk-leaked-value");
    await put(s, "notes/stale", "postgres database old text");
    await put(s, "notes/ok", "postgres database fine");
    await put(s, "notes/hidden", "postgres database hidden text");
    await sync(s);
    // Redaction normally drops the vector too; flag one entry redacted while its vector is still
    // in the index (a missed cleanup), which only the search's own check against the row catches.
    await pool.query(
      "UPDATE memory_entries SET value = '', redacted = true WHERE room_id = $1 AND key = 'notes/hidden'",
      [s.room],
    );
    await s.d.dispatch(
      s.dev,
      request("memory.delete", { key: "notes/gone", expected_revision: 1 }, true),
    );
    const events = await pool.query<{ sequence: string; payload: { key?: string } }>(
      "SELECT sequence, payload FROM events WHERE room_id = $1 AND type = 'memory.updated' ORDER BY sequence",
      [s.room],
    );
    const secret = events.rows.find((e) => e.payload.key === "notes/secret")!;
    await s.d.dispatch(
      s.owner,
      request("events.redact", { sequence: Number(secret.sequence), reason: "key" }, true),
    );
    await put(s, "notes/stale", "postgres database NEW text", 1); // not synced
    const found = await search(s, {});
    expect(found.results.map((r) => r.key)).toEqual(["notes/ok"]);
    expect(JSON.stringify(found)).not.toContain("sk-leaked-value");
    expect(found.pending).toBe(1);
  });

  it("an observer can search; a denied memory.read is FORBIDDEN and never reaches the provider", async () => {
    const s = await setup();
    await put(s, "architecture/database", "PostgreSQL row-level security");
    await sync(s);
    expect((await search(s, {}, s.observer)).results).toHaveLength(1);

    const denying: Authorizer = async (_principal, action) => {
      if (action === "memory.read") throw new CrossoverError("FORBIDDEN", "no memory.read");
    };
    const blocked = await setup({ authorizer: denying });
    const result = await reason(
      blocked.d.dispatch(blocked.dev, request("memory.search", { query: "database" })),
    );
    expect(result.code).toBe("FORBIDDEN");
    expect(blocked.provider!.calls).toBe(0);
  });

  it("is room-scoped", async () => {
    const a = await setup();
    const b = await setup();
    await put(b, "secret/key", "postgres database in another room");
    await sync(b);
    await put(a, "mine/key", "postgres database here");
    await sync(a);
    expect((await search(a, {})).results.map((r) => r.key)).toEqual(["mine/key"]);
  });

  it("disabled server answers memory_search_disabled", async () => {
    const s = await setup({ provider: null });
    const result = await reason(s.d.dispatch(s.dev, request("memory.search", { query: "x" })));
    expect(result).toMatchObject({ code: "VALIDATION", reason: "memory_search_disabled" });
  });

  it("provider failure is UNAVAILABLE without leaking the error text", async () => {
    const s = await setup();
    await put(s, "k/v", "postgres database");
    await sync(s);
    s.provider!.failWith = new Error("key sk-test-123");
    const result = await reason(
      s.d.dispatch(s.dev, request("memory.search", { query: "database" })),
    );
    expect(result).toMatchObject({ code: "UNAVAILABLE", reason: "embedding_provider_unavailable" });
    expect(
      JSON.stringify({ message: result.error.message, details: result.error.details }),
    ).not.toContain("sk-test");
  });

  it("partial is set past MEMORY_SEARCH_MAX_SCAN", async () => {
    const s = await setup({ maxScan: 3 });
    for (const key of ["k/1", "k/2", "k/3", "k/4"]) await put(s, key, "postgres database");
    await sync(s);
    const found = await search(s, { limit: 50 });
    expect(found.partial).toBe(true);
    expect(found.results).toHaveLength(3);
    const exact = await setup({ maxScan: 4 });
    for (const key of ["k/1", "k/2", "k/3", "k/4"]) await put(exact, key, "postgres database");
    await sync(exact);
    expect((await search(exact, { limit: 50 })).partial).toBe(false);
  });
});
