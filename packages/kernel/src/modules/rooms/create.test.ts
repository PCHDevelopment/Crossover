import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { CrossoverError, newId, type RoomEvent } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { allowAll, Dispatcher, type UserPrincipal } from "../../dispatcher.js";
import type { EventPublisher } from "../../publisher.js";
import { registerRoomCommands, SLUG_PATTERN } from "./create.js";

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

const user = (id = `user_${++n}`): UserPrincipal => ({ user_id: id, display_name: "Peter" });
let keyN = 0;
const create = (params: Record<string, unknown>, key = `k-${++keyN}`) => ({
  id: newId("cmd"),
  method: "room.create",
  params,
  idempotency_key: key,
});
let slugN = 0;
const slug = () => `room-${++slugN}-${Date.now().toString(36)}`.slice(0, 48);
const valid = (extra: Record<string, unknown> = {}) => ({
  slug: slug(),
  name: "Crossover",
  objective: "Ship the thing",
  ...extra,
});

function dispatcher(options: Partial<ConstructorParameters<typeof Dispatcher>[0]> = {}) {
  const d = new Dispatcher({ pool, authorize: allowAll, nodeId: `node-${++n}`, ...options });
  registerRoomCommands(d);
  return d;
}

const count = async (table: string) =>
  Number((await pool.query(`SELECT count(*)::int AS c FROM ${table}`)).rows[0].c);

describe("room.create", () => {
  it("creates the room and its creator as HUMAN + OWNER + LEAD", async () => {
    const d = dispatcher();
    const u = user("user_abc");
    const params = valid({ settings: { review_required_default: true } });
    const out = await d.dispatchRoomless(u, create(params));
    const { room, participant } = out.response as {
      room: Record<string, unknown>;
      participant: Record<string, unknown>;
    };

    const roomRow = (await pool.query("SELECT * FROM rooms WHERE id = $1", [room["id"]])).rows[0];
    expect(roomRow).toMatchObject({
      slug: params.slug,
      name: "Crossover",
      objective: "Ship the thing",
      status: "ACTIVE",
      owner_id: participant["id"],
      lead_participant_id: participant["id"], // the owner leads until a lead is appointed
      settings: { review_required_default: true },
      last_sequence: "2",
    });
    const p = (await pool.query("SELECT * FROM participants WHERE id = $1", [participant["id"]]))
      .rows[0];
    expect(p).toMatchObject({
      room_id: room["id"],
      kind: "HUMAN",
      display_name: "Peter",
      authority: "OWNER",
      role: "LEAD",
      status: "ACTIVE",
      user_id: "user_abc",
    });
    expect(p.joined_at).toBeInstanceOf(Date);
    expect(out.replayed).toBe(false);
    expect(room["id"]).toMatch(/^room_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(participant["id"]).toMatch(/^part_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("puts room.created and participant.joined in the ledger at sequences 1 and 2", async () => {
    const d = dispatcher();
    const env = create(valid());
    const out = await d.dispatchRoomless(user(), env);
    const { room, participant } = out.response as {
      room: { id: string };
      participant: { id: string };
    };
    const rows = (
      await pool.query("SELECT * FROM events WHERE room_id = $1 ORDER BY sequence", [room.id])
    ).rows;
    expect(rows.map((r) => [Number(r.sequence), r.type, r.actor_id, r.causation_id])).toEqual([
      [1, "room.created", participant.id, env.id],
      [2, "participant.joined", participant.id, env.id],
    ]);
    expect(rows[0].payload).toMatchObject({ owner_id: participant.id });
    expect(rows[1].payload).toEqual({
      participant_id: participant.id,
      kind: "HUMAN",
      authority: "OWNER",
      role: "LEAD",
      display_name: "Peter",
    });
    // participant.joined never carries the platform account id (O1's rule)
    expect(JSON.stringify(rows[1].payload)).not.toContain("user_");
    expect(out.events.map((e) => e.sequence)).toEqual([1, 2]);
  });

  describe("slug", () => {
    it("a duplicate slug → VALIDATION, and nothing is left behind", async () => {
      const d = dispatcher();
      const params = valid();
      await d.dispatchRoomless(user(), create(params));
      const [rooms, participants, events, leases] = await Promise.all(
        ["rooms", "participants", "events", "room_leases"].map(count),
      );
      const err = await d.dispatchRoomless(user(), create(params)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CrossoverError);
      expect(err).toMatchObject({
        code: "VALIDATION",
        details: { slug: params.slug, reason: "slug_taken" },
      });
      expect(
        await Promise.all(["rooms", "participants", "events", "room_leases"].map(count)),
      ).toEqual([rooms, participants, events, leases]);
    });

    it("accepts 3 and 48 characters of a-z, 0-9 and -", async () => {
      const d = dispatcher();
      const id = ++slugN;
      const shortest = `a${String(id % 100).padStart(2, "0")}`; // 3 characters
      const longest = `${"x".repeat(40)}-${String(id).padStart(7, "0")}`; // 48 characters
      expect([shortest.length, longest.length]).toEqual([3, 48]);
      // The 3-character slug may already be taken by an earlier run of this loop: try a few.
      let created = false;
      for (let k = 0; k < 100 && !created; k++) {
        const candidate = `${String.fromCharCode(97 + (k % 26))}${String(k).padStart(2, "0")}`;
        created = await d.dispatchRoomless(user(), create(valid({ slug: candidate }))).then(
          () => true,
          () => false,
        );
      }
      expect(created).toBe(true);
      await d.dispatchRoomless(user(), create(valid({ slug: longest })));
      await d.dispatchRoomless(
        user(),
        create(valid({ slug: `1-2-${String(id).padStart(3, "0")}` })),
      );
    });

    it.each([
      ["too short", "ab"],
      ["empty", ""],
      ["49 characters", "x".repeat(49)],
      ["uppercase", "Room-One"],
      ["underscore", "room_one"],
      ["space", "room one"],
      ["slash", "room/one"],
      ["dot", "room.one"],
      ["unicode", "röom-one"],
      ["trailing newline", "room-one\n"],
    ])("rejects a slug that is %s", async (_label, bad) => {
      const d = dispatcher();
      const before = await count("rooms");
      await expect(d.dispatchRoomless(user(), create(valid({ slug: bad })))).rejects.toMatchObject({
        code: "VALIDATION",
      });
      expect(await count("rooms")).toBe(before);
      expect(SLUG_PATTERN.test(bad)).toBe(false);
    });
  });

  it("validates name, objective and settings", async () => {
    const d = dispatcher();
    const bad: Record<string, unknown>[] = [
      { name: "" },
      { name: "n".repeat(201) },
      { objective: "" },
      { objective: 5 },
      { settings: [] },
      { settings: "x" },
    ];
    for (const patch of bad) {
      await expect(
        d.dispatchRoomless(user(), create(valid(patch))),
        JSON.stringify(patch),
      ).rejects.toMatchObject({
        code: "VALIDATION",
      });
    }
    const missing: Record<string, unknown> = valid();
    delete missing["slug"];
    await expect(d.dispatchRoomless(user(), create(missing))).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });

  it("defaults settings to {}", async () => {
    const d = dispatcher();
    const out = await d.dispatchRoomless(user(), create(valid()));
    expect((out.response as { room: { settings: unknown } }).room.settings).toEqual({});
  });

  describe("idempotency", () => {
    it("a duplicate returns the first room and creates no second one", async () => {
      const d = dispatcher();
      const u = user();
      const env = create(valid());
      const first = await d.dispatchRoomless(u, env);
      const rooms = await count("rooms");
      const again = await d.dispatchRoomless(u, env);
      expect(again.replayed).toBe(true);
      expect(again.response).toEqual(first.response);
      expect(again.events).toEqual(first.events);
      expect(await count("rooms")).toBe(rooms);
    });

    it("the same key with different params → VALIDATION", async () => {
      const d = dispatcher();
      const u = user();
      const key = `k-${++keyN}`;
      await d.dispatchRoomless(u, create(valid(), key));
      await expect(d.dispatchRoomless(u, create(valid(), key))).rejects.toMatchObject({
        code: "VALIDATION",
      });
    });

    it("keys are per user", async () => {
      const d = dispatcher();
      const key = `shared-${++keyN}`;
      const a = await d.dispatchRoomless(user(), create(valid(), key));
      const b = await d.dispatchRoomless(user(), create(valid(), key));
      expect(a.replayed).toBe(false);
      expect(b.replayed).toBe(false);
      expect((a.response as { room: { id: string } }).room.id).not.toBe(
        (b.response as { room: { id: string } }).room.id,
      );
    });

    it("concurrent duplicates create exactly one room", async () => {
      const d = dispatcher();
      const u = user();
      const env = create(valid());
      const before = await count("rooms");
      const results = await Promise.all(
        Array.from({ length: 6 }, () => d.dispatchRoomless(u, env)),
      );
      expect(await count("rooms")).toBe(before + 1);
      expect(results.filter((r) => !r.replayed)).toHaveLength(1);
      expect(
        new Set(results.map((r) => (r.response as { room: { id: string } }).room.id)).size,
      ).toBe(1);
    });
  });

  it("concurrent creates with the same slug: exactly one wins, the rest are VALIDATION", async () => {
    const d = dispatcher();
    const params = valid();
    const before = await count("rooms");
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => d.dispatchRoomless(user(), create(params))),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((r) => r.status === "rejected")) {
      expect(r.reason).toMatchObject({ code: "VALIDATION", details: { reason: "slug_taken" } });
    }
    expect(await count("rooms")).toBe(before + 1);
  });

  describe("the new room's lease", () => {
    it("this node holds it at fencing token 1, and the room's first command works without re-acquiring", async () => {
      const d = dispatcher({ nodeId: `node-owner-${++n}` });
      d.registerCommand({
        method: "messages.send",
        action: "messages.send",
        params: z.object({ body: z.string() }),
        mutating: true,
        execute: async (_ctx, p) => ({
          response: p.body,
          events: [{ type: "message.sent" as const, payload: { body: p.body } }],
        }),
      });
      const out = await d.dispatchRoomless(user(), create(valid()));
      const { room, participant } = out.response as {
        room: { id: string };
        participant: { id: string };
      };
      expect(d.leases.heldRooms()).toContain(room.id);
      const lease = (await pool.query("SELECT * FROM room_leases WHERE room_id = $1", [room.id]))
        .rows[0];
      expect(lease).toMatchObject({ node_id: d.leases.nodeId, fencing_token: "1" });

      // The creator can act in the new room right away.
      const sent = await d.dispatch(
        {
          participant_id: participant.id,
          room_id: room.id,
          kind: "HUMAN",
          authority: "OWNER",
          role: "LEAD",
        },
        {
          id: newId("cmd"),
          method: "messages.send",
          params: { body: "hello" },
          idempotency_key: `k-${++keyN}`,
        },
      );
      expect(sent.events.map((e) => e.sequence)).toEqual([3]); // continues after 1 and 2
      const after = (
        await pool.query("SELECT fencing_token FROM room_leases WHERE room_id = $1", [room.id])
      ).rows[0];
      expect(after.fencing_token).toBe("1"); // renewed, not re-acquired
    });

    it("no lease is left behind when creation fails", async () => {
      const d = dispatcher();
      const params = valid();
      await d.dispatchRoomless(user(), create(params));
      const leases = await count("room_leases");
      await expect(d.dispatchRoomless(user(), create(params))).rejects.toBeInstanceOf(
        CrossoverError,
      );
      expect(await count("room_leases")).toBe(leases);
    });
  });

  describe("workspace provisioning hook", () => {
    it("runs inside the creating transaction, with the room and owner already inserted", async () => {
      const seen: { room: number; owner: number; sameTx: boolean }[] = [];
      const d = new Dispatcher({ pool, authorize: allowAll, nodeId: `node-${++n}` });
      registerRoomCommands(d, {
        provision: async ({ client, room_id }) => {
          const room = await client.query("SELECT 1 FROM rooms WHERE id = $1", [room_id]);
          const owner = await client.query(
            "SELECT 1 FROM participants WHERE room_id = $1 AND authority = 'OWNER'",
            [room_id],
          );
          // Not visible from another connection yet: it's inside the uncommitted transaction.
          const outside = await pool.query("SELECT 1 FROM rooms WHERE id = $1", [room_id]);
          seen.push({
            room: room.rowCount ?? 0,
            owner: owner.rowCount ?? 0,
            sameTx: outside.rowCount === 0,
          });
        },
      });
      await d.dispatchRoomless(user(), create(valid()));
      expect(seen).toEqual([{ room: 1, owner: 1, sameTx: true }]);
    });

    it("if it throws, the room, owner, lease and events are all rolled back", async () => {
      const d = new Dispatcher({ pool, authorize: allowAll, nodeId: `node-${++n}` });
      const boom = new Error("git init failed");
      registerRoomCommands(d, {
        provision: async () => {
          throw boom;
        },
      });
      const before = await Promise.all(
        ["rooms", "participants", "events", "room_leases"].map(count),
      );
      await expect(d.dispatchRoomless(user(), create(valid()))).rejects.toBe(boom);
      expect(
        await Promise.all(["rooms", "participants", "events", "room_leases"].map(count)),
      ).toEqual(before);
      expect(d.leases.heldRooms()).toEqual([]);
    });

    it("isn't called for a duplicate slug or a replay", async () => {
      let calls = 0;
      const d = new Dispatcher({ pool, authorize: allowAll, nodeId: `node-${++n}` });
      registerRoomCommands(d, { provision: async () => void calls++ });
      const params = valid();
      const u = user();
      const env = create(params);
      await d.dispatchRoomless(u, env);
      await d.dispatchRoomless(u, env); // replay
      await expect(d.dispatchRoomless(user(), create(params))).rejects.toBeInstanceOf(
        CrossoverError,
      );
      expect(calls).toBe(1);
    });
  });

  it("publishes the two events after the commit, once", async () => {
    const published: { roomId: string; events: RoomEvent[] }[] = [];
    const publisher: EventPublisher = {
      publish: async (roomId, events) => {
        // Committed: another connection can see the room.
        const visible = (await pool.query("SELECT 1 FROM rooms WHERE id = $1", [roomId])).rowCount;
        expect(visible).toBe(1);
        published.push({ roomId, events: [...events] });
      },
    };
    const d = dispatcher({ publisher });
    const u = user();
    const env = create(valid());
    const out = await d.dispatchRoomless(u, env);
    await d.dispatchRoomless(u, env); // replay: not published again
    expect(published).toHaveLength(1);
    expect(published[0]!.events.map((e) => e.type)).toEqual(["room.created", "participant.joined"]);
    expect(published[0]!.roomId).toBe((out.response as { room: { id: string } }).room.id);
  });

  it("an afterCommit callback registered by the command runs after the commit", async () => {
    const d = new Dispatcher({ pool, authorize: allowAll, nodeId: `node-${++n}` });
    d.registerRoomlessCommand({
      method: "room.create",
      params: z.object({}),
      execute: async (ctx) => {
        await ctx.client.query(
          `INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'n', 'o', 'p')`,
          [ctx.room_id],
        );
        ctx.afterCommit(async () => {
          seen =
            (await pool.query("SELECT 1 FROM rooms WHERE id = $1", [ctx.room_id])).rowCount ?? 0;
        });
        return { response: null, events: [{ type: "room.created" as const, actor_id: "system" }] };
      },
    });
    let seen = -1;
    await d.dispatchRoomless(user(), create({}));
    expect(seen).toBe(1);
  });
});

describe("roomless dispatch", () => {
  it("dispatch() of a roomless method is NOT_FOUND, and dispatchRoomless() of a room-bound one too", async () => {
    const d = dispatcher();
    d.registerCommand({
      method: "messages.send",
      params: z.object({}),
      mutating: true,
      execute: async () => ({ response: null }),
    });
    const principal = {
      participant_id: "p",
      room_id: "r",
      kind: "HUMAN",
      authority: "MEMBER",
      role: "DEVELOPER",
    } as const;
    await expect(d.dispatch(principal, create(valid()))).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      d.dispatchRoomless(user(), {
        id: newId("cmd"),
        method: "messages.send",
        params: {},
        idempotency_key: "k",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      d.dispatchRoomless(user(), {
        id: newId("cmd"),
        method: "tasks.exploded",
        params: {},
        idempotency_key: "k",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("requires a user with an id and a display name", async () => {
    const d = dispatcher();
    for (const bad of [
      undefined,
      null,
      {},
      { user_id: "", display_name: "x" },
      { user_id: "u", display_name: "" },
      { user_id: 5, display_name: "x" },
    ]) {
      await expect(
        d.dispatchRoomless(bad as unknown as UserPrincipal, create(valid())),
        JSON.stringify(bad),
      ).rejects.toMatchObject({ code: "VALIDATION" });
    }
  });

  it("requires an idempotency key (the envelope schema, since room.create is mutating)", async () => {
    const d = dispatcher();
    const noKey: Record<string, unknown> = create(valid());
    delete noKey["idempotency_key"];
    await expect(d.dispatchRoomless(user(), noKey)).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("registration is checked: catalog method, mutating, not twice, and not also room-bound", () => {
    const d = new Dispatcher({ pool, authorize: allowAll, nodeId: "n" });
    const def = { params: z.object({}), execute: async () => ({ response: null }) };
    expect(() => d.registerRoomlessCommand({ method: "room.exploded", ...def })).toThrow(/catalog/);
    expect(() => d.registerRoomlessCommand({ method: "room.get_state", ...def })).toThrow(
      /mutating/,
    );
    d.registerRoomlessCommand({ method: "room.create", ...def });
    expect(() => d.registerRoomlessCommand({ method: "room.create", ...def })).toThrow(
      /already registered/,
    );
    expect(() => d.registerCommand({ method: "room.create", mutating: true, ...def })).toThrow(
      /already registered/,
    );
  });

  it("an event without an actor_id is an error (there is no principal to default to)", async () => {
    const d = new Dispatcher({ pool, authorize: allowAll, nodeId: `node-${++n}` });
    d.registerRoomlessCommand({
      method: "room.create",
      params: z.object({}),
      execute: async (ctx) => {
        await ctx.client.query(
          `INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'n', 'o', 'p')`,
          [ctx.room_id],
        );
        return { response: null, events: [{ type: "room.created" as const }] };
      },
    });
    const before = await count("rooms");
    await expect(d.dispatchRoomless(user(), create({}))).rejects.toThrow(/need an actor_id/);
    expect(await count("rooms")).toBe(before);
  });
});
