import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, withTransaction, type Pool } from "./index.js";

const URL =
  process.env["DATABASE_URL"] ?? "postgres://crossover:crossover@localhost:5432/crossover";
const TABLE = `t101_${process.pid}_${Date.now()}`;

let pool: Pool;

beforeAll(async () => {
  pool = createPool(URL);
  await pool.query(`CREATE TABLE ${TABLE} (id int PRIMARY KEY, v text)`);
});

afterAll(async () => {
  await pool.query(`DROP TABLE IF EXISTS ${TABLE}`);
  await pool.end();
});

describe("createPool", () => {
  it("reads DATABASE_URL when no URL is given", async () => {
    const prev = process.env["DATABASE_URL"];
    process.env["DATABASE_URL"] = URL;
    const p = createPool();
    try {
      expect((await p.query("SELECT 1 AS one")).rows[0]).toEqual({ one: 1 });
    } finally {
      await p.end();
      if (prev === undefined) delete process.env["DATABASE_URL"];
      else process.env["DATABASE_URL"] = prev;
    }
  });

  it("throws when there is no URL at all", () => {
    const prev = process.env["DATABASE_URL"];
    delete process.env["DATABASE_URL"];
    try {
      expect(() => createPool()).toThrow(/DATABASE_URL/);
    } finally {
      if (prev !== undefined) process.env["DATABASE_URL"] = prev;
    }
  });
});

describe("withTransaction", () => {
  it("commits on success and returns fn's result", async () => {
    const out = await withTransaction(pool, async (c) => {
      await c.query(`INSERT INTO ${TABLE} VALUES (1, 'a')`);
      return "done";
    });
    expect(out).toBe("done");
    const { rows } = await pool.query(`SELECT v FROM ${TABLE} WHERE id = 1`);
    expect(rows).toEqual([{ v: "a" }]);
  });

  it("rolls back and rethrows the original error when fn throws", async () => {
    const boom = new Error("boom");
    await expect(
      withTransaction(pool, async (c) => {
        await c.query(`INSERT INTO ${TABLE} VALUES (2, 'b')`);
        throw boom;
      }),
    ).rejects.toBe(boom);
    const { rows } = await pool.query(`SELECT 1 FROM ${TABLE} WHERE id = 2`);
    expect(rows).toHaveLength(0);
  });

  it("rethrows a SQL error from fn and leaves nothing committed", async () => {
    await expect(
      withTransaction(pool, async (c) => {
        await c.query(`INSERT INTO ${TABLE} VALUES (3, 'c')`);
        await c.query(`INSERT INTO ${TABLE} VALUES (3, 'dup')`);
      }),
    ).rejects.toMatchObject({ code: "23505" });
    const { rows } = await pool.query(`SELECT 1 FROM ${TABLE} WHERE id = 3`);
    expect(rows).toHaveLength(0);
  });

  it("always releases the client, on success and on error", async () => {
    // max=1: a leaked client would make the next call hang.
    const one = new pg.Pool({ connectionString: URL, max: 1 });
    try {
      await withTransaction(one, async () => undefined);
      await expect(
        withTransaction(one, async () => {
          throw new Error("x");
        }),
      ).rejects.toThrow("x");
      expect(one.idleCount).toBe(1);
      expect(one.totalCount - one.idleCount).toBe(0);
      // Pool still usable and the connection is not stuck in a transaction.
      const { rows } = await one.query("SELECT txid_current_if_assigned() AS x");
      expect(rows).toHaveLength(1);
    } finally {
      await one.end();
    }
  });
});
