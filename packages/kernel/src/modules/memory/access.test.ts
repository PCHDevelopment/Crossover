import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { authorize } from "@crossover/policy";
import { CrossoverError, newId } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Dispatcher } from "../../dispatcher.js";
import type { Principal } from "../../principal.js";
import { registerMemoryAccessCommands } from "./access.js";
import { registerMemoryCommands, type MemoryEntryView } from "./memory.js";

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

/** `undefined` means "leave it out": the dispatcher takes plain JSON only. */
const clean = (params: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined));
const cmd = (method: string, params: Record<string, unknown> = {}) => ({
  id: newId("cmd"),
  method,
  params: clean(params),
  idempotency_key: `k-${++n}`,
});
const read = (method: string, params: Record<string, unknown> = {}) => ({
  id: newId("cmd"),
  method,
  params: clean(params),
});

async function add(room: string, role: string) {
  const id = newId("part");
  await pool.query(
    `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status)
     VALUES ($1, $2, 'AGENT', $1, 'MEMBER', $3, 'ACTIVE')`,
    [id, room, role],
  );
  return {
    participant_id: id,
    room_id: room,
    kind: "AGENT",
    authority: "MEMBER",
    role,
  } as Principal;
}

async function setup() {
  const d = new Dispatcher({ pool, authorize, nodeId: `node-${++n}` });
  registerMemoryCommands(d);
  registerMemoryAccessCommands(d);
  const room = newId("room");
  await pool.query(
    `INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'n', 'o', 'x')`,
    [room],
  );
  return {
    d,
    room,
    lead: await add(room, "LEAD"),
    dev: await add(room, "DEVELOPER"),
    dev2: await add(room, "DEVELOPER"),
    observer: await add(room, "OBSERVER"),
  };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const put = (s: Setup, who: Principal, key: string, value: string, expected = 0) =>
  s.d.dispatch(who, cmd("memory.put", { key, value, expected_revision: expected }));
const get = async (s: Setup, who: Principal, key: string) =>
  (await s.d.dispatch(who, read("memory.get", { key }))).response as MemoryEntryView;
const del = (s: Setup, who: Principal, key: string, expected: number) =>
  s.d.dispatch(who, cmd("memory.delete", { key, expected_revision: expected }));
const list = async (s: Setup, who: Principal, params: Record<string, unknown> = {}) =>
  (await s.d.dispatch(who, read("memory.list", params))).response as {
    entries: (Omit<MemoryEntryView, "value"> & { bytes: number })[];
    next_after: string | null;
  };
const history = async (
  s: Setup,
  who: Principal,
  key: string,
  params: Record<string, unknown> = {},
) =>
  (await s.d.dispatch(who, read("memory.history", { key, ...params }))).response as {
    revisions: { revision: number; value: string; deleted: boolean; author_id: string }[];
    next_after: number | null;
  };

const rejects = async (p: Promise<unknown>, code: string) => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CrossoverError);
  expect((err as CrossoverError).code).toBe(code);
  return err as CrossoverError;
};

describe("memory.get", () => {
  it("returns the entry with its value; observers can read; unknown keys are NOT_FOUND", async () => {
    const s = await setup();
    await put(s, s.dev, "architecture/database", "PostgreSQL");
    expect(await get(s, s.observer, "architecture/database")).toMatchObject({
      key: "architecture/database",
      value: "PostgreSQL",
      revision: 1,
      deleted: false,
    });
    await rejects(s.d.dispatch(s.dev, read("memory.get", { key: "nope" })), "NOT_FOUND");
  });

  it("is room-scoped", async () => {
    const s = await setup();
    const other = await setup();
    await put(other, other.dev, "secret/key", "other room");
    await rejects(s.d.dispatch(s.dev, read("memory.get", { key: "secret/key" })), "NOT_FOUND");
  });

  it("a deleted key is NOT_FOUND carrying the tombstone's revision", async () => {
    const s = await setup();
    await put(s, s.dev, "k", "v");
    await del(s, s.dev, "k", 1);
    const err = await rejects(s.d.dispatch(s.dev, read("memory.get", { key: "k" })), "NOT_FOUND");
    expect(err.details).toEqual({ deleted: true, revision: 2 });
  });
});

describe("memory.list", () => {
  it("lists keys in order under a prefix, without values", async () => {
    const s = await setup();
    for (const key of ["b/two", "a/one", "a/three", "ab/x", "c"])
      await put(s, s.dev, key, `v-${key}`);
    const all = await list(s, s.observer);
    expect(all.entries.map((e) => e.key)).toEqual(["a/one", "a/three", "ab/x", "b/two", "c"]);
    expect(all.entries[0]).not.toHaveProperty("value");
    expect(all.entries[0]).toMatchObject({
      bytes: 7,
      revision: 1,
      author_id: s.dev.participant_id,
    });
    expect((await list(s, s.dev, { prefix: "a/" })).entries.map((e) => e.key)).toEqual([
      "a/one",
      "a/three",
    ]);
    expect((await list(s, s.dev, { prefix: "a" })).entries.map((e) => e.key)).toEqual([
      "a/one",
      "a/three",
      "ab/x",
    ]);
    expect((await list(s, s.dev, { prefix: "zzz" })).entries).toEqual([]);
  });

  it("treats % and _ in a prefix literally", async () => {
    const s = await setup();
    await put(s, s.dev, "a_b/x", "1");
    await put(s, s.dev, "aXb/x", "2");
    expect((await list(s, s.dev, { prefix: "a_b" })).entries.map((e) => e.key)).toEqual(["a_b/x"]);
    expect((await list(s, s.dev, { prefix: "%" })).entries).toEqual([]);
  });

  it("hides tombstones unless asked, and pages every key exactly once", async () => {
    const s = await setup();
    const keys = ["k1", "k2", "k3", "k4", "k5"];
    for (const k of keys) await put(s, s.dev, k, "v");
    await del(s, s.dev, "k3", 1);
    expect((await list(s, s.dev)).entries.map((e) => e.key)).toEqual(["k1", "k2", "k4", "k5"]);
    const withDeleted = await list(s, s.dev, { include_deleted: true });
    expect(withDeleted.entries.map((e) => [e.key, e.deleted])).toContainEqual(["k3", true]);

    const seen: string[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await list(s, s.dev, {
        limit: 2,
        include_deleted: true,
        ...(after ? { after } : {}),
      });
      seen.push(...page.entries.map((e) => e.key));
      if (!page.next_after) break;
      after = page.next_after;
    }
    expect(seen).toEqual(keys);
  });

  it("is room-scoped, and rejects a bad limit", async () => {
    const s = await setup();
    const other = await setup();
    await put(other, other.dev, "theirs", "v");
    expect((await list(s, s.dev)).entries).toEqual([]);
    await rejects(s.d.dispatch(s.dev, read("memory.list", { limit: 0 })), "VALIDATION");
    await rejects(s.d.dispatch(s.dev, read("memory.list", { limit: 101 })), "VALIDATION");
  });
});

describe("memory.delete", () => {
  it("writes a tombstone: revision moves on, value cleared, event emitted", async () => {
    const s = await setup();
    await put(s, s.dev, "k", "secret value");
    const out = await del(s, s.dev2, "k", 1);
    expect(out.response).toMatchObject({
      key: "k",
      revision: 2,
      deleted: true,
      value: "",
      author_id: s.dev2.participant_id,
    });
    expect(out.events.map((e) => e.type)).toEqual(["memory.deleted"]);
    expect(out.events[0]!.payload).toMatchObject({ key: "k", revision: 2, previous_revision: 1 });
  });

  it("history returns every revision including the tombstone", async () => {
    const s = await setup();
    await put(s, s.dev, "k", "one");
    await put(s, s.dev2, "k", "two", 1);
    await del(s, s.dev, "k", 2);
    const h = await history(s, s.observer, "k");
    expect(h.revisions.map((r) => [r.revision, r.value, r.deleted])).toEqual([
      [1, "one", false],
      [2, "two", false],
      [3, "", true],
    ]);
    expect(h.next_after).toBeNull();
  });

  it("a stale revision is CONFLICT_VERSION with the current entry; nothing is deleted", async () => {
    const s = await setup();
    await put(s, s.dev, "k", "one");
    await put(s, s.dev, "k", "two", 1);
    const err = await rejects(del(s, s.dev, "k", 1), "CONFLICT_VERSION");
    expect(err.details).toMatchObject({ current: { revision: 2, value: "two", deleted: false } });
    expect((await get(s, s.dev, "k")).value).toBe("two");
  });

  it("unknown key → NOT_FOUND; already deleted → VALIDATION", async () => {
    const s = await setup();
    await rejects(del(s, s.dev, "nope", 1), "NOT_FOUND");
    await put(s, s.dev, "k", "v");
    await del(s, s.dev, "k", 1);
    const err = await rejects(del(s, s.dev, "k", 2), "VALIDATION");
    expect(err.details).toMatchObject({ revision: 2 });
  });

  it("a deleted key can be brought back with a put at the tombstone's revision", async () => {
    const s = await setup();
    await put(s, s.dev, "k", "v1");
    await del(s, s.dev, "k", 1);
    await rejects(put(s, s.dev, "k", "again", 0), "CONFLICT_VERSION");
    await rejects(put(s, s.dev, "k", "again", 1), "CONFLICT_VERSION");
    const revived = await put(s, s.dev, "k", "again", 2);
    expect(revived.response).toMatchObject({ revision: 3, deleted: false, value: "again" });
    expect((await get(s, s.dev, "k")).value).toBe("again");
    expect((await history(s, s.dev, "k")).revisions.map((r) => r.revision)).toEqual([1, 2, 3]);
  });

  it("racing deletes: exactly one wins", async () => {
    const s = await setup();
    await put(s, s.dev, "k", "v");
    const results = await Promise.allSettled([s.dev, s.dev2, s.lead].map((w) => del(s, w, "k", 1)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(lost).toHaveLength(2);
  });

  it("namespaces: other participants' agents/<id>/* and decisions/* are FORBIDDEN, your own is fine", async () => {
    const s = await setup();
    const mine = `agents/${s.dev.participant_id}/notes`;
    await put(s, s.dev, mine, "v");
    const err = await rejects(del(s, s.dev2, mine, 1), "FORBIDDEN");
    expect(err.details).toMatchObject({ reason: "not_namespace_owner" });
    await del(s, s.dev, mine, 1);
    // A platform-written decisions/ entry can't be deleted by participants either.
    await pool.query(
      `INSERT INTO memory_entries (room_id, key, value, content_type, author_id, revision)
       VALUES ($1, 'decisions/dec_1', 'x', 'text/markdown', 'system', 1)`,
      [s.room],
    );
    const reserved = await rejects(del(s, s.lead, "decisions/dec_1", 1), "FORBIDDEN");
    expect(reserved.details).toMatchObject({ reason: "reserved_namespace" });
  });

  it("an observer can't delete, and nothing changes", async () => {
    const s = await setup();
    await put(s, s.dev, "k", "v");
    await rejects(del(s, s.observer, "k", 1), "FORBIDDEN");
    expect((await get(s, s.dev, "k")).deleted).toBe(false);
  });

  it("a replay with the same idempotency key doesn't write a second tombstone", async () => {
    const s = await setup();
    await put(s, s.dev, "k", "v");
    const env = cmd("memory.delete", { key: "k", expected_revision: 1 });
    await s.d.dispatch(s.dev, env);
    const again = await s.d.dispatch(s.dev, env);
    expect(again.replayed).toBe(true);
    expect((await history(s, s.dev, "k")).revisions).toHaveLength(2);
  });
});

describe("memory.history", () => {
  it("pages revisions oldest first, each exactly once; unknown key → NOT_FOUND", async () => {
    const s = await setup();
    await put(s, s.dev, "k", "v1");
    for (let i = 1; i < 5; i++) await put(s, s.dev, "k", `v${i + 1}`, i);
    const seen: number[] = [];
    let after = 0;
    for (;;) {
      const page = await history(s, s.dev, "k", { limit: 2, after_revision: after });
      seen.push(...page.revisions.map((r) => r.revision));
      if (!page.next_after) break;
      after = page.next_after;
    }
    expect(seen).toEqual([1, 2, 3, 4, 5]);
    await rejects(s.d.dispatch(s.dev, read("memory.history", { key: "nope" })), "NOT_FOUND");
  });

  it("is room-scoped", async () => {
    const s = await setup();
    const other = await setup();
    await put(other, other.dev, "theirs", "v");
    await rejects(s.d.dispatch(s.dev, read("memory.history", { key: "theirs" })), "NOT_FOUND");
  });
});
