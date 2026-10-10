import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { authorize } from "@crossover/policy";
import { CrossoverError, newId } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Dispatcher } from "../../dispatcher.js";
import type { Principal } from "../../principal.js";
import { MAX_MEMORY_VALUE_BYTES, registerMemoryCommands, type MemoryEntryView } from "./memory.js";

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

const cmd = (method: string, params: Record<string, unknown> = {}) => ({
  id: newId("cmd"),
  method,
  params,
  idempotency_key: `k-${++n}`,
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

const put = (s: Setup, who: Principal, params: Record<string, unknown>) =>
  s.d.dispatch(
    who,
    cmd("memory.put", {
      key: "architecture/database",
      value: "PostgreSQL",
      expected_revision: 0,
      ...params,
    }),
  );

const rejects = async (p: Promise<unknown>, code: string) => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CrossoverError);
  expect((err as CrossoverError).code).toBe(code);
  return err as CrossoverError;
};

const revisions = async (s: Setup, key: string) =>
  (
    await pool.query(
      "SELECT revision, value, author_id FROM memory_revisions WHERE room_id = $1 AND key = $2 ORDER BY revision",
      [s.room, key],
    )
  ).rows;

describe("memory.put", () => {
  it("expected_revision 0 creates the entry at revision 1", async () => {
    const s = await setup();
    const out = await put(s, s.dev, { source_refs: [{ kind: "task", id: "task_1" }] });
    expect(out.response).toMatchObject({
      key: "architecture/database",
      value: "PostgreSQL",
      content_type: "text/markdown",
      author_id: s.dev.participant_id,
      revision: 1,
      deleted: false,
      source_refs: [{ kind: "task", id: "task_1" }],
    });
    expect(out.events.map((e) => e.type)).toEqual(["memory.updated"]);
    expect(out.events[0]!.payload).toMatchObject({
      key: "architecture/database",
      revision: 1,
      previous_revision: 0,
      bytes: 10,
    });
    expect(out.events[0]!.payload).not.toHaveProperty("value");
  });

  it("the next revision needs the current one and increments it, keeping every revision", async () => {
    const s = await setup();
    await put(s, s.dev, {});
    const second = (await put(s, s.dev2, { value: "Postgres 16", expected_revision: 1 }))
      .response as MemoryEntryView;
    expect(second).toMatchObject({
      revision: 2,
      value: "Postgres 16",
      author_id: s.dev2.participant_id,
    });
    expect(second.created_at <= second.updated_at).toBe(true);
    expect(await revisions(s, "architecture/database")).toEqual([
      { revision: 1, value: "PostgreSQL", author_id: s.dev.participant_id },
      { revision: 2, value: "Postgres 16", author_id: s.dev2.participant_id },
    ]);
  });

  it("a stale revision is CONFLICT_VERSION carrying the current entry, and writes nothing", async () => {
    const s = await setup();
    await put(s, s.dev, {});
    await put(s, s.dev, { value: "v2", expected_revision: 1 });
    const err = await rejects(
      put(s, s.dev2, { value: "mine", expected_revision: 1 }),
      "CONFLICT_VERSION",
    );
    expect(err.details).toMatchObject({ current: { revision: 2, value: "v2" } });
    expect(await revisions(s, "architecture/database")).toHaveLength(2);
  });

  it("creating a key that exists is a conflict; updating one that doesn't is too", async () => {
    const s = await setup();
    await put(s, s.dev, {});
    const exists = await rejects(put(s, s.dev2, { expected_revision: 0 }), "CONFLICT_VERSION");
    expect(exists.details).toMatchObject({ current: { revision: 1 } });
    const missing = await rejects(
      put(s, s.dev, { key: "nothing/here", expected_revision: 3 }),
      "CONFLICT_VERSION",
    );
    expect(missing.details).toEqual({ current: null });
  });

  it("concurrent puts with the same expected revision → exactly one wins", async () => {
    const s = await setup();
    const results = await Promise.allSettled(
      [s.dev, s.dev2, s.lead, s.dev, s.dev2, s.lead].map((who, i) =>
        put(s, who, { value: `writer ${i}`, expected_revision: 0 }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((r) => r.status === "rejected")) {
      expect((r as PromiseRejectedResult).reason).toMatchObject({ code: "CONFLICT_VERSION" });
    }
    expect(await revisions(s, "architecture/database")).toHaveLength(1);

    const again = await Promise.allSettled(
      [s.dev, s.dev2, s.lead].map((who, i) =>
        put(s, who, { value: `r2-${i}`, expected_revision: 1 }),
      ),
    );
    expect(again.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await revisions(s, "architecture/database")).toHaveLength(2);
  });

  it("holds values up to 64 KiB and refuses more", async () => {
    const s = await setup();
    await put(s, s.dev, { value: "x".repeat(MAX_MEMORY_VALUE_BYTES) });
    const err = await rejects(
      put(s, s.dev, { key: "big/one", value: "x".repeat(MAX_MEMORY_VALUE_BYTES + 1) }),
      "VALIDATION",
    );
    expect(JSON.stringify(err.details)).toContain("65536");
    // Bytes, not characters: 'é' is two.
    await rejects(
      put(s, s.dev, { key: "big/two", value: "é".repeat(MAX_MEMORY_VALUE_BYTES / 2 + 1) }),
      "VALIDATION",
    );
  });

  it("application/json values must parse", async () => {
    const s = await setup();
    await put(s, s.dev, { key: "config/a", value: '{"a":1}', content_type: "application/json" });
    await rejects(
      put(s, s.dev, { key: "config/b", value: "{nope", content_type: "application/json" }),
      "VALIDATION",
    );
    await put(s, s.dev, { key: "config/c", value: "{nope", content_type: "text/markdown" });
  });

  it("keys are paths of safe segments", async () => {
    const s = await setup();
    for (const key of [
      "",
      "/a",
      "a/",
      "a//b",
      "../x",
      "a/./b",
      "a b",
      ".hidden",
      "a/b/c/d/e/f/g/h/i",
      "x".repeat(201),
    ]) {
      await rejects(put(s, s.dev, { key }), "VALIDATION");
    }
    for (const key of ["a", "architecture/database", "notes/2026-01.v2_final", "a/b/c/d/e/f/g/h"]) {
      await put(s, s.dev, { key });
    }
  });

  it("is gated by memory.write: an observer can't, and nothing is written", async () => {
    const s = await setup();
    await rejects(put(s, s.observer, {}), "FORBIDDEN");
    expect(await revisions(s, "architecture/database")).toEqual([]);
  });

  it("decisions/* belongs to the platform; agents/<id>/* to that participant", async () => {
    const s = await setup();
    const reserved = await rejects(put(s, s.lead, { key: "decisions/dec_1" }), "FORBIDDEN");
    expect(reserved.details).toMatchObject({ reason: "reserved_namespace" });
    const other = await rejects(
      put(s, s.dev, { key: `agents/${s.dev2.participant_id}/notes` }),
      "FORBIDDEN",
    );
    expect(other.details).toMatchObject({ reason: "not_namespace_owner" });
    await put(s, s.dev, { key: `agents/${s.dev.participant_id}/notes` });
    // Visible to all, writable by the owner only: the other can't update it either.
    await rejects(
      put(s, s.dev2, { key: `agents/${s.dev.participant_id}/notes`, expected_revision: 1 }),
      "FORBIDDEN",
    );
  });

  it("a replay with the same idempotency key doesn't write a second revision", async () => {
    const s = await setup();
    const env = cmd("memory.put", { key: "once", value: "x", expected_revision: 0 });
    await s.d.dispatch(s.dev, env);
    const again = await s.d.dispatch(s.dev, env);
    expect(again.replayed).toBe(true);
    expect(await revisions(s, "once")).toHaveLength(1);
  });

  it("rejects unknown parameters and a negative revision", async () => {
    const s = await setup();
    await rejects(put(s, s.dev, { extra: 1 }), "VALIDATION");
    await rejects(put(s, s.dev, { expected_revision: -1 }), "VALIDATION");
    await rejects(put(s, s.dev, { content_type: "text/plain" }), "VALIDATION");
  });
});

describe("secret scanning on memory (T902)", () => {
  const PRIVATE_KEY = [
    "-----BEGIN PRIVATE KEY-----",
    "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7",
    "-----END PRIVATE KEY-----",
  ].join("\n");
  const LOW_ENTROPY = "api_key = aB3dE5gH7jK9mN1pQ3rS5tU7vW9xY2zA";

  it("memory.put rejects a private-key block with secret_detected; the value is in no error, event, inbox or row", async () => {
    const s = await setup();
    const err = await rejects(
      put(s, s.dev, { key: "secrets/deploy", value: PRIVATE_KEY }),
      "VALIDATION",
    );
    expect(err.details).toMatchObject({ reason: "secret_detected" });
    const findings = (err.details as { findings: Array<Record<string, unknown>> }).findings;
    expect(findings[0]).toMatchObject({
      rule: "private_key_block",
      confidence: "high",
      location: { kind: "memory", key: "secrets/deploy" },
    });
    // The matched value appears nowhere: not in the error, not in any inbox
    // summary, and no memory revision was written.
    expect(JSON.stringify({ err, findings })).not.toContain(
      "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7",
    );
    const { rows: revs } = await pool.query(
      "SELECT value FROM memory_revisions WHERE room_id = $1 AND key = $2",
      [s.room, "secrets/deploy"],
    );
    expect(revs).toHaveLength(0);
    const { rows: inbox } = await pool.query("SELECT summary FROM inbox_items WHERE room_id = $1", [
      s.room,
    ]);
    for (const r of inbox)
      expect(r.summary).not.toContain("MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7");
  });

  it("memory.put flags a low-confidence match: SECRET_SCAN to author and owner, location only in the summary", async () => {
    const s = await setup();
    // The room owner must be a real participant for the inbox FK; use s.dev2
    // (not the author s.dev) so the author and owner are two distinct recipients.
    await pool.query("UPDATE rooms SET owner_id = $2 WHERE id = $1", [
      s.room,
      s.dev2.participant_id,
    ]);
    const out = await put(s, s.dev, { key: "creds/api", value: LOW_ENTROPY });
    expect((out.response as MemoryEntryView).value).toBe(LOW_ENTROPY); // flagged, not rejected
    const { rows } = await pool.query(
      `SELECT participant_id, summary FROM inbox_items
       WHERE room_id = $1 AND kind = 'SECRET_SCAN' ORDER BY participant_id`,
      [s.room],
    );
    expect(rows.map((r) => r.participant_id).sort()).toEqual(
      [s.dev.participant_id, s.dev2.participant_id].sort(),
    );
    for (const r of rows) {
      expect(r.summary).toContain("memory key creds/api");
      expect(r.summary).toContain("line 1");
      expect(r.summary).toContain("high_entropy_assignment");
      expect(r.summary).not.toContain("aB3dE5gH7jK9mN1pQ3rS5tU7vW9xY2zA");
    }
  });
});
