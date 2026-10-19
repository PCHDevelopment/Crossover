import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withTransaction } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { allowAll, Dispatcher } from "@crossover/kernel";
import { newId } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerWorkspaceCommands } from "./apply.js";
import { conflictRateReport, extensionOf } from "./conflict-metrics.js";
import type { Operation } from "./operations.js";
import { provisionWorkspace } from "./provision.js";

let db: TestDatabase;
const dirs: string[] = [];

beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A room with a human `human` and an agent `agent`, applying real ChangeSets. */
async function room() {
  const roomId = newId("room");
  const human = newId("part");
  const agent = newId("part");
  const root = await mkdtemp(join(tmpdir(), "crossover-conflict-metrics-"));
  dirs.push(root);
  await db.pool.query(
    "INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'Room', 'Ship', $2)",
    [roomId, human],
  );
  for (const [id, kind] of [
    [human, "HUMAN"],
    [agent, "AGENT"],
  ] as const)
    await db.pool.query(
      `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status)
       VALUES ($2, $1, $3, 'P', 'MEMBER', 'DEVELOPER', 'ACTIVE')`,
      [roomId, id, kind],
    );
  await withTransaction(db.pool, (client) => provisionWorkspace(client, roomId, root));
  const dispatcher = new Dispatcher({ pool: db.pool, authorize: allowAll, nodeId: roomId });
  registerWorkspaceCommands(dispatcher);
  const as =
    (participantId: string, kind: "HUMAN" | "AGENT") => (operations: Operation[], base: number) =>
      dispatcher.dispatch(
        {
          room_id: roomId,
          participant_id: participantId,
          kind,
          authority: "MEMBER",
          role: "DEVELOPER",
        },
        {
          id: newId("cmd"),
          method: "workspace.apply_changeset",
          idempotency_key: newId("cmd"),
          params: { source: "API", message: "Edit", base_workspace_revision: base, operations },
        },
      );
  return { roomId, human, agent, byHuman: as(human, "HUMAN"), byAgent: as(agent, "AGENT") };
}

const window = () => ({
  since: new Date(Date.now() - 3_600_000),
  until: new Date(Date.now() + 3_600_000),
});
const report = async (roomId: string, extra: Partial<ReturnType<typeof window>> = {}) =>
  conflictRateReport(db.pool, { ...window(), ...extra, roomIds: [roomId] });

describe("conflictRateReport", () => {
  it("counts a fast-forward apply as a submission but not contended", async () => {
    const r = await room();
    await r.byHuman([{ type: "create", path: "a.txt", content: "a" }], 0);
    const cell = (await report(r.roomId)).by_participant.HUMAN;
    expect(cell).toMatchObject({
      submissions: 1,
      contended: 0,
      conflicted: 0,
      conflict_rate: null,
    });
  });

  it("counts a stale-base clean apply as contended", async () => {
    const r = await room();
    await r.byHuman([{ type: "create", path: "a.txt", content: "a" }], 0);
    await r.byAgent([{ type: "create", path: "b.txt", content: "b" }], 0);
    const result = await report(r.roomId);
    expect(result.by_participant.AGENT).toMatchObject({
      submissions: 1,
      contended: 1,
      conflicted: 0,
      conflict_rate: 0,
    });
    expect(result.by_participant.HUMAN.contended).toBe(0);
    expect(result.by_extension["txt"]!.AGENT.contended_file_touches).toBe(1);
  });

  async function contentConflict() {
    const r = await room();
    await r.byHuman([{ type: "create", path: "src/x.ts", content: "one\n" }], 0);
    await r.byHuman([{ type: "modify", path: "src/x.ts", content: "human\n" }], 1);
    const conflict = await r.byAgent([{ type: "modify", path: "src/x.ts", content: "agent\n" }], 1);
    expect(conflict.response).toMatchObject({ status: "CONFLICT" });
    return r;
  }

  it("attributes a CONTENT conflict to the AGENT submitter, the .ts extension and the AGENT->HUMAN pair", async () => {
    const r = await contentConflict();
    const result = await report(r.roomId);
    expect(result.by_participant.AGENT).toMatchObject({
      submissions: 1,
      contended: 1,
      conflicted: 1,
      conflict_rate: 1,
    });
    expect(result.by_participant.AGENT.by_kind.CONTENT).toBe(1);
    expect(result.by_extension["ts"]!.AGENT).toMatchObject({
      contended_file_touches: 1,
      conflicted_files: 1,
    });
    expect(result.by_pair["AGENT->HUMAN"]).toBe(1);
    expect(result.structured_candidates).toEqual({ HUMAN: 0, AGENT: 1 });
    expect(result.events).toEqual({ applied: 2, conflict_created: 1 });
  });

  it("uses the ChangeSet's own payload.conflicts, not the conflict row overwritten by a later resolution attempt", async () => {
    const r = await contentConflict();
    await db.pool.query("UPDATE conflicts SET files = $2::jsonb WHERE room_id = $1", [
      r.roomId,
      JSON.stringify([{ path: "other.py", kind: "BINARY", hunks: 0, messages: [] }]),
    ]);
    const result = await report(r.roomId);
    expect(result.by_extension["ts"]!.AGENT.conflicted_files).toBe(1);
    expect(result.by_extension["py"]).toBeUndefined();
    expect(result.by_participant.AGENT.by_kind).toMatchObject({ CONTENT: 1, BINARY: 0 });
  });

  it("reports SYSTEM for actors without a participant row and excludes UPSTREAM ChangeSets", async () => {
    const r = await room();
    await r.byHuman([{ type: "create", path: "a.txt", content: "a" }], 0);
    await r.byHuman([{ type: "create", path: "b.txt", content: "b" }], 1);
    await r.byHuman([{ type: "create", path: "c.txt", content: "c" }], 2);
    await db.pool.query(
      `UPDATE changesets SET actor_id = 'system:ghost'
        WHERE room_id = $1 AND applied_revision = 1`,
      [r.roomId],
    );
    await db.pool.query(
      `UPDATE changesets SET source = 'UPSTREAM' WHERE room_id = $1 AND applied_revision = 2`,
      [r.roomId],
    );
    const result = await report(r.roomId);
    expect(result.by_participant.SYSTEM.submissions).toBe(1);
    expect(result.by_participant.HUMAN.submissions).toBe(1);
  });

  it("buckets extensions: (none), (dotfile), lower-cased .TS -> ts, rename counts from and to", async () => {
    const r = await room();
    await r.byHuman([{ type: "create", path: "old.md", content: "doc" }], 0);
    await r.byHuman([{ type: "create", path: "z.txt", content: "z" }], 1);
    await r.byAgent(
      [
        { type: "create", path: "Makefile", content: "all:" },
        { type: "create", path: ".gitignore", content: "dist" },
        { type: "create", path: "src/A.TS", content: "export {}" },
        { type: "rename", from: "old.md", to: "new.mdx" },
      ],
      1,
    );
    const ext = (await report(r.roomId)).by_extension;
    expect(ext["(none)"]!.AGENT.contended_file_touches).toBe(1);
    expect(ext["(dotfile)"]!.AGENT.contended_file_touches).toBe(1);
    expect(ext["ts"]!.AGENT.contended_file_touches).toBe(1);
    expect(ext["md"]!.AGENT.contended_file_touches).toBe(1);
    expect(ext["mdx"]!.AGENT.contended_file_touches).toBe(1);
    expect(["a.b.TAR.gz", "dir.x/file", ".env.local", "end.", ".env"].map(extensionOf)).toEqual([
      "gz",
      "(none)",
      "local",
      "(none)",
      "(dotfile)",
    ]);
  });

  it("keeps a path-derived extension key short and plain: anything else is (other)", () => {
    expect(
      [
        "notes.thisisaverylongextension",
        "a.b c",
        "key.AKIAIOSFODNN7EXAMPLE",
        "x.<script>",
        "ok.tar",
        "ok.a1b2c3d4e5",
      ].map(extensionOf),
    ).toEqual(["(other)", "(other)", "(other)", "(other)", "tar", "a1b2c3d4e5"]);
  });

  it("excludes ChangeSets outside [since, until)", async () => {
    const r = await room();
    await r.byHuman([{ type: "create", path: "a.txt", content: "a" }], 0);
    await r.byHuman([{ type: "create", path: "b.txt", content: "b" }], 1);
    await db.pool.query(
      `UPDATE changesets SET created_at = now() - interval '10 days'
        WHERE room_id = $1 AND applied_revision = 1`,
      [r.roomId],
    );
    const result = await report(r.roomId, { since: new Date(Date.now() - 86_400_000) });
    expect(result.by_participant.HUMAN.submissions).toBe(1);
    const future = await report(r.roomId, {
      since: new Date(Date.now() + 60_000),
      until: new Date(Date.now() + 120_000),
    });
    expect(future.by_participant.HUMAN.submissions).toBe(0);
  });

  it("never includes paths, room ids or participant ids in the serialized report", async () => {
    const r = await room();
    await r.byHuman([{ type: "create", path: "secret-dir/plans.ts", content: "one\n" }], 0);
    await r.byHuman([{ type: "modify", path: "secret-dir/plans.ts", content: "h\n" }], 1);
    await r.byAgent([{ type: "modify", path: "secret-dir/plans.ts", content: "a\n" }], 1);
    const text = JSON.stringify(await report(r.roomId));
    for (const forbidden of [r.roomId, r.human, r.agent, "secret-dir", "plans"])
      expect(text, forbidden).not.toContain(forbidden);
    expect(text).toContain('"ts"');
  });
});
