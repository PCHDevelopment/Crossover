import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDatabase } from "@crossover/db/testing";
import { allowAll, Dispatcher } from "@crossover/kernel";
import { newId } from "@crossover/protocol";
import { expect, it } from "vitest";
import { registerRoomLifecycleCommands } from "../../../packages/kernel/src/modules/rooms/lifecycle.js";
import { RoomRetentionSweeper } from "../../../packages/kernel/src/modules/rooms/retention-sweeper.js";
import { createShallowRoomFixture } from "../../../packages/workspace/src/shallow-room-test-helper.js";

it("purges a room whose repository has a shallow upstream boundary", async () => {
  const db = await createTestDatabase();
  const root = await mkdtemp(join(tmpdir(), "crossover-retention-shallow-"));
  try {
    const fixture = await createShallowRoomFixture(root);
    const roomId = newId("room");
    const ownerId = newId("part");
    const workspaceId = newId("ws");
    await db.pool.query(
      "INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1,$1,'Room','Test',$2)",
      [roomId, ownerId],
    );
    await db.pool.query(
      `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status)
       VALUES ($1,$2,'HUMAN','Owner','OWNER','DEVELOPER','ACTIVE')`,
      [ownerId, roomId],
    );
    await db.pool.query("INSERT INTO workspaces (id, room_id, repo_path) VALUES ($1,$2,$3)", [
      workspaceId,
      roomId,
      fixture.repository,
    ]);
    await db.pool.query(
      "INSERT INTO workspace_revisions (workspace_id, room_id, revision, commit_sha) VALUES ($1,$2,0,$3)",
      [workspaceId, roomId, fixture.canonical],
    );
    const dispatcher = new Dispatcher({ pool: db.pool, authorize: allowAll, nodeId: roomId });
    registerRoomLifecycleCommands(dispatcher);
    await dispatcher.dispatch(
      {
        room_id: roomId,
        participant_id: ownerId,
        kind: "HUMAN",
        authority: "OWNER",
        role: "DEVELOPER",
      },
      { id: newId("cmd"), method: "room.archive", idempotency_key: newId("cmd"), params: {} },
    );
    const now = new Date();
    await db.pool.query(
      `UPDATE rooms SET retention_days = 30, archived_at = $2::timestamptz - interval '31 days' WHERE id = $1`,
      [roomId, now],
    );
    const purged: string[] = [];
    const sweeper = new RoomRetentionSweeper({
      pool: db.pool,
      dispatcher,
      now: () => now,
      purgeWorkspace: async (_room, path) => {
        if (path) {
          purged.push(path);
          await rm(path, { recursive: true, force: true });
        }
      },
    });
    expect(await sweeper.tick()).toBe(1);
    expect(purged).toEqual([fixture.repository]);
    await expect(readFile(join(fixture.repository, "shallow"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await db.pool.query("SELECT id FROM rooms WHERE id = $1", [roomId])).rows).toEqual([]);
  } finally {
    await db.drop();
    await rm(root, { recursive: true, force: true });
  }
});
