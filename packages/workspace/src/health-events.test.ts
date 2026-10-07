import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { Dispatcher } from "@crossover/kernel";
import { authorize } from "@crossover/policy";
import { newId } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { publishHealthResult, registerWorkspaceHealthReads } from "./health-events.js";
import { storeHealthRun, type HealthRunResult } from "./health-runner.js";

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db?.drop();
});

async function fixture() {
  const roomId = newId("room");
  const workspaceId = newId("ws");
  const ownerId = newId("part");
  const authors = [newId("part"), newId("part"), newId("part"), newId("part")];
  const scopedId = newId("part");
  const scopedDenyId = newId("part");
  const developerId = newId("part");
  const adminId = newId("part");
  await db.pool.query(
    "INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'Health', 'Test', $2)",
    [roomId, ownerId],
  );
  await db.pool.query(
    `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status)
     VALUES ($2, $1, 'HUMAN', 'Owner', 'OWNER', 'LEAD', 'ACTIVE'),
            ($3, $1, 'AGENT', 'Before', 'MEMBER', 'DEVELOPER', 'ACTIVE'),
            ($4, $1, 'AGENT', 'Suspect', 'MEMBER', 'DEVELOPER', 'ACTIVE'),
            ($5, $1, 'AGENT', 'After', 'MEMBER', 'DEVELOPER', 'ACTIVE'),
            ($6, $1, 'AGENT', 'Removed', 'MEMBER', 'DEVELOPER', 'REMOVED'),
            ($7, $1, 'AGENT', 'Scoped', 'MEMBER', 'REVIEWER', 'ACTIVE'),
            ($8, $1, 'AGENT', 'Scoped deny', 'MEMBER', 'REVIEWER', 'ACTIVE'),
            ($9, $1, 'AGENT', 'Developer', 'MEMBER', 'DEVELOPER', 'ACTIVE'),
            ($10, $1, 'HUMAN', 'Admin', 'ADMIN', 'OBSERVER', 'ACTIVE')`,
    [roomId, ownerId, ...authors, scopedId, scopedDenyId, developerId, adminId],
  );
  await db.pool.query(
    `INSERT INTO capability_grants (id, room_id, participant_id, effect, capability, created_by)
     VALUES ($1, $2, $3, 'DENY', 'workspace.read', $4),
            ($5, $2, $3, 'GRANT', 'workspace.read:docs/**', $4),
            ($6, $2, $7, 'DENY', 'workspace.read:private/**', $4),
            ($8, $2, $7, 'GRANT', 'workspace.read:docs/**', $4)`,
    [
      newId("grant"),
      roomId,
      scopedId,
      ownerId,
      newId("grant"),
      newId("grant"),
      scopedDenyId,
      newId("grant"),
    ],
  );
  await db.pool.query(
    `INSERT INTO capability_grants
       (id, room_id, participant_id, effect, capability, created_by, created_at, expires_at)
     VALUES ($1, $2, $3, 'DENY', 'workspace.read', $4,
             clock_timestamp() - interval '1 hour', clock_timestamp() - interval '30 minutes')`,
    [newId("grant"), roomId, developerId, ownerId],
  );
  await db.pool.query(
    "INSERT INTO workspaces (id, room_id, repo_path) VALUES ($1, $2, '/unused')",
    [workspaceId, roomId],
  );
  await db.pool.query(
    "INSERT INTO workspace_revisions (workspace_id, room_id, revision, commit_sha) VALUES ($1, $2, 0, 'commit-0')",
    [workspaceId, roomId],
  );
  const dispatcher = new Dispatcher({ pool: db.pool, authorize, nodeId: roomId });
  registerWorkspaceHealthReads(dispatcher);
  const owner = {
    participant_id: ownerId,
    room_id: roomId,
    kind: "HUMAN" as const,
    authority: "OWNER" as const,
    role: "LEAD" as const,
  };
  const scoped = {
    participant_id: scopedId,
    room_id: roomId,
    kind: "AGENT" as const,
    authority: "MEMBER" as const,
    role: "REVIEWER" as const,
  };
  const scopedDeny = {
    participant_id: scopedDenyId,
    room_id: roomId,
    kind: "AGENT" as const,
    authority: "MEMBER" as const,
    role: "REVIEWER" as const,
  };
  const developer = {
    participant_id: developerId,
    room_id: roomId,
    kind: "AGENT" as const,
    authority: "MEMBER" as const,
    role: "DEVELOPER" as const,
  };
  const admin = {
    participant_id: adminId,
    room_id: roomId,
    kind: "HUMAN" as const,
    authority: "ADMIN" as const,
    role: "OBSERVER" as const,
  };
  const dispatchGet = (
    principal: typeof owner | typeof scoped | typeof scopedDeny | typeof developer | typeof admin,
    runId: string,
  ) =>
    dispatcher.dispatch(principal, {
      id: newId("cmd"),
      method: "workspace.health.get",
      params: { run_id: runId },
    });
  return {
    roomId,
    workspaceId,
    owner,
    scoped,
    scopedDeny,
    developer,
    admin,
    authors,
    dispatcher,
    dispatchGet,
  };
}

async function addRevision(
  f: Awaited<ReturnType<typeof fixture>>,
  revision: number,
  author: string,
): Promise<void> {
  const changesetId = newId("cs");
  await db.pool.query(
    `INSERT INTO changesets (id, workspace_id, room_id, actor_id, idempotency_key, source,
       message, base_workspace_revision, payload, status, applied_revision)
     VALUES ($1, $2, $3, $4, $1, 'EDITOR', 'test', $5, '{}', 'APPLIED', NULL)`,
    [changesetId, f.workspaceId, f.roomId, author, revision - 1],
  );
  await db.pool.query(
    `INSERT INTO workspace_revisions (workspace_id, room_id, revision, commit_sha, changeset_id)
     VALUES ($1, $2, $3, $4, $4)`,
    [f.workspaceId, f.roomId, revision, changesetId],
  );
  await db.pool.query("UPDATE changesets SET applied_revision = $2 WHERE id = $1", [
    changesetId,
    revision,
  ]);
}

async function record(
  f: Awaited<ReturnType<typeof fixture>>,
  revision: number,
  result: HealthRunResult,
) {
  const id = await storeHealthRun(db.pool, {
    workspaceId: f.workspaceId,
    roomId: f.roomId,
    revision,
    result,
  });
  await publishHealthResult(db.pool, f.dispatcher, f.roomId, revision, id, result);
  return id;
}

describe("workspace health events and reads", () => {
  it("keeps log text out of the event, serves it only to unscoped readers, and deduplicates exact-range authors", async () => {
    const f = await fixture();
    await addRevision(f, 1, f.authors[0]!);
    await record(f, 1, { status: "GREEN", durationMs: 10, log: "initially healthy" });
    await addRevision(f, 2, f.authors[1]!);
    await addRevision(f, 3, f.authors[1]!);
    await addRevision(f, 4, f.authors[2]!);
    await addRevision(f, 5, f.authors[3]!);
    const log = "test suite failed\n/private/build/checkout/src/private.ts\nsecret=fixture-value";
    const runId = await record(f, 4, { status: "RED", durationMs: 20, log });

    const { rows: events } = await db.pool.query<{
      actor_id: string;
      type: string;
      payload: Record<string, unknown>;
    }>("SELECT actor_id, type, payload FROM events WHERE room_id = $1 ORDER BY sequence", [
      f.roomId,
    ]);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      actor_id: "system",
      type: "workspace.health",
      payload: { revision: 4, status: "RED", last_green_revision: 1, log_ref: runId },
    });
    expect(JSON.stringify(events)).not.toContain(log);
    expect(JSON.stringify(events)).not.toContain("private.ts");
    expect(JSON.stringify(events)).not.toContain("fixture-value");

    const full = (await f.dispatchGet(f.owner, runId)).response as Record<string, unknown>;
    expect(full).toMatchObject({
      run_id: runId,
      revision: 4,
      status: "RED",
      summary: log,
      log_tail: log,
    });
    const scoped = (await f.dispatchGet(f.scoped, runId)).response as Record<string, unknown>;
    expect(scoped).toMatchObject({ run_id: runId, revision: 4, status: "RED" });
    expect(scoped).not.toHaveProperty("summary");
    expect(scoped).not.toHaveProperty("log_tail");
    const scopedDeny = (await f.dispatchGet(f.scopedDeny, runId)).response as Record<
      string,
      unknown
    >;
    expect(scopedDeny).not.toHaveProperty("log_tail");
    const developer = (await f.dispatchGet(f.developer, runId)).response as Record<string, unknown>;
    expect(developer).toHaveProperty("log_tail", log);
    const admin = (await f.dispatchGet(f.admin, runId)).response as Record<string, unknown>;
    expect(admin).toHaveProperty("log_tail", log);

    const { rows: inbox } = await db.pool.query<{ participant_id: string; kind: string }>(
      "SELECT participant_id, kind FROM inbox_items WHERE room_id = $1",
      [f.roomId],
    );
    expect(inbox.map((row) => row.participant_id).sort()).toEqual(
      [f.authors[1], f.authors[2]].sort(),
    );
    expect(inbox).toHaveLength(2);
    expect(inbox.every((row) => row.kind === "HEALTH_RED")).toBe(true);
  });

  it("emits GREEN and ERROR without suspect notifications or a suspect range", async () => {
    const f = await fixture();
    const greenId = await record(f, 0, { status: "GREEN", durationMs: 10, log: "ok" });
    await db.pool.query(
      "INSERT INTO health_runs (id, workspace_id, room_id, revision, status, duration_ms, log) VALUES ($1, $2, $3, 0, 'ERROR', 20, 'runner failed')",
      [newId("health"), f.workspaceId, f.roomId],
    );
    const errorId = (
      await db.pool.query<{ id: string }>(
        "SELECT id FROM health_runs WHERE room_id = $1 AND status = 'ERROR'",
        [f.roomId],
      )
    ).rows[0]!.id;
    await publishHealthResult(db.pool, f.dispatcher, f.roomId, 0, errorId, {
      status: "ERROR",
      durationMs: 20,
      log: "runner failed",
    });
    const { rows: events } = await db.pool.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM events WHERE room_id = $1 ORDER BY sequence",
      [f.roomId],
    );
    expect(events).toHaveLength(2);
    expect(events[0]!.payload).toMatchObject({ status: "GREEN", revision: 0, log_ref: greenId });
    expect(events[1]!.payload).toMatchObject({ status: "ERROR", revision: 0, log_ref: errorId });
    expect(events[1]!.payload).not.toHaveProperty("last_green_revision");
    const { rows: inbox } = await db.pool.query("SELECT id FROM inbox_items WHERE room_id = $1", [
      f.roomId,
    ]);
    expect(inbox).toEqual([]);
  });

  it("starts a first RED suspect range at revision 1 and excludes removed authors", async () => {
    const f = await fixture();
    await addRevision(f, 1, f.authors[0]!);
    await addRevision(f, 2, f.authors[3]!);
    await db.pool.query("UPDATE participants SET status = 'REMOVED' WHERE id = $1", [f.authors[3]]);
    await addRevision(f, 3, f.authors[1]!);
    const runId = await record(f, 3, { status: "RED", durationMs: 10, log: "failure" });
    const event = (
      await db.pool.query<{ payload: Record<string, unknown> }>(
        "SELECT payload FROM events WHERE room_id = $1",
        [f.roomId],
      )
    ).rows[0]!.payload;
    expect(event).toMatchObject({ last_green_revision: null, revision: 3, log_ref: runId });
    const { rows: inbox } = await db.pool.query<{ participant_id: string; kind: string }>(
      "SELECT participant_id, kind FROM inbox_items WHERE room_id = $1",
      [f.roomId],
    );
    expect(inbox.map((row) => row.participant_id).sort()).toEqual(
      [f.authors[0], f.authors[1]].sort(),
    );
    expect(inbox).toHaveLength(2);
    expect(inbox.every((row) => row.kind === "HEALTH_RED")).toBe(true);
  });
});
