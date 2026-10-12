import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { authorize } from "@crossover/policy";
import { newId } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Dispatcher } from "../../dispatcher.js";
import type { Principal } from "../../principal.js";
import { registerRoomHealthSettingsCommand } from "./health-settings.js";

const DEFAULT_IMAGE = "node:22-bookworm-slim";
const ALLOWED_IMAGES = [DEFAULT_IMAGE, "python:3.13"];

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

function command(params: { health_command: string | null; health_image?: string | null }) {
  return {
    id: newId("cmd"),
    method: "room.set_health",
    params,
    idempotency_key: `health-settings-${++sequence}`,
  };
}

interface RoomFixture {
  dispatcher: Dispatcher;
  roomId: string;
  owner: Principal;
  lead: Principal;
  admin: Principal;
  developer: Principal;
}

async function fixture(): Promise<RoomFixture> {
  const roomId = newId("room");
  const ownerId = newId("part");
  const leadId = newId("part");
  const adminId = newId("part");
  const developerId = newId("part");
  await pool.query(
    `INSERT INTO rooms (id, slug, name, objective, owner_id, lead_participant_id, settings)
     VALUES ($1, $1, 'Room', 'test', $2, $3, '{"keep":true}'::jsonb)`,
    [roomId, ownerId, leadId],
  );
  await pool.query(
    `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status)
     VALUES ($1, $5, 'HUMAN', 'Owner', 'OWNER', 'DEVELOPER', 'ACTIVE'),
            ($2, $5, 'AGENT', 'Lead', 'MEMBER', 'LEAD', 'ACTIVE'),
            ($3, $5, 'HUMAN', 'Admin', 'ADMIN', 'DEVELOPER', 'ACTIVE'),
            ($4, $5, 'AGENT', 'Developer', 'MEMBER', 'DEVELOPER', 'ACTIVE')`,
    [ownerId, leadId, adminId, developerId, roomId],
  );
  const principal = (
    participant_id: string,
    kind: Principal["kind"],
    authority: Principal["authority"],
    role: Principal["role"],
  ): Principal => ({ participant_id, room_id: roomId, kind, authority, role });
  const dispatcher = new Dispatcher({ pool, authorize, nodeId: `node-health-${++sequence}` });
  registerRoomHealthSettingsCommand(dispatcher, {
    allowedImages: ALLOWED_IMAGES,
    defaultImage: DEFAULT_IMAGE,
  });
  return {
    dispatcher,
    roomId,
    owner: principal(ownerId, "HUMAN", "OWNER", "DEVELOPER"),
    lead: principal(leadId, "AGENT", "MEMBER", "LEAD"),
    admin: principal(adminId, "HUMAN", "ADMIN", "DEVELOPER"),
    developer: principal(developerId, "AGENT", "MEMBER", "DEVELOPER"),
  };
}

const run = (
  room: RoomFixture,
  who: Principal,
  params: { health_command: string | null; health_image?: string | null },
) => room.dispatcher.dispatch(who, command(params));

describe("room.set_health", () => {
  it("lets the lead and owner set settings, preserves other values, and emits the effective pair", async () => {
    const room = await fixture();
    const saved = await run(room, room.lead, { health_command: " npm test " });
    expect(saved.response).toEqual({
      health_command: "npm test",
      health_image: DEFAULT_IMAGE,
      changed: true,
    });
    expect(saved.events[0]).toMatchObject({
      type: "room.health_settings_changed",
      payload: { health_command: "npm test", health_image: DEFAULT_IMAGE },
    });
    const updated = await run(room, room.owner, {
      health_command: "node --check main.js",
      health_image: "python:3.13",
    });
    expect(updated.response).toEqual({
      health_command: "node --check main.js",
      health_image: "python:3.13",
      changed: true,
    });

    const settings = (
      await pool.query<{ settings: Record<string, unknown> }>(
        "SELECT settings FROM rooms WHERE id = $1",
        [room.roomId],
      )
    ).rows[0]!.settings;
    expect(settings).toEqual({
      keep: true,
      health_command: "node --check main.js",
      health_image: "python:3.13",
    });
  });

  it("clears the command, resets the image to default, and treats the effective pair as a no-op", async () => {
    const room = await fixture();
    await run(room, room.owner, { health_command: "npm test", health_image: "python:3.13" });
    const reset = await run(room, room.owner, { health_command: null, health_image: null });
    expect(reset.response).toEqual({
      health_command: null,
      health_image: DEFAULT_IMAGE,
      changed: true,
    });
    expect(reset.events[0]).toMatchObject({
      type: "room.health_settings_changed",
      payload: { health_command: null, health_image: DEFAULT_IMAGE },
    });
    const noOp = await run(room, room.owner, { health_command: null });
    expect(noOp.response).toEqual({
      health_command: null,
      health_image: DEFAULT_IMAGE,
      changed: false,
    });
    expect(noOp.events).toEqual([]);
  });

  it("denies admins and developers and rejects an image outside HEALTH_IMAGES", async () => {
    const room = await fixture();
    await expect(run(room, room.admin, { health_command: "npm test" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(run(room, room.developer, { health_command: "npm test" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      run(room, room.owner, { health_command: "npm test", health_image: "node:latest" }),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      details: { reason: "health_image_not_allowed" },
    });

    const settings = (
      await pool.query<{ settings: Record<string, unknown> }>(
        "SELECT settings FROM rooms WHERE id = $1",
        [room.roomId],
      )
    ).rows[0]!.settings;
    expect(settings).toEqual({ keep: true });
  });

  it("rejects overlong commands and control characters before storing them", async () => {
    const room = await fixture();
    for (const health_command of ["x".repeat(2001), "npm test\n", "npm\ttest"]) {
      await expect(run(room, room.owner, { health_command })).rejects.toMatchObject({
        code: "VALIDATION",
      });
    }

    const settings = (
      await pool.query<{ settings: Record<string, unknown> }>(
        "SELECT settings FROM rooms WHERE id = $1",
        [room.roomId],
      )
    ).rows[0]!.settings;
    expect(settings).toEqual({ keep: true });
  });
});
