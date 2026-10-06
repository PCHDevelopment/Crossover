import { withTransaction, type Pool, type PoolClient } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { CrossoverError } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashRequest, purgeIdempotencyKeys, withIdempotency } from "./idempotency.js";

let db: TestDatabase;
let pool: Pool;
let n = 0;

beforeAll(async () => {
  db = await createTestDatabase();
  pool = db.pool;
  await pool.query("CREATE TABLE side_effects (id serial PRIMARY KEY, tag text NOT NULL)");
});

afterAll(async () => {
  await db.drop();
});

const uniq = (prefix: string) => `${prefix}-${++n}`;
const effects = async (tag: string) =>
  (await pool.query("SELECT 1 FROM side_effects WHERE tag = $1", [tag])).rowCount;

const run = <T>(
  participant: string,
  key: string,
  hash: string,
  fn: (client: PoolClient) => Promise<T>,
) => withTransaction(pool, (c) => withIdempotency(c, participant, key, hash, fn));

describe("withIdempotency", () => {
  it("runs fn the first time and returns its response", async () => {
    const key = uniq("k");
    const out = await run("p1", key, "h", async () => ({ ok: true, items: [1, 2] }));
    expect(out).toEqual({ ok: true, items: [1, 2] });
    const { rows } = await pool.query(
      "SELECT request_hash, response FROM idempotency_keys WHERE participant_id = 'p1' AND idempotency_key = $1",
      [key],
    );
    expect(rows).toEqual([{ request_hash: "h", response: { ok: true, items: [1, 2] } }]);
  });

  it("a duplicate returns the original response without running fn", async () => {
    const key = uniq("k");
    const tag = uniq("t");
    let calls = 0;
    const fn = async (c: PoolClient) => {
      calls++;
      await c.query("INSERT INTO side_effects (tag) VALUES ($1)", [tag]);
      return { call: calls };
    };
    const first = await run("p1", key, "h", fn);
    const second = await run("p1", key, "h", fn);
    const third = await run("p1", key, "h", fn);
    expect(calls).toBe(1);
    expect(second).toEqual(first);
    expect(third).toEqual({ call: 1 });
    expect(await effects(tag)).toBe(1);
  });

  it("returns the same stored (canonical JSON) form on first and duplicate calls", async () => {
    const key = uniq("k");
    const fn = async () => ({ z: [1, { b: 2, a: 1 }], n: -0, s: "é" });
    const first = await run("p1", key, "h", fn);
    const second = await run("p1", key, "h", fn);
    expect(first).toEqual({ z: [1, { a: 1, b: 2 }], n: 0, s: "é" });
    expect(second).toEqual(first);
  });

  it("rejects a response that isn't plain JSON data, such as a Date", async () => {
    await expect(run("p1", uniq("k"), "h", async () => ({ at: new Date() }))).rejects.toThrow(
      TypeError,
    );
  });

  it("can store a null response (and doesn't mistake it for 'in progress')", async () => {
    const key = uniq("k");
    let calls = 0;
    const fn = async () => {
      calls++;
      return null;
    };
    expect(await run("p1", key, "h", fn)).toBeNull();
    expect(await run("p1", key, "h", fn)).toBeNull();
    expect(calls).toBe(1);
  });

  it("same key with a different request hash throws VALIDATION and doesn't run fn", async () => {
    const key = uniq("k");
    await run("p1", key, "hash-a", async () => "a");
    let ran = false;
    const err = await run("p1", key, "hash-b", async () => {
      ran = true;
      return "b";
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CrossoverError);
    expect(err).toMatchObject({ code: "VALIDATION", details: { idempotency_key: key } });
    expect(ran).toBe(false);
    expect(await run("p1", key, "hash-a", async () => "never")).toBe("a"); // original intact
  });

  it("keys are per participant", async () => {
    const key = uniq("k");
    expect(await run("p1", key, "h", async () => "one")).toBe("one");
    expect(await run("p2", key, "h", async () => "two")).toBe("two");
    expect(await run("p1", key, "h", async () => "x")).toBe("one");
  });

  it("concurrent duplicates: fn runs exactly once (racing test)", async () => {
    const key = uniq("k");
    const tag = uniq("t");
    let calls = 0;
    const fn = async (c: PoolClient) => {
      calls++;
      await new Promise((r) => setTimeout(r, 100)); // keep the first transaction open
      await c.query("INSERT INTO side_effects (tag) VALUES ($1)", [tag]);
      return { winner: calls };
    };
    const results = await Promise.all(Array.from({ length: 10 }, () => run("p1", key, "h", fn)));
    expect(calls).toBe(1);
    expect(await effects(tag)).toBe(1);
    expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1);
    expect(results[0]).toEqual({ winner: 1 });
  });

  it("concurrent requests with the same key but different hashes: one runs, the rest are rejected", async () => {
    const key = uniq("k");
    let calls = 0;
    const results = await Promise.allSettled(
      ["a", "b", "c", "d"].map((h) =>
        run("p1", key, h, async () => {
          calls++;
          await new Promise((r) => setTimeout(r, 50));
          return h;
        }),
      ),
    );
    expect(calls).toBe(1);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((r) => r.status === "rejected")) {
      expect(r.reason).toMatchObject({ code: "VALIDATION" });
    }
  });

  it("different keys run concurrently without blocking each other", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const aStarted = new Promise<void>((r) => (started = r));
    const a = run("p1", uniq("k"), "h", async () => {
      started();
      await gate;
      return "a";
    });
    await aStarted;
    const winner = await Promise.race([
      run("p1", uniq("k"), "h", async () => "b"),
      new Promise((r) => setTimeout(() => r("timeout"), 3000)),
    ]);
    expect(winner).toBe("b");
    release();
    expect(await a).toBe("a");
  });

  it("if fn throws, its writes and the key are rolled back, and a retry runs fn again", async () => {
    const key = uniq("k");
    const tag = uniq("t");
    const boom = new Error("boom");
    await expect(
      withTransaction(pool, async (c) => {
        await withIdempotency(c, "p1", key, "h", async () => {
          await c.query("INSERT INTO side_effects (tag) VALUES ($1)", [tag]);
          throw boom;
        }).catch((e: unknown) => {
          expect(e).toBe(boom);
        });
        // The caller swallows the error and commits: nothing from fn may survive.
      }),
    ).resolves.toBeUndefined();
    expect(await effects(tag)).toBe(0);
    expect(
      (await pool.query("SELECT 1 FROM idempotency_keys WHERE idempotency_key = $1", [key]))
        .rowCount,
    ).toBe(0);
    expect(await run("p1", key, "h", async () => "second try")).toBe("second try");
  });

  it("a non-JSON result is rejected and rolls fn back", async () => {
    const key = uniq("k");
    const tag = uniq("t");
    await withTransaction(pool, async (c) => {
      await expect(
        withIdempotency(c, "p1", key, "h", async () => {
          await c.query("INSERT INTO side_effects (tag) VALUES ($1)", [tag]);
          return undefined;
        }),
      ).rejects.toThrow(TypeError);
    });
    expect(await effects(tag)).toBe(0);
    expect(await run("p1", key, "h", async () => "ok")).toBe("ok");
  });

  it("remembers nothing if the caller's transaction rolls back", async () => {
    const key = uniq("k");
    await expect(
      withTransaction(pool, async (c) => {
        await withIdempotency(c, "p1", key, "h", async () => "first");
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(await run("p1", key, "h", async () => "second")).toBe("second");
  });

  it("a second use of a key inside the same transaction reports 'in progress'", async () => {
    const key = uniq("k");
    await withTransaction(pool, async (c) => {
      await withIdempotency(c, "p1", key, "h", async () => {
        const err = await withIdempotency(c, "p1", key, "h", async () => "inner").catch(
          (e: unknown) => e,
        );
        expect(err).toMatchObject({ code: "VALIDATION" });
        expect((err as Error).message).toMatch(/in progress/);
        return "outer";
      });
    });
  });

  it("treats a key older than 24 h as new", async () => {
    const key = uniq("k");
    await run("p1", key, "old", async () => "old response");
    await pool.query(
      "UPDATE idempotency_keys SET created_at = now() - interval '25 hours' WHERE idempotency_key = $1",
      [key],
    );
    // Even a different request hash is fine: the old entry is gone as far as callers can tell.
    expect(await run("p1", key, "new", async () => "new response")).toBe("new response");
    expect(await run("p1", key, "new", async () => "x")).toBe("new response");
  });

  it("keeps a key younger than 24 h", async () => {
    const key = uniq("k");
    await run("p1", key, "h", async () => "kept");
    await pool.query(
      "UPDATE idempotency_keys SET created_at = now() - interval '23 hours' WHERE idempotency_key = $1",
      [key],
    );
    expect(await run("p1", key, "h", async () => "x")).toBe("kept");
  });

  it("rejects bad participant, key length and empty request hash", async () => {
    const fn = async () => "x";
    await expect(run("", "k", "h", fn)).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(run("p1", "", "h", fn)).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(run("p1", "k".repeat(129), "h", fn)).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(run("p1", "k", "", fn)).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await run("p1", uniq("k") + "x".repeat(100), "h", fn)).toBe("x"); // < 128 is fine
    expect(await run("p1", "k".repeat(128), "h", fn)).toBe("x"); // exactly 128 is fine
  });
});

describe("withIdempotency error handling", () => {
  it("rethrows fn's original error even if rolling back to the savepoint fails", async () => {
    const original = new Error("fn failed");
    const calls: string[] = [];
    // A client whose connection dies as soon as we try to roll back.
    const broken = {
      query: async (sql: string) => {
        calls.push(sql.split(/\s+/)[0] ?? "");
        if (sql.startsWith("ROLLBACK")) throw new Error("connection lost");
        return { rowCount: 1, rows: [] };
      },
    } as unknown as PoolClient;
    const err = await withIdempotency(broken, "p1", "k", "h", async () => {
      throw original;
    }).catch((e: unknown) => e);
    expect(err).toBe(original);
    expect(calls).toContain("ROLLBACK");
  });
});

describe("purgeIdempotencyKeys", () => {
  it("removes rows older than 24 h and keeps newer ones, returning the count", async () => {
    const [oldA, oldB, fresh] = [uniq("purge-old"), uniq("purge-old"), uniq("purge-new")];
    for (const k of [oldA, oldB, fresh]) await run("pp", k, "h", async () => k);
    await pool.query(
      "UPDATE idempotency_keys SET created_at = now() - interval '25 hours' WHERE idempotency_key = ANY($1)",
      [[oldA, oldB]],
    );
    await pool.query(
      "UPDATE idempotency_keys SET created_at = now() - interval '23 hours' WHERE idempotency_key = $1",
      [fresh],
    );
    const removed = await purgeIdempotencyKeys(pool);
    expect(removed).toBeGreaterThanOrEqual(2);
    const { rows } = await pool.query(
      "SELECT idempotency_key FROM idempotency_keys WHERE participant_id = 'pp' ORDER BY 1",
    );
    expect(rows.map((r) => r.idempotency_key)).toEqual([fresh]);
    expect(await purgeIdempotencyKeys(pool)).toBe(0);
  });
});

describe("hashRequest", () => {
  it("is stable across key order and differs for different requests", () => {
    const a = hashRequest({ method: "tasks.claim", params: { task_id: "t", expected_version: 3 } });
    const b = hashRequest({ params: { expected_version: 3, task_id: "t" }, method: "tasks.claim" });
    const c = hashRequest({ method: "tasks.claim", params: { task_id: "t", expected_version: 4 } });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("idempotency_keys table", () => {
  it("rejects over-long and empty keys at the database too", async () => {
    for (const key of ["", "k".repeat(129)]) {
      await expect(
        pool.query(
          "INSERT INTO idempotency_keys (participant_id, idempotency_key, request_hash) VALUES ('p', $1, 'h')",
          [key],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    }
  });
});
