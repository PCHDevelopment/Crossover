import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { authorize } from "@crossover/policy";
import { newId } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Dispatcher } from "@crossover/kernel";
import { publishHealthResult } from "./health-events.js";
import { storeHealthRun } from "./health-runner.js";

let db: TestDatabase;
let dispatcher: Dispatcher;
let roomId: string;
let workspaceId: string;
let authorBefore: string;
let suspectAuthor: string;

beforeAll(async () => {
  db = await createTestDatabase();
  dispatcher = new Dispatcher({ pool: db.pool, authorize, nodeId: "health-events-test" });
  roomId = newId("room");
  workspaceId = newId("ws");
  const owner = newId("part");
  authorBefore = newId("part");
  suspectAuthor = newId("part");
  await db.pool.query(
    "INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'Health', 'Test', $2)",
    [roomId, owner],
  );
  await db.pool.query(
    `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status)
     VALUES ($2, $1, 'HUMAN', 'Owner', 'OWNER', 'LEAD', 'ACTIVE'),
            ($3, $1, 'AGENT', 'Before', 'MEMBER', 'DEVELOPER', 'ACTIVE'),
            ($4, $1, 'AGENT', 'Suspect', 'MEMBER', 'DEVELOPER', 'ACTIVE')`,
    [roomId, owner, authorBefore, suspectAuthor],
  );
  await db.pool.query(
    "INSERT INTO workspaces (id, room_id, repo_path) VALUES ($1, $2, '/unused')",
    [workspaceId, roomId],
  );
  await db.pool.query(
    "INSERT INTO workspace_revisions (workspace_id, room_id, revision, commit_sha) VALUES ($1, $2, 0, 'commit-0')",
    [workspaceId, roomId],
  );
});

afterAll(async () => {
  await db?.drop();
});

async function addRevision(revision: number, author: string): Promise<void> {
  const changesetId = newId("cs");
  await db.pool.query(
    `INSERT INTO changesets (id, workspace_id, room_id, actor_id, idempotency_key, source,
       message, base_workspace_revision, payload, status, applied_revision)
     VALUES ($1, $2, $3, $4, $1, 'EDITOR', 'test', $5, '{}', 'APPLIED', NULL)`,
    [changesetId, workspaceId, roomId, author, revision - 1],
  );
  await db.pool.query(
    `INSERT INTO workspace_revisions (workspace_id, room_id, revision, commit_sha, changeset_id)
     VALUES ($1, $2, $3, $4, $4)`,
    [workspaceId, roomId, revision, changesetId],
  );
  await db.pool.query("UPDATE changesets SET applied_revision = $2 WHERE id = $1", [
    changesetId,
    revision,
  ]);
}

describe("workspace health events", () => {
  it("emits RED under the system actor and notifies only authors after the last GREEN revision", async () => {
    await addRevision(1, authorBefore);
    const green = { status: "GREEN" as const, durationMs: 10, log: "ok" };
    await storeHealthRun(db.pool, { workspaceId, roomId, revision: 1, result: green });

    await addRevision(2, suspectAuthor);
    const red = { status: "RED" as const, durationMs: 20, log: "test suite failed\nassertion" };
    const runId = await storeHealthRun(db.pool, { workspaceId, roomId, revision: 2, result: red });
    await publishHealthResult(db.pool, dispatcher, roomId, 2, runId, red);

    const { rows: events } = await db.pool.query<{
      actor_id: string;
      type: string;
      payload: Record<string, unknown>;
    }>("SELECT actor_id, type, payload FROM events WHERE room_id = $1", [roomId]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor_id: "system",
      type: "workspace.health",
      payload: {
        revision: 2,
        status: "RED",
        last_green_revision: 1,
        log_ref: runId,
        failing_summary: "test suite failed\nassertion",
      },
    });
    const { rows: inbox } = await db.pool.query<{ participant_id: string; kind: string }>(
      "SELECT participant_id, kind FROM inbox_items WHERE room_id = $1",
      [roomId],
    );
    expect(inbox).toEqual([{ participant_id: suspectAuthor, kind: "CONFLICT" }]);
  });
});
