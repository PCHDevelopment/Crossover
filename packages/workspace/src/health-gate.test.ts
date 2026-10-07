import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import type { CommandContext, TaskView } from "@crossover/kernel";
import { CrossoverError, newId } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workspaceHealthGate } from "./health-gate.js";

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db?.drop();
});

async function fixture(healthCommand: string | null = "pnpm test") {
  const roomId = newId("room");
  const workspaceId = newId("ws");
  await db.pool.query(
    `INSERT INTO rooms (id, slug, name, objective, owner_id, settings)
     VALUES ($1, $1, 'Health gate', 'Test', 'owner', $2::jsonb)`,
    [roomId, JSON.stringify(healthCommand === null ? {} : { health_command: healthCommand })],
  );
  await db.pool.query(
    "INSERT INTO workspaces (id, room_id, repo_path) VALUES ($1, $2, '/unused')",
    [workspaceId, roomId],
  );
  await addRevision(workspaceId, roomId, 0);
  const ctx = { room_id: roomId, client: db.pool } as unknown as CommandContext;
  const check = (taskId: string) => workspaceHealthGate.isGreenFor({ id: taskId } as TaskView, ctx);
  return { roomId, workspaceId, check };
}

async function addRevision(workspaceId: string, roomId: string, revision: number) {
  await db.pool.query(
    `INSERT INTO workspace_revisions (workspace_id, room_id, revision, commit_sha)
     VALUES ($1, $2, $3, $4)`,
    [workspaceId, roomId, revision, `commit-${workspaceId}-${revision}`],
  );
}

async function addRun(
  workspaceId: string,
  roomId: string,
  revision: number,
  status: "GREEN" | "RED" | "ERROR",
) {
  const id = newId("health");
  await db.pool.query(
    `INSERT INTO health_runs (id, workspace_id, room_id, revision, status, duration_ms, log)
     VALUES ($1, $2, $3, $4, $5, 10, 'private log')`,
    [id, workspaceId, roomId, revision, status],
  );
  return id;
}

async function rejection(promise: Promise<boolean>) {
  const error = await promise.then(
    () => undefined,
    (value: unknown) => value,
  );
  expect(error).toBeInstanceOf(CrossoverError);
  expect((error as CrossoverError).code).toBe("VALIDATION");
  return error as CrossoverError;
}

describe("workspaceHealthGate", () => {
  it("allows rooms without a configured health command", async () => {
    const f = await fixture("  ");
    expect(await f.check(newId("task"))).toBe(true);
  });

  it("uses the latest health result at or beyond the highest applied task ChangeSet", async () => {
    const f = await fixture();
    const taskId = newId("task");
    const authorId = newId("part");
    await db.pool.query(
      `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status)
       VALUES ($1, $2, 'AGENT', 'Author', 'MEMBER', 'DEVELOPER', 'ACTIVE')`,
      [authorId, f.roomId],
    );
    await addRevision(f.workspaceId, f.roomId, 1);
    await addRevision(f.workspaceId, f.roomId, 2);
    await db.pool.query(
      `INSERT INTO changesets
         (id, workspace_id, room_id, actor_id, idempotency_key, source, task_id, message,
          base_workspace_revision, payload, status, applied_revision)
       VALUES ($1, $2, $3, $4, $5, 'API', $6, 'task artifact 1', 0, '{}', 'APPLIED', 1),
              ($7, $2, $3, $4, $8, 'API', $6, 'task artifact 2', 1, '{}', 'APPLIED', 2)`,
      [
        newId("cs"),
        f.workspaceId,
        f.roomId,
        authorId,
        newId("cmd"),
        taskId,
        newId("cs"),
        newId("cmd"),
      ],
    );
    await addRun(f.workspaceId, f.roomId, 1, "GREEN");

    const pending = await rejection(f.check(taskId));
    expect(pending.details).toMatchObject({
      reason: "health_gate_pending",
      required_revision: 2,
      latest_run: null,
    });

    await addRun(f.workspaceId, f.roomId, 2, "GREEN");

    expect(await f.check(taskId)).toBe(true);
  });

  it("reports RED when the latest applicable run is red, even after an earlier GREEN", async () => {
    const f = await fixture();
    const taskId = newId("task");
    await addRevision(f.workspaceId, f.roomId, 1);
    await db.pool.query(
      `INSERT INTO events (room_id, sequence, actor_id, type, payload, payload_hash)
       VALUES ($1, 1, 'system', 'workspace.changeset.applied', '{"applied_revision":1}', 'hash'),
              ($1, 2, 'system', 'task.submitted', $2::jsonb, 'hash')`,
      [f.roomId, JSON.stringify({ task_id: taskId })],
    );
    await addRevision(f.workspaceId, f.roomId, 2);
    await addRun(f.workspaceId, f.roomId, 1, "GREEN");
    const redRun = await addRun(f.workspaceId, f.roomId, 2, "RED");

    const error = await rejection(f.check(taskId));
    expect(error.details).toEqual({
      reason: "health_gate_red",
      required_revision: 1,
      latest_run: { id: redRun, revision: 2, status: "RED" },
    });
    expect(JSON.stringify(error.details)).not.toContain("private log");
  });

  it("uses the submission-time workspace head when there is no linked applied ChangeSet", async () => {
    const f = await fixture();
    const taskId = newId("task");
    await addRevision(f.workspaceId, f.roomId, 1);
    await db.pool.query(
      `INSERT INTO events (room_id, sequence, actor_id, type, payload, payload_hash)
       VALUES ($1, 1, 'system', 'workspace.changeset.applied', '{"applied_revision":1}', 'hash'),
              ($1, 2, 'system', 'task.submitted', $2::jsonb, 'hash'),
              ($1, 3, 'system', 'workspace.changeset.applied', '{"applied_revision":2}', 'hash')`,
      [f.roomId, JSON.stringify({ task_id: taskId })],
    );
    await addRevision(f.workspaceId, f.roomId, 2);
    const greenRun = await addRun(f.workspaceId, f.roomId, 1, "GREEN");
    expect(await f.check(taskId)).toBe(true);
    const { rows } = await db.pool.query<{ revision: string }>(
      "SELECT revision FROM health_runs WHERE id = $1",
      [greenRun],
    );
    expect(rows[0]?.revision).toBe("1");
  });

  it("distinguishes ERROR and pending runs and never includes log text", async () => {
    const f = await fixture();
    const taskId = newId("task");
    await addRevision(f.workspaceId, f.roomId, 1);
    await db.pool.query(
      `INSERT INTO events (room_id, sequence, actor_id, type, payload, payload_hash)
       VALUES ($1, 1, 'system', 'task.submitted', $2::jsonb, 'hash')`,
      [f.roomId, JSON.stringify({ task_id: taskId })],
    );
    const errorRun = await addRun(f.workspaceId, f.roomId, 1, "ERROR");
    const error = await rejection(f.check(taskId));
    expect(error.details).toEqual({
      reason: "health_gate_error",
      required_revision: 0,
      latest_run: { id: errorRun, revision: 1, status: "ERROR" },
    });

    const pendingTask = newId("task");
    await addRevision(f.workspaceId, f.roomId, 2);
    await db.pool.query(
      `INSERT INTO events (room_id, sequence, actor_id, type, payload, payload_hash)
       VALUES ($1, 3, 'system', 'workspace.changeset.applied', '{"applied_revision":2}', 'hash'),
              ($1, 4, 'system', 'task.submitted', $2::jsonb, 'hash')`,
      [f.roomId, JSON.stringify({ task_id: pendingTask })],
    );
    const pending = await rejection(f.check(pendingTask));
    expect(pending.details).toEqual({
      reason: "health_gate_pending",
      required_revision: 2,
      latest_run: null,
    });
  });
});
