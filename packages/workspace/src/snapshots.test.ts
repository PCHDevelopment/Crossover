import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withTransaction } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { allowAll, Dispatcher } from "@crossover/kernel";
import { newId } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerWorkspaceCommands } from "./apply.js";
import { provisionWorkspace } from "./provision.js";
import {
  MAX_COPIED_MEMORY_BYTES,
  MAX_COPIED_MEMORY_ENTRIES,
  MAX_SNAPSHOTS_PER_ROOM,
} from "./snapshots.js";

let db: TestDatabase;
const dirs: string[] = [];

beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function setup() {
  const roomId = newId("room");
  const owner = newId("part");
  const lead = newId("part");
  const root = await mkdtemp(join(tmpdir(), "crossover-snap-"));
  dirs.push(root);
  await db.pool.query(
    "INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'Room', 'Ship', $2)",
    [roomId, owner],
  );
  await db.pool.query(
    `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status)
     VALUES ($2, $1, 'HUMAN', 'Owner', 'OWNER', 'DEVELOPER', 'ACTIVE'),
            ($3, $1, 'AGENT', 'Lead', 'MEMBER', 'LEAD', 'ACTIVE')`,
    [roomId, owner, lead],
  );
  await withTransaction(db.pool, (client) => provisionWorkspace(client, roomId, root));
  const d = new Dispatcher({ pool: db.pool, authorize: allowAll, nodeId: roomId });
  registerWorkspaceCommands(d);
  const as = (id: string, kind: "HUMAN" | "AGENT", authority: "OWNER" | "MEMBER", role: string) =>
    ({ room_id: roomId, participant_id: id, kind, authority, role }) as never;
  const ownerP = as(owner, "HUMAN", "OWNER", "DEVELOPER");
  const leadP = as(lead, "AGENT", "MEMBER", "LEAD");
  const call = (p: never, method: string, params: object) =>
    d.dispatch(p, { id: newId("cmd"), method, params, idempotency_key: newId("cmd") });
  let n = 0;
  const edit = async () => {
    const head = Number(
      (
        await db.pool.query(
          "SELECT coalesce(max(revision), 0) AS r FROM workspace_revisions WHERE room_id = $1",
          [roomId],
        )
      ).rows[0].r,
    );
    await call(leadP, "workspace.apply_changeset", {
      source: "EDITOR",
      message: "add",
      base_workspace_revision: head,
      operations: [{ type: "create", path: `f${++n}.txt`, content: `${n}\n` }],
    });
    return head + 1;
  };
  const memory = (
    key: string,
    value: string,
    author: string,
    extra: { deleted?: boolean; redacted?: boolean; revision?: number } = {},
  ) =>
    db.pool.query(
      `INSERT INTO memory_entries (room_id, key, value, content_type, author_id, revision, deleted, redacted)
       VALUES ($1, $2, $3, 'text/markdown', $4, $5, $6, $7)`,
      [
        roomId,
        key,
        value,
        author,
        extra.revision ?? 1,
        extra.deleted ?? false,
        extra.redacted ?? false,
      ],
    );
  const events = async (type: string) =>
    (
      await db.pool.query(
        "SELECT payload FROM events WHERE room_id = $1 AND type = $2 ORDER BY sequence",
        [roomId, type],
      )
    ).rows.map((r) => r.payload);
  const create = (name: string, extra: object = {}) =>
    call(leadP, "workspace.snapshot.create", { name, ...extra });
  return { roomId, owner, lead, ownerP, leadP, call, edit, memory, events, create };
}

const reason = async (promise: Promise<unknown>) => {
  const error = (await promise.catch((e: unknown) => e)) as {
    code?: string;
    details?: { reason?: string };
  };
  return `${error.code}:${error.details?.reason ?? ""}`;
};

describe("workspace.snapshot.* (T1603)", () => {
  it("create marks the head and copies live memory", async () => {
    const s = await setup();
    await s.edit();
    await s.edit();
    await s.memory("notes/a", "alpha", s.lead);
    await s.memory("decisions/d1", "decided", "system");
    await s.memory("notes/gone", "deleted", s.lead, { deleted: true });
    await s.memory(`agents/${s.lead}/x`, "private", s.lead);
    const made = await s.create("first", { description: "before the refactor" });
    expect(made.response).toMatchObject({
      name: "first",
      description: "before the refactor",
      revision: 2,
      created_by: s.lead,
      memory_entries: 2,
      memory_bytes: "alpha".length + "decided".length,
      provenance: { author_id: s.lead, author_kind: "AGENT" },
    });
    const copied = await db.pool.query(
      "SELECT key FROM workspace_snapshot_memory WHERE room_id = $1 ORDER BY key",
      [s.roomId],
    );
    expect(copied.rows.map((r) => r.key)).toEqual(["decisions/d1", "notes/a"]);
    const [event] = await s.events("workspace.snapshot.created");
    expect(event).toEqual({
      snapshot_id: (made.response as { id: string }).id,
      name: "first",
      revision: 2,
      memory_entries: 2,
      memory_bytes: 12,
      created_by: s.lead,
    });
  });

  it("create at an older revision records that revision and copies today's memory", async () => {
    const s = await setup();
    await s.edit();
    await s.edit();
    await s.edit();
    await s.memory("notes/now", "today", s.lead);
    const made = await s.create("old", { revision: 1 });
    expect(made.response).toMatchObject({ revision: 1, memory_entries: 1 });
    const got = await s.call(s.ownerP, "workspace.snapshot.get", {
      snapshot_id: (made.response as { id: string }).id,
    });
    expect(
      (got.response as { memory: { entries: { value: string }[] } }).memory.entries,
    ).toMatchObject([{ value: "today" }]);
  });

  it("a redacted memory entry is not copied", async () => {
    const s = await setup();
    await s.edit();
    await s.memory("notes/ok", "fine", s.lead);
    await s.memory("notes/secret", "", s.lead, { redacted: true });
    const made = await s.create("r");
    expect(made.response).toMatchObject({ memory_entries: 1 });
    const keys = await db.pool.query(
      "SELECT key FROM workspace_snapshot_memory WHERE room_id = $1",
      [s.roomId],
    );
    expect(keys.rows.map((r) => r.key)).toEqual(["notes/ok"]);
  });

  it("empty workspace, unknown revision, duplicate name and the 51st snapshot are refused with their reasons", async () => {
    const s = await setup();
    expect(await reason(s.create("none"))).toBe("VALIDATION:empty_workspace");
    await s.edit();
    expect(await reason(s.create("x", { revision: 99 }))).toBe("VALIDATION:unknown_revision");
    await s.create("dup");
    expect(await reason(s.create("dup"))).toBe("VALIDATION:name_taken");
    await db.pool.query(
      `INSERT INTO workspace_snapshots (id, room_id, workspace_id, revision, name, created_by, memory_entries, memory_bytes)
       SELECT 'snap_fill' || g, $1, w.id, 1, 'fill ' || g, $2, 0, 0
         FROM generate_series(1, $3::int - 1) g, workspaces w WHERE w.room_id = $1`,
      [s.roomId, s.lead, MAX_SNAPSHOTS_PER_ROOM],
    );
    expect(await reason(s.create("one too many"))).toBe("VALIDATION:too_many_snapshots");
  });

  it("copy over 2,000 entries is snapshot_memory_too_large", async () => {
    const s = await setup();
    await s.edit();
    await db.pool.query(
      `INSERT INTO memory_entries (room_id, key, value, content_type, author_id, revision)
       SELECT $1, 'bulk/' || g, 'v', 'text/markdown', $2, 1 FROM generate_series(1, $3::int) g`,
      [s.roomId, s.lead, MAX_COPIED_MEMORY_ENTRIES + 1],
    );
    const error = (await s.create("big").catch((e: unknown) => e)) as {
      details: Record<string, unknown>;
    };
    expect(error.details).toMatchObject({
      reason: "snapshot_memory_too_large",
      entries: MAX_COPIED_MEMORY_ENTRIES + 1,
      limit_entries: MAX_COPIED_MEMORY_ENTRIES,
    });
  });

  it("copy over 16 MiB is snapshot_memory_too_large, decided in SQL before any value is read", async () => {
    const s = await setup();
    await s.edit();
    await db.pool.query(
      `INSERT INTO memory_entries (room_id, key, value, content_type, author_id, revision)
       SELECT $1, 'big/' || g, repeat('x', 65536), 'text/markdown', $2, 1 FROM generate_series(1, 260) g`,
      [s.roomId, s.lead],
    );
    const error = (await s.create("heavy").catch((e: unknown) => e)) as {
      details: Record<string, unknown>;
    };
    expect(error.details).toMatchObject({
      reason: "snapshot_memory_too_large",
      entries: 260,
      bytes: 260 * 65536,
      limit_bytes: MAX_COPIED_MEMORY_BYTES,
    });
    expect(
      (await db.pool.query("SELECT 1 FROM workspace_snapshots WHERE room_id = $1", [s.roomId]))
        .rowCount,
    ).toBe(0);
  });

  it("list pages oldest first; unknown cursor is NOT_FOUND; another room's snapshots are not listed", async () => {
    const s = await setup();
    const other = await setup();
    await s.edit();
    await other.edit();
    for (const name of ["a", "b", "c"]) await s.create(name);
    await other.create("elsewhere");
    const first = (await s.call(s.ownerP, "workspace.snapshot.list", { limit: 2 })).response as {
      snapshots: { id: string; name: string }[];
      has_more: boolean;
    };
    expect(first.snapshots.map((x) => x.name)).toEqual(["a", "b"]);
    expect(first.has_more).toBe(true);
    const rest = (
      await s.call(s.ownerP, "workspace.snapshot.list", { limit: 2, after: first.snapshots[1]!.id })
    ).response as { snapshots: { name: string }[]; has_more: boolean };
    expect(rest.snapshots.map((x) => x.name)).toEqual(["c"]);
    expect(rest.has_more).toBe(false);
    expect(await reason(s.call(s.ownerP, "workspace.snapshot.list", { after: "snap_nope" }))).toBe(
      "NOT_FOUND:",
    );
    const foreign = (await other.call(other.ownerP, "workspace.snapshot.list", {})).response as {
      snapshots: { id: string }[];
    };
    expect(
      await reason(
        s.call(s.ownerP, "workspace.snapshot.get", { snapshot_id: foreign.snapshots[0]!.id }),
      ),
    ).toBe("NOT_FOUND:");
  });

  it("get pages memory by key and labels provenance; system for decisions/*", async () => {
    const s = await setup();
    await s.edit();
    await s.memory("decisions/d1", "decided", "system");
    await s.memory("notes/a", "alpha", s.lead);
    await s.memory("notes/b", "beta", s.owner);
    const id = ((await s.create("m")).response as { id: string }).id;
    type Got = {
      snapshot: { name: string };
      memory: {
        entries: { key: string; provenance: { author_kind: string; trust: string } }[];
        has_more: boolean;
      };
    };
    const first = (
      await s.call(s.ownerP, "workspace.snapshot.get", { snapshot_id: id, memory_limit: 2 })
    ).response as Got;
    expect(first.memory.entries.map((e) => e.key)).toEqual(["decisions/d1", "notes/a"]);
    expect(first.memory.has_more).toBe(true);
    expect(first.memory.entries[0]!.provenance).toMatchObject({
      author_kind: "SYSTEM",
      trust: "system",
    });
    expect(first.memory.entries[1]!.provenance).toMatchObject({
      author_kind: "AGENT",
      trust: "participant",
    });
    const rest = (
      await s.call(s.ownerP, "workspace.snapshot.get", {
        snapshot_id: id,
        memory_after: "notes/a",
        memory_limit: 2,
      })
    ).response as Got;
    expect(rest.memory.entries.map((e) => e.key)).toEqual(["notes/b"]);
    expect(rest.memory.entries[0]!.provenance).toMatchObject({ author_kind: "HUMAN" });
    expect(rest.memory.has_more).toBe(false);
    expect(rest.snapshot.name).toBe("m");
  });

  it("delete removes the snapshot and its memory and emits workspace.snapshot.deleted", async () => {
    const s = await setup();
    await s.edit();
    await s.memory("notes/a", "alpha", s.lead);
    const id = ((await s.create("gone")).response as { id: string }).id;
    await s.call(s.ownerP, "workspace.snapshot.delete", { snapshot_id: id });
    for (const table of ["workspace_snapshots", "workspace_snapshot_memory"])
      expect(
        (await db.pool.query(`SELECT 1 FROM ${table} WHERE room_id = $1`, [s.roomId])).rowCount,
      ).toBe(0);
    expect(await s.events("workspace.snapshot.deleted")).toEqual([
      { snapshot_id: id, name: "gone" },
    ]);
    expect(await reason(s.call(s.ownerP, "workspace.snapshot.delete", { snapshot_id: id }))).toBe(
      "NOT_FOUND:",
    );
  });
});
