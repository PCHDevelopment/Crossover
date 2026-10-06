import { withTransaction, type Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { canonicalJson, CrossoverError, sha256Hex } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendEvents, type NewEvent } from "./append.js";

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

const ev = (n = 0, extra: Partial<NewEvent> = {}): NewEvent => ({
  actor_id: "part_1",
  type: "message.sent",
  payload: { n },
  ...extra,
});

const lastSequence = async (room: string) =>
  Number(
    (await pool.query("SELECT last_sequence FROM rooms WHERE id = $1", [room])).rows[0]
      .last_sequence,
  );

describe("appendEvents", () => {
  it("assigns last_sequence + 1…n to a batch, in order, and advances last_sequence", async () => {
    const room = await newRoom();
    const first = await withTransaction(pool, (c) => appendEvents(c, room, [ev(1), ev(2), ev(3)]));
    expect(first.map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect(first.map((e) => e.payload)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    const second = await withTransaction(pool, (c) => appendEvents(c, room, [ev(4), ev(5)]));
    expect(second.map((e) => e.sequence)).toEqual([4, 5]);
    expect(await lastSequence(room)).toBe(5);
  });

  it("returns stored events in the §19.1 shape", async () => {
    const room = await newRoom();
    const [e] = await withTransaction(pool, (c) =>
      appendEvents(c, room, [
        ev(7, { type: "task.created", causation_id: "cmd_01J", schema_version: 2 }),
      ]),
    );
    expect(e).toMatchObject({
      sequence: 1,
      room_id: room,
      actor_id: "part_1",
      type: "task.created",
      schema_version: 2,
      causation_id: "cmd_01J",
      payload: { n: 7 },
      redacted: false,
    });
    expect(new Date(e!.timestamp).toISOString()).toBe(e!.timestamp);
  });

  it("stores payload_hash = sha256 of the canonical payload, independent of key order", async () => {
    const room = await newRoom();
    const [a, b] = await withTransaction(pool, (c) =>
      appendEvents(c, room, [
        ev(0, { payload: { b: 2, a: { y: 1, x: 2 } } }),
        ev(0, { payload: { a: { x: 2, y: 1 }, b: 2 } }),
      ]),
    );
    const expected = `sha256:${sha256Hex(canonicalJson({ a: { x: 2, y: 1 }, b: 2 }))}`;
    expect(a!.payload_hash).toBe(expected);
    expect(b!.payload_hash).toBe(expected);
    const { rows } = await pool.query("SELECT payload_hash FROM events WHERE room_id = $1", [room]);
    expect(rows.map((r) => r.payload_hash)).toEqual([expected, expected]);
  });

  it("defaults payload to {}, causation_id to null and schema_version to 1", async () => {
    const room = await newRoom();
    const [e] = await withTransaction(pool, (c) =>
      appendEvents(c, room, [{ actor_id: "part_1", type: "room.created" }]),
    );
    expect(e).toMatchObject({ payload: {}, causation_id: null, schema_version: 1 });
  });

  it("returns [] for no events without touching the room", async () => {
    expect(await withTransaction(pool, (c) => appendEvents(c, "room_missing", []))).toEqual([]);
  });

  it("20 concurrent transactions appending to one room produce sequences exactly 1..20", async () => {
    const room = await newRoom();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        withTransaction(pool, async (c) => {
          const [e] = await appendEvents(c, room, [ev(i)]);
          return e!.sequence;
        }),
      ),
    );
    expect([...results].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(await lastSequence(room)).toBe(20);
    const { rows } = await pool.query(
      "SELECT sequence FROM events WHERE room_id = $1 ORDER BY sequence",
      [room],
    );
    expect(rows.map((r) => Number(r.sequence))).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
  });

  it("concurrent multi-event batches don't interleave or leave gaps", async () => {
    const room = await newRoom();
    const batches = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        withTransaction(pool, (c) => appendEvents(c, room, [ev(i), ev(i), ev(i)])),
      ),
    );
    for (const batch of batches) {
      const seqs = batch.map((e) => e.sequence);
      expect(seqs[1]).toBe(seqs[0]! + 1);
      expect(seqs[2]).toBe(seqs[0]! + 2);
    }
    const all = batches
      .flat()
      .map((e) => e.sequence)
      .sort((a, b) => a - b);
    expect(all).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
  });

  it("appends to different rooms don't block each other", async () => {
    const [a, b] = [await newRoom(), await newRoom()];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let aHasLock!: () => void;
    const aLocked = new Promise<void>((r) => (aHasLock = r));

    // Transaction A appends to room A and then holds its lock until released.
    const txA = withTransaction(pool, async (c) => {
      await appendEvents(c, a, [ev(1)]);
      aHasLock();
      await gate;
    });
    await aLocked;

    // Room B must complete while A still holds its row lock.
    const winner = await Promise.race([
      withTransaction(pool, (c) => appendEvents(c, b, [ev(2)])).then(() => "b"),
      new Promise<string>((r) => setTimeout(() => r("timeout"), 3000)),
    ]);
    expect(winner).toBe("b");

    // And a second append to room A *does* wait for A's lock.
    let secondDone = false;
    const second = withTransaction(pool, (c) => appendEvents(c, a, [ev(3)])).then((r) => {
      secondDone = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(secondDone).toBe(false);

    release();
    await txA;
    expect((await second)[0]!.sequence).toBe(2);
  });

  it("a rolled-back transaction leaves no gap", async () => {
    const room = await newRoom();
    await withTransaction(pool, (c) => appendEvents(c, room, [ev(1), ev(2)]));
    await expect(
      withTransaction(pool, async (c) => {
        await appendEvents(c, room, [ev(3), ev(4), ev(5)]);
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(await lastSequence(room)).toBe(2);
    const next = await withTransaction(pool, (c) => appendEvents(c, room, [ev(6)]));
    expect(next[0]!.sequence).toBe(3);
    const { rows } = await pool.query(
      "SELECT sequence FROM events WHERE room_id = $1 ORDER BY sequence",
      [room],
    );
    expect(rows.map((r) => Number(r.sequence))).toEqual([1, 2, 3]);
  });

  it("a failure partway through a batch rolls the whole batch back", async () => {
    const room = await newRoom();
    await expect(
      withTransaction(pool, (c) =>
        // The second payload can't be canonicalized, so nothing may be written.
        appendEvents(c, room, [ev(1), ev(2, { payload: { x: undefined } })]),
      ),
    ).rejects.toThrow(TypeError);
    expect(await lastSequence(room)).toBe(0);
    expect((await pool.query("SELECT 1 FROM events WHERE room_id = $1", [room])).rowCount).toBe(0);
  });

  it("throws NOT_FOUND for an unknown room", async () => {
    const err = await withTransaction(pool, (c) => appendEvents(c, "room_nope", [ev()])).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CrossoverError);
    expect(err).toMatchObject({ code: "NOT_FOUND", details: { room_id: "room_nope" } });
  });

  it("throws VALIDATION for an unknown event type or bad fields, before writing", async () => {
    const room = await newRoom();
    for (const bad of [
      { actor_id: "p", type: "task.exploded" },
      { actor_id: "", type: "message.sent" },
      { actor_id: "p", type: "message.sent", schema_version: 0 },
      { actor_id: "p", type: "message.sent", payload: [] },
    ]) {
      const err = await withTransaction(pool, (c) =>
        appendEvents(c, room, [ev(1), bad as unknown as NewEvent]),
      ).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: "VALIDATION", details: { index: 1 } });
    }
    expect(await lastSequence(room)).toBe(0);
  });
});
