import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { authorize } from "@crossover/policy";
import { newId } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Dispatcher } from "../../dispatcher.js";
import type { Principal } from "../../principal.js";
import { registerRoomProtectedPathsCommand } from "./protected-paths.js";

let db: TestDatabase;
let pool: Pool;
let sequence = 0;

beforeAll(async () => {
  db = await createTestDatabase();
  pool = db.pool;
});

afterAll(async () => {
  await db.drop();
});

function command(patterns: string[]) {
  return {
    id: newId("cmd"),
    method: "room.set_protected_paths",
    params: { patterns },
    idempotency_key: `protected-paths-${++sequence}`,
  };
}

interface RoomFixture {
  dispatcher: Dispatcher;
  roomId: string;
  owner: Principal;
  admin: Principal;
  member: Principal;
}

async function fixture(): Promise<RoomFixture> {
  const roomId = newId("room");
  const ownerId = newId("part");
  const adminId = newId("part");
  const memberId = newId("part");
  await pool.query(
    `INSERT INTO rooms (id, slug, name, objective, owner_id, lead_participant_id, settings)
     VALUES ($1, $1, 'Room', 'test', $2, $2, '{"keep":true}'::jsonb)`,
    [roomId, ownerId],
  );
  await pool.query(
    `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status)
     VALUES ($1, $4, 'HUMAN', 'Owner', 'OWNER', 'LEAD', 'ACTIVE'),
            ($2, $4, 'HUMAN', 'Admin', 'ADMIN', 'DEVELOPER', 'ACTIVE'),
            ($3, $4, 'AGENT', 'Member', 'MEMBER', 'DEVELOPER', 'ACTIVE')`,
    [ownerId, adminId, memberId, roomId],
  );
  const principal = (
    participantId: string,
    kind: Principal["kind"],
    authority: Principal["authority"],
    role: Principal["role"],
  ): Principal => ({
    room_id: roomId,
    participant_id: participantId,
    kind,
    authority,
    role,
  });
  const dispatcher = new Dispatcher({ pool, authorize, nodeId: `node-protected-${++sequence}` });
  registerRoomProtectedPathsCommand(dispatcher);
  return {
    dispatcher,
    roomId,
    owner: principal(ownerId, "HUMAN", "OWNER", "LEAD"),
    admin: principal(adminId, "HUMAN", "ADMIN", "DEVELOPER"),
    member: principal(memberId, "AGENT", "MEMBER", "DEVELOPER"),
  };
}

const run = (room: RoomFixture, who: Principal, patterns: string[]) =>
  room.dispatcher.dispatch(who, command(patterns));

describe("room.set_protected_paths", () => {
  it("stores a sorted unique list, preserves other settings, and emits the room event", async () => {
    const room = await fixture();
    const result = await run(room, room.owner, ["infra/prod/**", ".github/workflows/**"]);
    expect(result.response).toEqual({
      patterns: [".github/workflows/**", "infra/prod/**"],
      changed: true,
    });
    expect(result.events[0]).toMatchObject({
      type: "room.protected_paths_changed",
      payload: { patterns: [".github/workflows/**", "infra/prod/**"] },
    });
    const settings = (
      await pool.query<{ settings: Record<string, unknown> }>(
        "SELECT settings FROM rooms WHERE id = $1",
        [room.roomId],
      )
    ).rows[0]!.settings;
    expect(settings).toEqual({
      keep: true,
      protected_paths: [".github/workflows/**", "infra/prod/**"],
    });

    expect((await run(room, room.owner, [])).response).toEqual({ patterns: [], changed: true });
    expect((await run(room, room.owner, [])).response).toEqual({ patterns: [], changed: false });
  });

  it("is owner-only and rejects unsafe globs and more than 100 patterns", async () => {
    const room = await fixture();
    await expect(run(room, room.admin, ["infra/prod/**"])).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(run(room, room.member, ["infra/prod/**"])).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(run(room, room.owner, ["../secrets/**"])).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(
      run(
        room,
        room.owner,
        Array.from({ length: 101 }, (_, i) => `path${i}/**`),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    const settings = (
      await pool.query<{ settings: Record<string, unknown> }>(
        "SELECT settings FROM rooms WHERE id = $1",
        [room.roomId],
      )
    ).rows[0]!.settings;
    expect(settings).toEqual({ keep: true });
  });
});
