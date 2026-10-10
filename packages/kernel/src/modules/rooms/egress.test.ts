import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { authorize } from "@crossover/policy";
import { CrossoverError, newId } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Dispatcher } from "../../dispatcher.js";
import type { Principal } from "../../principal.js";
import { redactEventFor } from "./redact.js";
import { registerRoomEgressAllowlistCommand } from "./egress.js";

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

const command = (hosts: string[]) => ({
  id: newId("cmd"),
  method: "room.set_egress_allowlist",
  params: { hosts },
  idempotency_key: `egress-${++n}`,
});

interface Room {
  d: Dispatcher;
  room_id: string;
  owner: Principal;
  admin: Principal;
  member: Principal;
}

async function setup(): Promise<Room> {
  const roomId = newId("room");
  const ownerId = newId("part");
  const adminId = newId("part");
  const memberId = newId("part");
  await pool.query(
    `INSERT INTO rooms (id, slug, name, objective, owner_id, lead_participant_id, settings)
     VALUES ($1, $1, 'room', 'test', $2, $2, '{"keep":true}'::jsonb)`,
    [roomId, ownerId],
  );
  await pool.query(
    `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status)
     VALUES ($1, $2, 'HUMAN', 'owner', 'OWNER', 'LEAD', 'ACTIVE'),
            ($3, $2, 'HUMAN', 'admin', 'ADMIN', 'DEVELOPER', 'ACTIVE'),
            ($4, $2, 'AGENT', 'member', 'MEMBER', 'DEVELOPER', 'ACTIVE')`,
    [ownerId, roomId, adminId, memberId],
  );
  const principal = (
    participant_id: string,
    kind: Principal["kind"],
    authority: Principal["authority"],
    role: Principal["role"],
  ): Principal => ({ participant_id, room_id: roomId, kind, authority, role });
  const d = new Dispatcher({ pool, authorize, nodeId: `node-egress-${++n}` });
  registerRoomEgressAllowlistCommand(d);
  return {
    d,
    room_id: roomId,
    owner: principal(ownerId, "HUMAN", "OWNER", "LEAD"),
    admin: principal(adminId, "HUMAN", "ADMIN", "DEVELOPER"),
    member: principal(memberId, "AGENT", "MEMBER", "DEVELOPER"),
  };
}

const run = (room: Room, who: Principal, hosts: string[]) => room.d.dispatch(who, command(hosts));

describe("room.set_egress_allowlist", () => {
  it("normalizes hosts, preserves other settings, and emits the room-wide event", async () => {
    const room = await setup();
    const out = await run(room, room.owner, [" API.Example.com. ", "*.Packages.example"]);
    expect(out.response).toEqual({
      hosts: ["api.example.com", "*.packages.example"],
      changed: true,
    });
    expect(out.events).toHaveLength(1);
    expect(out.events[0]).toMatchObject({
      type: "room.egress_allowlist_changed",
      actor_id: room.owner.participant_id,
      payload: { hosts: ["api.example.com", "*.packages.example"] },
    });

    const settings = (
      await pool.query<{ settings: Record<string, unknown> }>(
        "SELECT settings FROM rooms WHERE id = $1",
        [room.room_id],
      )
    ).rows[0]!.settings;
    expect(settings).toEqual({
      keep: true,
      egress_allowlist: ["api.example.com", "*.packages.example"],
    });

    // Egress settings are already room-wide in room.get_state; the corresponding event uses
    // the same participant-view convention (§34.5), so an ordinary member sees the host list.
    expect(redactEventFor(room.member, out.events[0]!)).toBe(out.events[0]);
  });

  it("allows admins and treats an identical canonical list as a no-op", async () => {
    const room = await setup();
    await run(room, room.owner, ["api.example.com"]);
    const out = await run(room, room.admin, ["API.EXAMPLE.COM."]);
    expect(out.response).toEqual({ hosts: ["api.example.com"], changed: false });
    expect(out.events).toEqual([]);
  });

  it("denies members and rejects invalid hosts without changing settings", async () => {
    const room = await setup();
    const denied = await run(room, room.member, ["allowed.example"]).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(denied).toBeInstanceOf(CrossoverError);
    expect((denied as CrossoverError).code).toBe("FORBIDDEN");

    const invalid = await run(room, room.owner, ["http://example.com"]).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(invalid).toBeInstanceOf(CrossoverError);
    expect((invalid as CrossoverError).code).toBe("VALIDATION");
    const tooMany = await run(
      room,
      room.owner,
      Array.from({ length: 101 }, () => "host.example"),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(tooMany).toBeInstanceOf(CrossoverError);
    expect((tooMany as CrossoverError).code).toBe("VALIDATION");
    const settings = (
      await pool.query<{ settings: Record<string, unknown> }>(
        "SELECT settings FROM rooms WHERE id = $1",
        [room.room_id],
      )
    ).rows[0]!.settings;
    expect(settings).toEqual({ keep: true });
  });
});
