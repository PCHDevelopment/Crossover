import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { allowAll, Dispatcher } from "../../dispatcher.js";
import type { Principal } from "../../principal.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { registerRoomLifecycleCommands } from "./lifecycle.js";
import { registerRoomRetentionCommands } from "./retention.js";
import { ROOM_SCOPED_TABLES, RoomRetentionSweeper } from "./retention-sweeper.js";
import { newId } from "@crossover/protocol";

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

function command(method: string, params: Record<string, unknown> = {}) {
  return {
    id: newId("cmd"),
    method,
    params,
    idempotency_key: `retention-${++n}`,
  };
}

async function archivedRoom() {
  const dispatcher = new Dispatcher({ pool, authorize: allowAll, nodeId: `retention-node-${++n}` });
  registerRoomLifecycleCommands(dispatcher);
  registerRoomRetentionCommands(dispatcher);
  const roomId = newId("room");
  const ownerId = newId("part");
  await pool.query(
    `INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'Room', 'Test', $2)`,
    [roomId, ownerId],
  );
  await pool.query(
    `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status)
     VALUES ($1, $2, 'HUMAN', 'Owner', 'OWNER', 'DEVELOPER', 'ACTIVE')`,
    [ownerId, roomId],
  );
  const owner: Principal = {
    participant_id: ownerId,
    room_id: roomId,
    kind: "HUMAN",
    authority: "OWNER",
    role: "DEVELOPER",
  };
  await dispatcher.dispatch(owner, command("room.archive"));
  return { dispatcher, roomId, ownerId, owner };
}

async function seedPurgeGraph(roomId: string, ownerId: string): Promise<void> {
  const workspaceId = newId("ws");
  const changesetId = newId("cs");
  const conflictId = newId("conf");
  const taskId = newId("task");
  const firstMessageId = newId("msg");
  const secondMessageId = newId("msg");
  const decisionId = newId("dec");
  const sandboxId = newId("sandbox");

  await pool.query("INSERT INTO workspaces (id, room_id, repo_path) VALUES ($1, $2, $3)", [
    workspaceId,
    roomId,
    `/test/${roomId}.git`,
  ]);
  await pool.query(
    `INSERT INTO workspace_revisions (workspace_id, room_id, revision, commit_sha)
     VALUES ($1, $2, 0, 'initial'), ($1, $2, 1, 'next')`,
    [workspaceId, roomId],
  );
  await pool.query(
    `INSERT INTO changesets (id, workspace_id, room_id, actor_id, idempotency_key,
                            source, message, base_workspace_revision, payload, applied_revision)
     VALUES ($1, $2, $3, $4, 'purge-test', 'EDITOR', 'test', 0, '{}'::jsonb, 1)`,
    [changesetId, workspaceId, roomId, ownerId],
  );
  await pool.query(
    `INSERT INTO conflicts (id, workspace_id, room_id, changeset_id, submitter_id,
                            base_revision, head_revision_at_detection, files)
     VALUES ($1, $2, $3, $4, $5, 0, 1, '[]'::jsonb)`,
    [conflictId, workspaceId, roomId, changesetId, ownerId],
  );
  await pool.query("UPDATE changesets SET conflict_id = $2 WHERE id = $1", [
    changesetId,
    conflictId,
  ]);
  await pool.query(
    "UPDATE workspace_revisions SET changeset_id = $2 WHERE workspace_id = $1 AND revision = 1",
    [workspaceId, changesetId],
  );
  await pool.query(
    `INSERT INTO file_revisions (workspace_id, room_id, path, revision, workspace_revision, blob_sha, actor_id)
     VALUES ($1, $2, 'README.md', 1, 1, repeat('a', 40), $3)`,
    [workspaceId, roomId, ownerId],
  );
  await pool.query(
    `INSERT INTO health_runs (id, workspace_id, room_id, revision, status, duration_ms, log)
     VALUES ($1, $2, $3, 1, 'GREEN', 1, '')`,
    [newId("health"), workspaceId, roomId],
  );
  await pool.query(
    `INSERT INTO checkpoints (id, room_id, workspace_id, revision, message, created_by, health_status)
     VALUES ($1, $2, $3, 1, 'test checkpoint', $4, 'GREEN')`,
    [newId("ckpt"), roomId, workspaceId, ownerId],
  );

  await pool.query(
    "INSERT INTO tasks (id, room_id, title, created_by) VALUES ($1, $2, 'Task', $3)",
    [taskId, roomId, ownerId],
  );
  await pool.query(
    `INSERT INTO task_reviews (id, room_id, task_id, reviewer_id, verdict, revision)
     VALUES ($1, $2, $3, $4, 'APPROVE', 0)`,
    [newId("rev"), roomId, taskId, ownerId],
  );
  await pool.query(
    `INSERT INTO messages (id, room_id, author_id, body) VALUES ($1, $2, $3, 'First')`,
    [firstMessageId, roomId, ownerId],
  );
  await pool.query(
    `INSERT INTO messages (id, room_id, author_id, body, reply_to) VALUES ($1, $2, $3, 'Second', $4)`,
    [secondMessageId, roomId, ownerId, firstMessageId],
  );
  await pool.query(
    `INSERT INTO decisions (id, room_id, title, options, proposed_by)
     VALUES ($1, $2, 'Decision', '[{"id":"a"},{"id":"b"}]'::jsonb, $3)`,
    [decisionId, roomId, ownerId],
  );
  await pool.query(
    `INSERT INTO decision_positions (decision_id, room_id, participant_id, option_id, argument)
     VALUES ($1, $2, $3, 'a', 'Because')`,
    [decisionId, roomId, ownerId],
  );
  await pool.query(
    `INSERT INTO memory_entries (room_id, key, value, content_type, author_id, revision)
     VALUES ($1, 'test', 'value', 'text/markdown', $2, 1)`,
    [roomId, ownerId],
  );
  await pool.query(
    `INSERT INTO memory_revisions (room_id, key, revision, value, content_type, author_id)
     VALUES ($1, 'test', 1, 'value', 'text/markdown', $2)`,
    [roomId, ownerId],
  );
  await pool.query(
    `INSERT INTO invites (id, room_id, token_hash, role, created_by, expires_at)
     VALUES ($1, $2, 'hash', 'DEVELOPER', $3, clock_timestamp() + interval '1 hour')`,
    [newId("inv"), roomId, ownerId],
  );
  await pool.query(
    `INSERT INTO auth_tokens (token_hash, kind, participant_id, room_id, family_id, expires_at)
     VALUES ('token-hash', 'ACCESS', $1, $2, 'family', clock_timestamp() + interval '1 hour')`,
    [ownerId, roomId],
  );
  await pool.query(
    `INSERT INTO capability_grants (id, room_id, participant_id, effect, capability, created_by)
     VALUES ($1, $2, $3, 'GRANT', 'workspace.write', $3)`,
    [newId("grant"), roomId, ownerId],
  );
  await pool.query(
    `INSERT INTO idempotency_keys (participant_id, idempotency_key, request_hash, response)
     VALUES ($1, 'purge-test', 'hash', '{}'::jsonb)`,
    [ownerId],
  );
  await pool.query(
    `INSERT INTO tool_invocations (participant_id, idempotency_key, request_hash, room_id, tool)
     VALUES ($1, 'purge-test', 'hash', $2, 'test')`,
    [ownerId, roomId],
  );
  await pool.query(
    `INSERT INTO approvals (id, room_id, requester_id, method, params, idempotency_key,
                            idempotency_hash, request_hash, capability, expires_at)
     VALUES ($1, $2, $3, 'messages.send', '{}'::jsonb, 'key', 'id-hash', 'hash',
             'messages.send', clock_timestamp() + interval '1 hour')`,
    [newId("appr"), roomId, ownerId],
  );
  await pool.query(
    `INSERT INTO wake_windows (participant_id, room_id, last_sent_at) VALUES ($1, $2, clock_timestamp())`,
    [ownerId, roomId],
  );
  await pool.query(
    `INSERT INTO sandboxes (id, room_id, participant_id, status) VALUES ($1, $2, $3, 'DESTROYED')`,
    [sandboxId, roomId, ownerId],
  );
  await pool.query(
    `INSERT INTO sandbox_compute_room_daily (room_id, usage_date) VALUES ($1, CURRENT_DATE)`,
    [roomId],
  );
  await pool.query(
    `INSERT INTO sandbox_compute_agent_daily (room_id, participant_id, usage_date)
     VALUES ($1, $2, CURRENT_DATE)`,
    [roomId, ownerId],
  );
  await pool.query(
    `INSERT INTO sandbox_compute_samples (sandbox_id, last_usage_usec, generation, sampled_at)
     VALUES ($1, 0, 'g1', clock_timestamp())`,
    [sandboxId],
  );
  await pool.query(
    `INSERT INTO integration_room_keys (room_id, key_strategy) VALUES ($1, 'CONFIG')`,
    [roomId],
  );
  await pool.query(
    `INSERT INTO integrations (room_id, provider, status, encrypted_secret, connected_by)
     VALUES ($1, 'github', 'EXPIRED',
             '{"version":"1","iv":"i","ciphertext":"c","tag":"t"}'::jsonb, $2)`,
    [roomId, ownerId],
  );
}

describe("RoomRetentionSweeper", () => {
  it("keeps room purge coverage aligned with every room-scoped table", async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT columns.table_name
         FROM information_schema.columns AS columns
         JOIN information_schema.tables AS tables
           ON tables.table_schema = columns.table_schema
          AND tables.table_name = columns.table_name
        WHERE columns.table_schema = 'public'
          AND columns.column_name = 'room_id'
          AND tables.table_type = 'BASE TABLE'
          AND columns.table_name NOT IN ('room_deletion_audit', 'room_leases', 'rooms')
        ORDER BY columns.table_name`,
    );

    expect(rows.map((row) => row.table_name)).toEqual(ROOM_SCOPED_TABLES);
  });

  it("sends one owner inbox notice at the seven-day boundary", async () => {
    const { dispatcher, roomId } = await archivedRoom();
    const now = new Date();
    await pool.query(
      `UPDATE rooms SET retention_days = 30, archived_at = $2::timestamptz - interval '23 days'
        WHERE id = $1`,
      [roomId, now],
    );
    const sweeper = new RoomRetentionSweeper({
      pool,
      dispatcher,
      now: () => now,
      purgeWorkspace: async () => {},
    });

    expect(await sweeper.tick()).toBe(1);
    expect(await sweeper.tick()).toBe(0);
    const { rows } = await pool.query(`SELECT kind, summary FROM inbox_items WHERE room_id = $1`, [
      roomId,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("ROOM_RETENTION");
    expect(rows[0].summary).toContain("scheduled for permanent deletion");
    const events = await pool.query(
      "SELECT type FROM events WHERE room_id = $1 AND type = 'inbox.delivered'",
      [roomId],
    );
    expect(events.rows).toHaveLength(1);
  });

  it("resumes an interrupted purge and writes its audit outside the deleted room", async () => {
    const { dispatcher, roomId, ownerId } = await archivedRoom();
    await seedPurgeGraph(roomId, ownerId);
    const archivedAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    await pool.query(
      `UPDATE rooms SET retention_days = 30, archived_at = $2::timestamptz WHERE id = $1`,
      [roomId, archivedAt],
    );
    let attempts = 0;
    const purgeWorkspace = vi.fn(async () => {
      attempts++;
      if (attempts === 1) throw new Error("simulated interruption after purge was recorded");
    });
    const onError = vi.fn();
    const sweeper = new RoomRetentionSweeper({
      pool,
      dispatcher,
      now: () => new Date(),
      purgeWorkspace,
      onError,
    });

    await sweeper.tick();
    expect(onError).toHaveBeenCalledOnce();
    expect(
      (await pool.query("SELECT purge_phase FROM rooms WHERE id = $1", [roomId])).rows[0],
    ).toEqual({ purge_phase: "WORKSPACE" });
    await sweeper.tick();

    expect(purgeWorkspace).toHaveBeenCalledTimes(2);
    expect((await pool.query("SELECT id FROM rooms WHERE id = $1", [roomId])).rows).toEqual([]);
    expect(
      (await pool.query("SELECT room_id FROM room_leases WHERE room_id = $1", [roomId])).rows,
    ).toEqual([]);
    expect(
      (await pool.query("SELECT room_id FROM events WHERE room_id = $1", [roomId])).rows,
    ).toEqual([]);
    expect(
      (await pool.query("SELECT room_id FROM participants WHERE room_id = $1", [roomId])).rows,
    ).toEqual([]);
    expect(
      (
        await pool.query(
          "SELECT owner_id, archived_at, retention_days FROM room_deletion_audit WHERE room_id = $1",
          [roomId],
        )
      ).rows[0],
    ).toMatchObject({ owner_id: ownerId, archived_at: archivedAt, retention_days: 30 });
  });

  it("cannot send a duplicate notice from a stale room-lease holder", async () => {
    const { dispatcher: first, roomId } = await archivedRoom();
    const now = new Date();
    await pool.query(
      `UPDATE rooms SET retention_days = 30, archived_at = $2::timestamptz - interval '23 days' WHERE id = $1`,
      [roomId, now],
    );
    const second = new Dispatcher({ pool, authorize: allowAll, nodeId: `retention-node-${++n}` });
    await pool.query(
      "UPDATE room_leases SET expires_at = clock_timestamp() - interval '1 second' WHERE room_id = $1",
      [roomId],
    );
    await second.leases.ensure(roomId);

    const firstSweep = new RoomRetentionSweeper({
      pool,
      dispatcher: first,
      now: () => now,
      purgeWorkspace: async () => {},
      onError: () => {},
    });
    const secondSweep = new RoomRetentionSweeper({
      pool,
      dispatcher: second,
      now: () => now,
      purgeWorkspace: async () => {},
    });
    await Promise.all([firstSweep.tick(), secondSweep.tick()]);

    const { rows } = await pool.query(
      "SELECT id FROM inbox_items WHERE room_id = $1 AND kind = 'ROOM_RETENTION'",
      [roomId],
    );
    expect(rows).toHaveLength(1);
  });
});
