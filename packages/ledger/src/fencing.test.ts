import { withTransaction, type Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { CrossoverError } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendEvents, type NewEvent } from "./append.js";
import { acquireLease, releaseLease, renewLease } from "./lease.js";

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

async function newRoom(): Promise<string> {
  const id = `room_${++counter}`;
  await pool.query(
    `INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'n', 'o', 'part_1')`,
    [id],
  );
  return id;
}

const ev = (n = 0): NewEvent => ({ actor_id: "part_1", type: "message.sent", payload: { n } });

const append = (room: string, token: number, events: NewEvent[] = [ev()]) =>
  withTransaction(pool, (c) => appendEvents(c, room, events, token));

const expire = (room: string) =>
  pool.query(
    "UPDATE room_leases SET expires_at = clock_timestamp() - interval '1 second' WHERE room_id = $1",
    [room],
  );

const state = async (room: string) => ({
  last: Number(
    (await pool.query("SELECT last_sequence FROM rooms WHERE id = $1", [room])).rows[0]
      .last_sequence,
  ),
  events: (await pool.query("SELECT 1 FROM events WHERE room_id = $1", [room])).rowCount,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("appendEvents fencing", () => {
  it("accepts a write with the current lease's token", async () => {
    const room = await newRoom();
    const lease = await acquireLease(pool, room, "node-a");
    const [e] = await append(room, lease!.fencing_token);
    expect(e!.sequence).toBe(1);
  });

  it("a writer holding an old token after takeover is rejected and writes nothing", async () => {
    const room = await newRoom();
    const a = await acquireLease(pool, room, "node-a");
    await append(room, a!.fencing_token, [ev(1)]);
    await expire(room);
    const b = await acquireLease(pool, room, "node-b");
    expect(b!.fencing_token).toBeGreaterThan(a!.fencing_token);

    const err = await append(room, a!.fencing_token, [ev(2), ev(3)]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CrossoverError);
    expect(err).toMatchObject({
      code: "STALE_FENCE",
      details: {
        room_id: room,
        fencing_token: a!.fencing_token,
        current_token: b!.fencing_token,
        lease_live: true,
      },
    });
    expect(await state(room)).toEqual({ last: 1, events: 1 }); // nothing written

    // The new owner continues the sequence with no gap.
    const [e] = await append(room, b!.fencing_token, [ev(4)]);
    expect(e!.sequence).toBe(2);
  });

  it("rejects a token from the future", async () => {
    const room = await newRoom();
    const lease = await acquireLease(pool, room, "node-a");
    await expect(append(room, lease!.fencing_token + 1)).rejects.toMatchObject({
      code: "STALE_FENCE",
    });
    expect(await state(room)).toEqual({ last: 0, events: 0 });
  });

  it("rejects writes to a room that was never leased", async () => {
    const room = await newRoom();
    await expect(append(room, 1)).rejects.toMatchObject({
      code: "STALE_FENCE",
      details: { current_token: null, lease_live: false },
    });
    expect(await state(room)).toEqual({ last: 0, events: 0 });
  });

  it("rejects the holder's own token once its lease has expired, even if nobody took over", async () => {
    const room = await newRoom();
    const lease = await acquireLease(pool, room, "node-a");
    await expire(room);
    await expect(append(room, lease!.fencing_token)).rejects.toMatchObject({
      code: "STALE_FENCE",
      details: { lease_live: false, current_token: lease!.fencing_token },
    });
    expect(await state(room)).toEqual({ last: 0, events: 0 });
  });

  it("accepts writes again after the holder renews", async () => {
    const room = await newRoom();
    const lease = await acquireLease(pool, room, "node-a", 5_000);
    await renewLease(pool, room, "node-a", lease!.fencing_token, 60_000);
    await append(room, lease!.fencing_token);
  });

  it("rejects writes after the lease is released", async () => {
    const room = await newRoom();
    const lease = await acquireLease(pool, room, "node-a");
    await releaseLease(pool, room, "node-a", lease!.fencing_token);
    await expect(append(room, lease!.fencing_token)).rejects.toMatchObject({
      code: "STALE_FENCE",
    });
  });

  it("checks the token before inserting anything from a multi-event batch", async () => {
    const room = await newRoom();
    const a = await acquireLease(pool, room, "node-a");
    await expire(room);
    await acquireLease(pool, room, "node-b");
    await expect(append(room, a!.fencing_token, [ev(1), ev(2), ev(3)])).rejects.toMatchObject({
      code: "STALE_FENCE",
    });
    expect(await state(room)).toEqual({ last: 0, events: 0 });
  });

  it("a takeover can't commit between the fence check and the write: it waits for the writer", async () => {
    const room = await newRoom();
    const a = await acquireLease(pool, room, "node-a", 400);

    const order: string[] = [];
    let passedCheck!: () => void;
    const checked = new Promise<void>((r) => (passedCheck = r));

    // Node A's transaction passes the fence check while its lease is still live, then stays
    // open past the lease's expiry before committing.
    const writer = withTransaction(pool, async (c) => {
      const stored = await appendEvents(c, room, [ev(1)], a!.fencing_token);
      passedCheck();
      await sleep(700); // the lease expires while this transaction is open
      order.push("a-commit");
      return stored;
    });
    await checked;
    await sleep(500); // now expired

    // Node B takes over. Without the FOR SHARE lock on the lease row it would succeed
    // immediately and A's write would land after the takeover.
    const takeover = acquireLease(pool, room, "node-b").then((lease) => {
      order.push("b-acquired");
      return lease;
    });

    const [stored, b] = await Promise.all([writer, takeover]);
    expect(order).toEqual(["a-commit", "b-acquired"]);
    expect(stored[0]!.sequence).toBe(1);
    expect(b!.fencing_token).toBe(a!.fencing_token + 1);

    // After the takeover A's token is dead, and B's writes continue the sequence.
    await expect(append(room, a!.fencing_token)).rejects.toMatchObject({ code: "STALE_FENCE" });
    expect((await append(room, b!.fencing_token))[0]!.sequence).toBe(2);
  });

  it("validates the token argument", async () => {
    const room = await newRoom();
    for (const bad of [0, -1, 1.5, NaN]) {
      await expect(append(room, bad)).rejects.toMatchObject({ code: "VALIDATION" });
    }
  });

  it("still reports an unknown room as NOT_FOUND", async () => {
    await expect(append("room_missing", 1)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("serializes with renewals without deadlocking", async () => {
    const room = await newRoom();
    const lease = await acquireLease(pool, room, "node-a", 10_000);
    const work = Array.from({ length: 10 }, (_, i) => [
      append(room, lease!.fencing_token, [ev(i)]),
      renewLease(pool, room, "node-a", lease!.fencing_token, 10_000),
    ]).flat();
    await Promise.all(work);
    expect((await state(room)).last).toBe(10);
  });
});
