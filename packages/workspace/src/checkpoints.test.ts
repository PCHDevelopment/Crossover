import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withTransaction } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { allowAll, Dispatcher } from "@crossover/kernel";
import { CrossoverError, newId } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerWorkspaceCommands } from "./apply.js";
import { provisionWorkspace } from "./provision.js";

let db: TestDatabase;
const dirs: string[] = [];

beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function setup(healthCommand: string | null) {
  const roomId = newId("room");
  const owner = newId("part");
  const lead = newId("part");
  const root = await mkdtemp(join(tmpdir(), "crossover-ckpt-"));
  dirs.push(root);
  await db.pool.query(
    "INSERT INTO rooms (id, slug, name, objective, owner_id, settings) VALUES ($1, $1, 'Room', 'Ship', $2, $3::jsonb)",
    [roomId, owner, JSON.stringify(healthCommand ? { health_command: healthCommand } : {})],
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
          "SELECT max(revision) AS r FROM workspace_revisions WHERE room_id = $1",
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
  const health = (revision: number, status: "GREEN" | "RED" | "ERROR") =>
    db.pool.query(
      `INSERT INTO health_runs (id, workspace_id, room_id, revision, status, duration_ms, log)
       SELECT $1, workspace_id, room_id, revision, $4, 1, 'log' FROM workspace_revisions
       WHERE room_id = $2 AND revision = $3`,
      [newId("health"), roomId, revision, status],
    );
  const events = async () =>
    (
      await db.pool.query(
        "SELECT payload FROM events WHERE room_id = $1 AND type = 'checkpoint.created' ORDER BY sequence",
        [roomId],
      )
    ).rows.map((r) => r.payload);
  return { roomId, owner, lead, ownerP, leadP, call, edit, health, events };
}

const rejects = async (p: Promise<unknown>, code: string, reason: string) => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CrossoverError);
  expect((err as CrossoverError).code).toBe(code);
  expect((err as CrossoverError).details).toMatchObject({ reason });
};

describe("checkpoints (§24.3, T804)", () => {
  it("marks the head revision, emits checkpoint.created, and lists it", async () => {
    const s = await setup(null);
    const rev = await s.edit();
    const out = await s.call(s.leadP, "checkpoints.create", { message: "  first milestone " });
    expect(out.response).toMatchObject({
      revision: rev,
      message: "first milestone",
      created_by: s.lead,
      health_status: null,
      overridden: false,
    });
    expect(await s.events()).toEqual([
      expect.objectContaining({ revision: rev, created_by: s.lead, overridden: false }),
    ]);
    const list = await s.call(s.ownerP, "checkpoints.list", {});
    expect(list.response).toMatchObject({
      checkpoints: [
        {
          revision: rev,
          message: "first milestone",
          provenance: { author_id: s.lead, author_kind: "AGENT" },
        },
      ],
      has_more: false,
    });
  });

  it("an empty workspace has nothing to mark, and a revision is marked once", async () => {
    const s = await setup(null);
    await rejects(
      s.call(s.leadP, "checkpoints.create", { message: "x" }),
      "VALIDATION",
      "empty_workspace",
    );
    await s.edit();
    await s.call(s.leadP, "checkpoints.create", { message: "one" });
    await rejects(
      s.call(s.leadP, "checkpoints.create", { message: "again" }),
      "VALIDATION",
      "already_checkpointed",
    );
    await s.edit();
    await s.call(s.leadP, "checkpoints.create", { message: "two" });
  });

  it("with a health command, only a GREEN head can be marked: red, errored and pending block", async () => {
    const s = await setup("npm test");
    const rev = await s.edit();
    await rejects(
      s.call(s.leadP, "checkpoints.create", { message: "x" }),
      "VALIDATION",
      "health_pending",
    );
    await s.health(rev, "RED");
    await rejects(
      s.call(s.leadP, "checkpoints.create", { message: "x" }),
      "VALIDATION",
      "health_red",
    );
    await s.health(rev, "ERROR");
    await rejects(
      s.call(s.leadP, "checkpoints.create", { message: "x" }),
      "VALIDATION",
      "health_error",
    );
    expect(await s.events()).toEqual([]);
    await s.health(rev, "GREEN");
    const out = await s.call(s.leadP, "checkpoints.create", { message: "green" });
    expect(out.response).toMatchObject({ health_status: "GREEN", overridden: false });
  });

  it("the owner can override a red head, and the checkpoint says so; nobody else can", async () => {
    const s = await setup("npm test");
    const rev = await s.edit();
    await s.health(rev, "RED");
    await rejects(
      s.call(s.leadP, "checkpoints.create", { message: "x", override: true }),
      "FORBIDDEN",
      "owner_only_override",
    );
    const out = await s.call(s.ownerP, "checkpoints.create", {
      message: "ship anyway",
      override: true,
    });
    expect(out.response).toMatchObject({ health_status: "RED", overridden: true });
    expect(await s.events()).toEqual([
      expect.objectContaining({ health_status: "RED", overridden: true }),
    ]);
  });

  it("an override on a green head isn't recorded as one", async () => {
    const s = await setup("npm test");
    const rev = await s.edit();
    await s.health(rev, "GREEN");
    const out = await s.call(s.ownerP, "checkpoints.create", { message: "fine", override: true });
    expect(out.response).toMatchObject({ health_status: "GREEN", overridden: false });
  });

  it("lists oldest first in pages, and an unknown cursor is NOT_FOUND", async () => {
    const s = await setup(null);
    for (const m of ["a", "b", "c"]) {
      await s.edit();
      await s.call(s.leadP, "checkpoints.create", { message: m });
    }
    const first = await s.call(s.ownerP, "checkpoints.list", { limit: 2 });
    const page1 = first.response as {
      checkpoints: { id: string; message: string }[];
      has_more: boolean;
    };
    expect(page1.checkpoints.map((c) => c.message)).toEqual(["a", "b"]);
    expect(page1.has_more).toBe(true);
    const second = await s.call(s.ownerP, "checkpoints.list", {
      limit: 2,
      after: page1.checkpoints[1]!.id,
    });
    expect(second.response).toMatchObject({ checkpoints: [{ message: "c" }], has_more: false });
    await expect(
      s.call(s.ownerP, "checkpoints.list", { after: "ckpt_nope" }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("is per room: another room's checkpoints aren't listed", async () => {
    const a = await setup(null);
    const b = await setup(null);
    await a.edit();
    await a.call(a.leadP, "checkpoints.create", { message: "mine" });
    expect((await b.call(b.ownerP, "checkpoints.list", {})).response).toMatchObject({
      checkpoints: [],
    });
  });
});
