import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { CrossoverError, newId, type RoomEvent } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { allowAll, Dispatcher, type DispatcherOptions, type UserPrincipal } from "../dispatcher.js";
import type { Principal } from "../principal.js";
import {
  insertRoomWithOwner,
  registerRoomCommands,
  roomCreatedEvents,
} from "../modules/rooms/create.js";

let db: TestDatabase;
let pool: Pool;
let counter = 0;
const user: UserPrincipal = { user_id: newId("usr"), display_name: "Branch owner" };
const nextKey = () => `spawn-${++counter}`;
const nextSlug = () => `branch-${++counter}`;

beforeAll(async () => {
  db = await createTestDatabase();
  pool = db.pool;
  await pool.query(
    "INSERT INTO users (id, display_name, provider, provider_subject) VALUES ($1, $2, 'test', $1)",
    [user.user_id, user.display_name],
  );
});

afterAll(async () => {
  await db.drop();
});

function dispatcher(options: Partial<DispatcherOptions> = {}): Dispatcher {
  const d = new Dispatcher({ pool, authorize: allowAll, nodeId: `node-${++counter}`, ...options });
  registerRoomCommands(d);
  return d;
}

async function parent(d: Dispatcher): Promise<Principal> {
  const created = await d.dispatchRoomless(user, {
    id: newId("cmd"),
    method: "room.create",
    params: { slug: nextSlug(), name: "Parent", objective: "Test child rooms" },
    idempotency_key: nextKey(),
  });
  const response = created.response as { room: { id: string }; participant: { id: string } };
  return {
    room_id: response.room.id,
    participant_id: response.participant.id,
    kind: "HUMAN",
    authority: "OWNER",
    role: "LEAD",
  };
}

const branchEnvelope = () => ({
  id: newId("cmd"),
  method: "room.branch",
  params: {},
  idempotency_key: nextKey(),
});

interface BranchOptions {
  spawnsRoom?: boolean;
  failAfterInsert?: boolean;
  foreignLease?: boolean;
  missingActor?: boolean;
  sameRoom?: boolean;
}

function registerBranch(d: Dispatcher, options: BranchOptions = {}): string[] {
  const childIds: string[] = [];
  d.registerCommand({
    method: "room.branch",
    params: z.object({}),
    mutating: true,
    spawnsRoom: options.spawnsRoom ?? true,
    execute: async (ctx) => {
      const room = {
        id: newId("room"),
        slug: nextSlug(),
        name: "Child",
        objective: "Test child rooms",
        settings: {},
      };
      childIds.push(room.id);
      const owner = await insertRoomWithOwner(ctx.client, room, user);
      if (options.failAfterInsert) throw new Error("injected after insert");
      if (options.foreignLease) {
        await ctx.client.query(
          `INSERT INTO room_leases (room_id, node_id, fencing_token, expires_at)
           VALUES ($1, 'other-node', 1, clock_timestamp() + interval '1 hour')`,
          [room.id],
        );
      }
      const childEvents = roomCreatedEvents(room, {
        participant_id: owner.participant_id,
        display_name: user.display_name,
      });
      if (options.missingActor) delete childEvents[0]!.actor_id;
      return {
        response: { room_id: room.id, owner_id: owner.participant_id },
        events: [{ type: "room.branched" as const, payload: { child_room_id: room.id } }],
        spawnRoom: {
          room_id: options.sameRoom ? ctx.room_id : room.id,
          events: childEvents,
        },
      };
    },
  });
  return childIds;
}

async function events(roomId: string): Promise<RoomEvent[]> {
  return (
    await pool.query<RoomEvent>("SELECT * FROM events WHERE room_id = $1 ORDER BY sequence", [
      roomId,
    ])
  ).rows;
}

async function lastSequence(roomId: string): Promise<number> {
  const result = await pool.query<{ last_sequence: string }>(
    "SELECT last_sequence FROM rooms WHERE id = $1",
    [roomId],
  );
  return Number(result.rows[0]!.last_sequence);
}

describe("a room command that spawns one child room", () => {
  it("commits the parent event and starts the child ledger at sequence 1 with the same causation id", async () => {
    const d = dispatcher();
    registerBranch(d);
    const principal = await parent(d);
    const before = await lastSequence(principal.room_id);
    const envelope = branchEnvelope();
    const result = await d.dispatch(principal, envelope);
    const child = result.response as { room_id: string; owner_id: string };
    const childEvents = await events(child.room_id);

    expect(result.events.map((event) => event.sequence)).toEqual([before + 1]);
    expect(childEvents.map((event) => Number(event.sequence))).toEqual([1, 2]);
    expect(childEvents.map((event) => event.causation_id)).toEqual([envelope.id, envelope.id]);
    expect(childEvents.map((event) => event.actor_id)).toEqual([child.owner_id, child.owner_id]);
    expect(await lastSequence(child.room_id)).toBe(2);
    expect(d.leases.heldRooms()).toContain(child.room_id);

    const childPrincipal: Principal = {
      room_id: child.room_id,
      participant_id: child.owner_id,
      kind: "HUMAN",
      authority: "OWNER",
      role: "LEAD",
    };
    const read = await d.dispatch(childPrincipal, {
      id: newId("cmd"),
      method: "room.get_state",
      params: {},
    });
    expect(read.response).toMatchObject({ last_sequence: 2 });
  });

  it("rolls back both rooms when execute fails after inserting the child", async () => {
    const d = dispatcher();
    const children = registerBranch(d, { failAfterInsert: true });
    const principal = await parent(d);
    const before = await lastSequence(principal.room_id);

    await expect(d.dispatch(principal, branchEnvelope())).rejects.toThrow("injected after insert");
    expect(await lastSequence(principal.room_id)).toBe(before);
    expect(await pool.query("SELECT 1 FROM rooms WHERE id = $1", [children[0]])).toMatchObject({
      rowCount: 0,
    });
    expect(d.leases.heldRooms()).not.toContain(children[0]);
  });

  it("rolls back the parent append and child row when a foreign lease blocks the child", async () => {
    const d = dispatcher();
    const children = registerBranch(d, { foreignLease: true });
    const principal = await parent(d);
    const before = await lastSequence(principal.room_id);

    await expect(d.dispatch(principal, branchEnvelope())).rejects.toMatchObject({
      code: "STALE_FENCE",
    });
    expect(await lastSequence(principal.room_id)).toBe(before);
    expect((await events(principal.room_id)).map((event) => Number(event.sequence))).toEqual([
      1, 2,
    ]);
    expect((await pool.query("SELECT 1 FROM rooms WHERE id = $1", [children[0]])).rowCount).toBe(0);
    expect(
      (await pool.query("SELECT 1 FROM room_leases WHERE room_id = $1", [children[0]])).rowCount,
    ).toBe(0);
  });

  it("replays the stored parent response without appending or publishing child events", async () => {
    const published: string[] = [];
    const d = dispatcher({ publisher: { publish: async (roomId) => void published.push(roomId) } });
    const children = registerBranch(d);
    const principal = await parent(d);
    published.length = 0;
    const envelope = branchEnvelope();
    const first = await d.dispatch(principal, envelope);
    const childId = (first.response as { room_id: string }).room_id;
    const second = await d.dispatch(principal, envelope);

    expect(second).toMatchObject({ response: first.response, replayed: true });
    expect(children).toEqual([childId]);
    expect(await lastSequence(principal.room_id)).toBe(3);
    expect(await lastSequence(childId)).toBe(2);
    expect(published).toEqual([principal.room_id, childId]);
  });

  it("rejects spawnRoom from an undeclared command and rolls its writes back", async () => {
    const d = dispatcher();
    const children = registerBranch(d, { spawnsRoom: false });
    const principal = await parent(d);
    const before = await lastSequence(principal.room_id);

    await expect(d.dispatch(principal, branchEnvelope())).rejects.toThrow(
      /returned spawnRoom without spawnsRoom/,
    );
    expect(await lastSequence(principal.room_id)).toBe(before);
    expect((await pool.query("SELECT 1 FROM rooms WHERE id = $1", [children[0]])).rowCount).toBe(0);
  });

  it("rejects a child ledger with no actor and a room spawning itself", async () => {
    for (const options of [{ missingActor: true }, { sameRoom: true }]) {
      const d = dispatcher();
      const children = registerBranch(d, options);
      const principal = await parent(d);
      const before = await lastSequence(principal.room_id);
      await expect(d.dispatch(principal, branchEnvelope())).rejects.toThrow();
      expect(await lastSequence(principal.room_id)).toBe(before);
      expect((await pool.query("SELECT 1 FROM rooms WHERE id = $1", [children[0]])).rowCount).toBe(
        0,
      );
    }
  });

  it("does not queue a spawnsRoom command for approval", async () => {
    const d = dispatcher({
      authorize: async () => {
        throw new CrossoverError("APPROVAL_REQUIRED", "Approval required");
      },
    });
    registerBranch(d);
    const principal = await parent(d);
    await expect(d.dispatch(principal, branchEnvelope())).rejects.toMatchObject({
      code: "VALIDATION",
      details: { reason: "not_approvable" },
    });
    expect(
      (await pool.query("SELECT 1 FROM approvals WHERE room_id = $1", [principal.room_id]))
        .rowCount,
    ).toBe(0);
  });

  it("keeps both ledgers committed if publishing the child fails", async () => {
    const published: string[] = [];
    const errors: string[] = [];
    let parentId = "";
    const d = dispatcher({
      publisher: {
        publish: async (roomId) => {
          published.push(roomId);
          if (roomId !== parentId) throw new Error("injected publish failure");
        },
      },
      onPublishError: (_error, info) => void errors.push(info.room_id),
    });
    registerBranch(d);
    const principal = await parent(d);
    parentId = principal.room_id;
    published.length = 0;
    errors.length = 0;

    const result = await d.dispatch(principal, branchEnvelope());
    const childId = (result.response as { room_id: string }).room_id;
    expect(published).toEqual([principal.room_id, childId]);
    expect(errors).toEqual([childId]);
    expect(await lastSequence(principal.room_id)).toBe(3);
    expect(await lastSequence(childId)).toBe(2);
  });
});
