import type { PoolClient } from "@crossover/db";
import { CrossoverError, newId } from "@crossover/protocol";
import { git } from "./git.js";
import { initRoomRepo } from "./repo.js";

/** Provision §9.1 history in the caller's room-creation transaction; safe to retry. */
export async function provisionWorkspace(
  client: PoolClient,
  roomId: string,
  workspaceRoot: string,
): Promise<string> {
  const room = await client.query("SELECT id FROM rooms WHERE id = $1 FOR UPDATE", [roomId]);
  if (!room.rowCount) throw new CrossoverError("NOT_FOUND", "Room not found");
  const existing = await client.query<{ id: string }>(
    "SELECT id FROM workspaces WHERE room_id = $1",
    [roomId],
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const repo = await initRoomRepo(workspaceRoot, roomId);
  const commit = (
    await git(["rev-parse", "refs/room/canonical"], { gitDir: repo, timeoutMs: 10_000 })
  ).stdout.trim();
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO workspaces (id, room_id, repo_path) VALUES ($1, $2, $3)
     ON CONFLICT (room_id) DO UPDATE SET room_id = EXCLUDED.room_id RETURNING id`,
    [newId("ws"), roomId, repo],
  );
  const id = rows[0]!.id;
  await client.query(
    `INSERT INTO workspace_revisions (workspace_id, room_id, revision, commit_sha)
     VALUES ($1, $2, 0, $3) ON CONFLICT (workspace_id, revision) DO NOTHING`,
    [id, roomId, commit],
  );
  return id;
}
