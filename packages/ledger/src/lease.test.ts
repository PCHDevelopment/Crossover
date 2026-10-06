import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { CrossoverError } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acquireLease, getLease, releaseLease, renewLease } from "./lease.js";

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

/** Make the current lease expire right now, without waiting for the clock. */
const expire = (room: string) =>
  pool.query(
    "UPDATE room_leases SET expires_at = clock_timestamp() - interval '1 second' WHERE room_id = $1",
    [room],
  );

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("acquireLease", () => {
  it("grants a fresh room's lease at fencing token 1 with the default 15 s ttl", async () => {
    const room = await newRoom();
    const before = Date.now();
    const lease = await acquireLease(pool, room, "node-a");
    expect(lease).toMatchObject({ room_id: room, node_id: "node-a", fencing_token: 1 });
    const ttl = lease!.expires_at.getTime() - before;
    expect(ttl).toBeGreaterThan(14_000);
    expect(ttl).toBeLessThanOrEqual(15_500);
    expect(await getLease(pool, room)).toEqual(lease);
  });

  it("a second node cannot acquire an unexpired lease", async () => {
    const room = await newRoom();
    const a = await acquireLease(pool, room, "node-a");
    expect(await acquireLease(pool, room, "node-b")).toBeNull();
    expect(await getLease(pool, room)).toEqual(a); // untouched
  });

  it("the current holder can't re-acquire an unexpired lease either (it renews)", async () => {
    const room = await newRoom();
    await acquireLease(pool, room, "node-a");
    expect(await acquireLease(pool, room, "node-a")).toBeNull();
  });

  it("takeover after expiry returns a strictly larger fencing token", async () => {
    const room = await newRoom();
    const a = await acquireLease(pool, room, "node-a");
    await expire(room);
    const b = await acquireLease(pool, room, "node-b");
    expect(b).toMatchObject({ node_id: "node-b" });
    expect(b!.fencing_token).toBeGreaterThan(a!.fencing_token);
    expect(b!.fencing_token).toBe(2);
    await expire(room);
    expect((await acquireLease(pool, room, "node-a"))!.fencing_token).toBe(3);
  });

  it("expires by the real clock too", async () => {
    const room = await newRoom();
    await acquireLease(pool, room, "node-a", 400);
    expect(await acquireLease(pool, room, "node-b")).toBeNull();
    await sleep(600);
    expect((await acquireLease(pool, room, "node-b"))!.fencing_token).toBe(2);
  });

  it("racing: of 10 nodes acquiring a fresh room, exactly one wins", async () => {
    const room = await newRoom();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => acquireLease(pool, room, `node-${i}`)),
    );
    const winners = results.filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.fencing_token).toBe(1);
    expect((await getLease(pool, room))!.node_id).toBe(winners[0]!.node_id);
  });

  it("racing: of 10 nodes taking over an expired lease, exactly one wins and the token moves once", async () => {
    const room = await newRoom();
    await acquireLease(pool, room, "old");
    await expire(room);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => acquireLease(pool, room, `node-${i}`)),
    );
    const winners = results.filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.fencing_token).toBe(2);
  });

  it("leases are per room", async () => {
    const [a, b] = [await newRoom(), await newRoom()];
    expect(await acquireLease(pool, a, "node-1")).not.toBeNull();
    expect(await acquireLease(pool, b, "node-2")).not.toBeNull();
  });

  it("works on a transaction client", async () => {
    const room = await newRoom();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      expect(await acquireLease(client, room, "node-a")).not.toBeNull();
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    expect(await getLease(pool, room)).toBeNull();
  });

  it("throws NOT_FOUND for an unknown room", async () => {
    const err = await acquireLease(pool, "room_missing", "node-a").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CrossoverError);
    expect(err).toMatchObject({ code: "NOT_FOUND" });
  });

  it("throws VALIDATION for a bad ttl or empty node id", async () => {
    const room = await newRoom();
    for (const ttl of [0, -5, 1.5, NaN]) {
      await expect(acquireLease(pool, room, "n", ttl)).rejects.toMatchObject({
        code: "VALIDATION",
      });
    }
    await expect(acquireLease(pool, room, "")).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await getLease(pool, room)).toBeNull();
  });
});

describe("renewLease", () => {
  it("extends the holder's lease and keeps the token", async () => {
    const room = await newRoom();
    const lease = await acquireLease(pool, room, "node-a", 1000);
    const renewed = await renewLease(pool, room, "node-a", lease!.fencing_token, 60_000);
    expect(renewed.fencing_token).toBe(lease!.fencing_token);
    expect(renewed.expires_at.getTime()).toBeGreaterThan(lease!.expires_at.getTime() + 50_000);
    expect(await getLease(pool, room)).toEqual(renewed);
  });

  it("fails for a non-holder", async () => {
    const room = await newRoom();
    const lease = await acquireLease(pool, room, "node-a");
    const err = await renewLease(pool, room, "node-b", lease!.fencing_token).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CrossoverError);
    expect(err).toMatchObject({
      code: "STALE_FENCE",
      details: { room_id: room, node_id: "node-b" },
    });
    expect(await getLease(pool, room)).toEqual(lease); // unchanged
  });

  it("fails for the holder with the wrong token", async () => {
    const room = await newRoom();
    const lease = await acquireLease(pool, room, "node-a");
    await expect(renewLease(pool, room, "node-a", lease!.fencing_token + 1)).rejects.toMatchObject({
      code: "STALE_FENCE",
    });
  });

  it("fails once the lease has expired, even if nobody took over", async () => {
    const room = await newRoom();
    const lease = await acquireLease(pool, room, "node-a");
    await expire(room);
    await expect(renewLease(pool, room, "node-a", lease!.fencing_token)).rejects.toMatchObject({
      code: "STALE_FENCE",
    });
  });

  it("fails for a former holder after takeover", async () => {
    const room = await newRoom();
    const a = await acquireLease(pool, room, "node-a");
    await expire(room);
    await acquireLease(pool, room, "node-b");
    await expect(renewLease(pool, room, "node-a", a!.fencing_token)).rejects.toMatchObject({
      code: "STALE_FENCE",
    });
  });

  it("fails for a room that was never leased", async () => {
    const room = await newRoom();
    await expect(renewLease(pool, room, "node-a", 1)).rejects.toMatchObject({
      code: "STALE_FENCE",
    });
  });

  it("keeps a lease alive across renewals", async () => {
    const room = await newRoom();
    const lease = await acquireLease(pool, room, "node-a", 60_000);
    // Deterministic: compare stored expiries instead of racing short real-clock TTLs.
    let previous = (await getLease(pool, room))!.expires_at.getTime();
    for (let i = 0; i < 3; i++) {
      await sleep(15);
      await renewLease(pool, room, "node-a", lease!.fencing_token, 60_000);
      const next = (await getLease(pool, room))!.expires_at.getTime();
      expect(next).toBeGreaterThan(previous);
      previous = next;
    }
    expect(await acquireLease(pool, room, "node-b")).toBeNull();
  });
});

describe("releaseLease", () => {
  it("lets another node take over immediately, with a larger token", async () => {
    const room = await newRoom();
    const a = await acquireLease(pool, room, "node-a");
    expect(await releaseLease(pool, room, "node-a", a!.fencing_token)).toBe(true);
    const b = await acquireLease(pool, room, "node-b");
    expect(b!.fencing_token).toBe(a!.fencing_token + 1);
  });

  it("keeps the row so the token never resets", async () => {
    const room = await newRoom();
    const a = await acquireLease(pool, room, "node-a");
    await releaseLease(pool, room, "node-a", a!.fencing_token);
    expect((await getLease(pool, room))!.fencing_token).toBe(a!.fencing_token);
    expect((await acquireLease(pool, room, "node-a"))!.fencing_token).toBe(2);
  });

  it("does nothing, and returns false, for a non-holder or a stale token", async () => {
    const room = await newRoom();
    const a = await acquireLease(pool, room, "node-a");
    expect(await releaseLease(pool, room, "node-b", a!.fencing_token)).toBe(false);
    expect(await releaseLease(pool, room, "node-a", a!.fencing_token + 1)).toBe(false);
    expect(await acquireLease(pool, room, "node-b")).toBeNull(); // still held by node-a
  });

  it("returns false when releasing twice or after expiry", async () => {
    const room = await newRoom();
    const a = await acquireLease(pool, room, "node-a");
    expect(await releaseLease(pool, room, "node-a", a!.fencing_token)).toBe(true);
    expect(await releaseLease(pool, room, "node-a", a!.fencing_token)).toBe(false);
    expect(await releaseLease(pool, "room_never", "node-a", 1)).toBe(false);
  });

  it("a released holder can't renew", async () => {
    const room = await newRoom();
    const a = await acquireLease(pool, room, "node-a");
    await releaseLease(pool, room, "node-a", a!.fencing_token);
    await expect(renewLease(pool, room, "node-a", a!.fencing_token)).rejects.toMatchObject({
      code: "STALE_FENCE",
    });
  });
});

describe("room_leases table", () => {
  it("rejects a fencing token below 1 and a lease for a missing room", async () => {
    const room = await newRoom();
    await expect(
      pool.query("INSERT INTO room_leases VALUES ($1, 'n', 0, now())", [room]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query("INSERT INTO room_leases VALUES ('room_missing2', 'n', 1, now())"),
    ).rejects.toMatchObject({ code: "23503" });
  });
});
