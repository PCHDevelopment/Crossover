import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { acquireLease, getLease } from "@crossover/ledger";
import { newId } from "@crossover/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { RoomActorRegistry } from "./actor.js";
import { allowAll, Dispatcher } from "./dispatcher.js";
import { LeaseRenewer } from "./lease-renewer.js";
import { RoomLeases } from "./leases.js";

let db: TestDatabase;
let pool: Pool;
let counter = 0;

beforeAll(async () => {
  db = await createTestDatabase();
  pool = db.pool;
});

afterAll(async () => {
  await db.drop();
});

afterEach(() => {
  vi.useRealTimers();
});

async function newRoom(): Promise<string> {
  const id = `room_${++counter}`;
  await pool.query(
    `INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'n', 'o', 'part_1')`,
    [id],
  );
  return id;
}

const expires = async (room: string) => (await getLease(pool, room))!.expires_at.getTime();
const expire = (room: string) =>
  pool.query(
    "UPDATE room_leases SET expires_at = clock_timestamp() - interval '1 second' WHERE room_id = $1",
    [room],
  );

function node(ttlMs = 60_000, onAcquire?: (room: string) => void | Promise<void>) {
  const leases = new RoomLeases(pool, `node-${++counter}`, ttlMs, onAcquire ? { onAcquire } : {});
  const actors = new RoomActorRegistry();
  return { leases, actors };
}

describe("RoomLeases.renew", () => {
  it("extends a held lease without changing its fencing token", async () => {
    const room = await newRoom();
    const { leases } = node();
    const token = await leases.ensure(room);
    const before = await expires(room);
    await new Promise((r) => setTimeout(r, 15));
    expect(await leases.renew(room)).toBe(true);
    expect(await expires(room)).toBeGreaterThan(before);
    expect((await getLease(pool, room))!.fencing_token).toBe(token);
  });

  it("returns false for a room that isn't held, and touches nothing", async () => {
    const room = await newRoom();
    const { leases } = node();
    expect(await leases.renew(room)).toBe(false);
    expect(await getLease(pool, room)).toBeNull();
  });

  it("forgets a room whose lease another node took, and leaves the new owner alone", async () => {
    const room = await newRoom();
    const a = node();
    await a.leases.ensure(room);
    await expire(room);
    const taken = await acquireLease(pool, room, "other-node", 60_000);
    expect(await a.leases.renew(room)).toBe(false);
    expect(a.leases.heldRooms()).toEqual([]);
    expect((await getLease(pool, room))!.node_id).toBe("other-node");
    expect((await getLease(pool, room))!.fencing_token).toBe(taken!.fencing_token);
  });

  it("propagates other errors and keeps the room held", async () => {
    const room = await newRoom();
    const { leases } = node();
    await leases.ensure(room);
    await pool.query("ALTER TABLE room_leases RENAME TO room_leases_x");
    try {
      await expect(leases.renew(room)).rejects.toThrow();
    } finally {
      await pool.query("ALTER TABLE room_leases_x RENAME TO room_leases");
    }
    expect(leases.heldRooms()).toEqual([room]);
    expect(await leases.renew(room)).toBe(true);
  });
});

describe("onAcquire", () => {
  it("runs once when a lease is first acquired, not on later renewals", async () => {
    const room = await newRoom();
    const seen: string[] = [];
    const { leases } = node(60_000, (r) => void seen.push(r));
    await leases.ensure(room);
    await leases.ensure(room);
    await leases.renew(room);
    expect(seen).toEqual([room]);
  });

  it("runs before the lease is remembered, and again after a lapse and takeover", async () => {
    const room = await newRoom();
    const seen: { room: string; held: string[] }[] = [];
    const hooked = new RoomLeases(pool, "hooked", 60_000, {
      onAcquire: (r) => void seen.push({ room: r, held: hooked.heldRooms() }),
    });
    await hooked.ensure(room);
    expect(seen).toEqual([{ room, held: [] }]); // not yet held while the hook runs
    await expire(room);
    await acquireLease(pool, room, "other", 60_000);
    await expire(room); // other lapses too
    await hooked.ensure(room);
    expect(seen).toHaveLength(2);
  });

  it("a failing hook releases the lease, activates nothing and surfaces the error", async () => {
    const room = await newRoom();
    const hook = vi.fn().mockRejectedValueOnce(new Error("reconcile failed"));
    const { leases } = node(60_000, hook);
    await expect(leases.ensure(room)).rejects.toThrow("reconcile failed");
    expect(leases.heldRooms()).toEqual([]);
    // Released, so another node can take over at once.
    expect(await acquireLease(pool, room, "other", 60_000)).not.toBeNull();
    await expire(room);
    // Retry succeeds (the mock only fails once) and the hook ran again.
    expect(await leases.ensure(room)).toBeGreaterThan(0);
    expect(hook).toHaveBeenCalledTimes(2);
  });

  it("isn't called for a room being created (acquireFor/adopt)", async () => {
    const room = await newRoom();
    const hook = vi.fn();
    const { leases } = node(60_000, hook);
    leases.adopt(room, await leases.acquireFor(pool, room));
    expect(hook).not.toHaveBeenCalled();
  });
});

describe("LeaseRenewer", () => {
  it("renews an idle held room before it expires, keeping its fencing token", async () => {
    const room = await newRoom();
    const { leases, actors } = node(1000);
    const token = await leases.ensure(room);
    const renewer = new LeaseRenewer({ leases, actors });
    // Make the lease nearly expired, as if the room had been idle for most of its TTL.
    await pool.query(
      "UPDATE room_leases SET expires_at = clock_timestamp() + interval '100 milliseconds' WHERE room_id = $1",
      [room],
    );
    const before = await expires(room);
    await renewer.tick();
    expect(await expires(room)).toBeGreaterThan(before + 500);
    expect((await getLease(pool, room))!.fencing_token).toBe(token);
    expect(leases.heldRooms()).toEqual([room]);
    // Another node still can't take it.
    expect(await acquireLease(pool, room, "other")).toBeNull();
  });

  it("start() ticks every third of the TTL by default and stop() ends it", async () => {
    vi.useFakeTimers();
    const { leases, actors } = node(3000);
    const renewer = new LeaseRenewer({ leases, actors });
    const tick = vi.spyOn(renewer, "tick").mockResolvedValue();
    renewer.start();
    renewer.start(); // idempotent
    await vi.advanceTimersByTimeAsync(999);
    expect(tick).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(tick).toHaveBeenCalledTimes(3);
    await renewer.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tick).toHaveBeenCalledTimes(3);
  });

  it("drops a room taken over by another node on the next tick and drains its actor", async () => {
    const room = await newRoom();
    const kept = await newRoom();
    const { leases, actors } = node(60_000);
    await leases.ensure(room);
    await leases.ensure(kept);
    actors.get(room);
    await expire(room);
    await acquireLease(pool, room, "other", 60_000);
    const lost: string[] = [];
    const renewer = new LeaseRenewer({ leases, actors, onLost: (r) => void lost.push(r) });
    await renewer.tick();
    expect(leases.heldRooms()).toEqual([kept]);
    expect(lost).toEqual([room]);
    expect(actors.has(room)).toBe(false);
    expect((await getLease(pool, room))!.node_id).toBe("other");
  });

  it("lets jobs already queued for a lost room finish before draining it", async () => {
    const room = await newRoom();
    const { leases, actors } = node(60_000);
    await leases.ensure(room);
    await expire(room);
    await acquireLease(pool, room, "other", 60_000);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const queued = actors.get(room).submit(async () => {
      await gate;
      return "done";
    });
    const renewer = new LeaseRenewer({ leases, actors });
    const ticking = renewer.tick();
    await new Promise((r) => setTimeout(r, 20));
    expect(actors.has(room)).toBe(true); // renewal and drain are queued behind the job
    release();
    expect(await queued).toBe("done");
    await ticking;
    expect(actors.has(room)).toBe(false);
  });

  it("reports an unexpected failure, keeps the room held and keeps going", async () => {
    const a = await newRoom();
    const b = await newRoom();
    const { leases, actors } = node(60_000);
    await leases.ensure(a);
    await leases.ensure(b);
    const real = leases.renew.bind(leases);
    vi.spyOn(leases, "renew").mockImplementation(async (r) => {
      if (r === a) throw new Error("db down");
      return real(r);
    });
    const errors: [unknown, string][] = [];
    const renewer = new LeaseRenewer({ leases, actors, onError: (e, r) => errors.push([e, r]) });
    const before = await expires(b);
    await new Promise((r) => setTimeout(r, 15));
    await renewer.tick();
    expect(errors).toHaveLength(1);
    expect(errors[0]![1]).toBe(a);
    expect(leases.heldRooms().sort()).toEqual([a, b].sort());
    expect(await expires(b)).toBeGreaterThan(before);
  });

  it("doesn't overlap ticks", async () => {
    const room = await newRoom();
    const { leases, actors } = node(60_000);
    await leases.ensure(room);
    const spy = vi.spyOn(leases, "renew");
    const renewer = new LeaseRenewer({ leases, actors });
    await Promise.all([renewer.tick(), renewer.tick(), renewer.tick()]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("close() releases every lease so another node acquires immediately, with a larger token", async () => {
    const rooms = [await newRoom(), await newRoom()];
    const { leases, actors } = node(60_000);
    const tokens = await Promise.all(rooms.map((r) => leases.ensure(r)));
    const renewer = new LeaseRenewer({ leases, actors });
    renewer.start();
    await renewer.close();
    expect(leases.heldRooms()).toEqual([]);
    for (const [i, room] of rooms.entries()) {
      const lease = await acquireLease(pool, room, "other");
      expect(lease!.fencing_token).toBe(tokens[i]! + 1);
    }
  });

  it("stop() does not wait behind actor work, and close() still releases the lease", async () => {
    const room = await newRoom();
    const { leases, actors } = node(60_000);
    const token = await leases.ensure(room);
    const renew = vi.spyOn(leases, "renew");
    const actor = actors.get(room);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const started = new Promise<void>((resolve) => (entered = resolve));
    const blocker = actor.submit(async () => {
      entered();
      await gate;
    });
    await started;

    const renewer = new LeaseRenewer({ leases, actors });
    const ticking = renewer.tick();
    expect(actor.pending).toBe(2);

    try {
      const stoppedPromptly = await Promise.race([
        renewer.stop().then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
      ]);
      expect(stoppedPromptly).toBe(true);

      await renewer.close();
      expect(leases.heldRooms()).toEqual([]);
      const taken = await acquireLease(pool, room, "other");
      expect(taken!.fencing_token).toBe(token + 1);
    } finally {
      release();
      await Promise.all([blocker, ticking]);
      await renewer.close();
    }

    expect(renew).not.toHaveBeenCalled();
    expect((await getLease(pool, room))!.node_id).toBe("other");
  });

  it("rejects a nonsensical interval", () => {
    const { leases, actors } = node();
    expect(() => new LeaseRenewer({ leases, actors, intervalMs: 0 })).toThrow(TypeError);
  });

  it("a command that already lost the lease doesn't make the renewer throw", async () => {
    const room = await newRoom();
    const { leases, actors } = node(60_000);
    await leases.ensure(room);
    leases.forget(room); // as the dispatcher does on STALE_FENCE
    const renewer = new LeaseRenewer({ leases, actors });
    await expect(renewer.tick()).resolves.toBeUndefined();
  });
});

describe("Dispatcher onLeaseAcquire", () => {
  it("runs before a room's first command, and a failure keeps the command from running", async () => {
    const room = await newRoom();
    const hook = vi.fn().mockRejectedValueOnce(new Error("reconcile failed"));
    const d = new Dispatcher({
      pool,
      authorize: allowAll,
      nodeId: `node-${++counter}`,
      onLeaseAcquire: hook,
    });
    const ran = vi.fn(async () => ({ response: { ok: true } }));
    d.registerCommand({
      method: "tasks.create",
      mutating: true,
      params: z.object({}),
      execute: ran,
    });
    const principal = {
      participant_id: "part_1",
      room_id: room,
      kind: "HUMAN" as const,
      authority: "OWNER" as const,
      role: "LEAD" as const,
    };
    const envelope = () => ({
      id: newId("cmd"),
      method: "tasks.create",
      params: {},
      idempotency_key: `k-${++counter}`,
    });
    await expect(d.dispatch(principal, envelope())).rejects.toThrow("reconcile failed");
    expect(ran).not.toHaveBeenCalled();
    await d.dispatch(principal, envelope());
    expect(ran).toHaveBeenCalledOnce();
    expect(hook).toHaveBeenCalledTimes(2);
  });
});
