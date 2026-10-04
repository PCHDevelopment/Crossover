import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { listMigrations, migrate, type Pool } from "./index.js";
import { createTestDatabase, type TestDatabase } from "./testing.js";

let db: TestDatabase;
let pool: Pool;
let dir: string;

beforeAll(async () => {
  db = await createTestDatabase();
  pool = db.pool;
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "migrations-"));
  await pool.query("DROP TABLE IF EXISTS schema_migrations, m_a, m_b, m_c");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const write = (name: string, sql: string) => writeFile(join(dir, name), sql);
const versions = async () =>
  (await pool.query("SELECT version, name FROM schema_migrations ORDER BY version")).rows;

describe("migrate", () => {
  it("applies files in order and records them", async () => {
    await write("0002_b.sql", "CREATE TABLE m_b (id int)");
    await write("0001_a.sql", "CREATE TABLE m_a (id int)");
    expect(await migrate(pool, dir)).toEqual(["0001_a.sql", "0002_b.sql"]);
    expect(await versions()).toEqual([
      { version: 1, name: "a" },
      { version: 2, name: "b" },
    ]);
    const { rows } = await pool.query("SELECT applied_at FROM schema_migrations LIMIT 1");
    expect(rows[0].applied_at).toBeInstanceOf(Date);
  });

  it("applies nothing the second time", async () => {
    await write("0001_a.sql", "CREATE TABLE m_a (id int)");
    await migrate(pool, dir);
    expect(await migrate(pool, dir)).toEqual([]);
    expect(await versions()).toHaveLength(1);
  });

  it("applies only files added since the last run", async () => {
    await write("0001_a.sql", "CREATE TABLE m_a (id int)");
    await migrate(pool, dir);
    await write("0002_b.sql", "CREATE TABLE m_b (id int)");
    expect(await migrate(pool, dir)).toEqual(["0002_b.sql"]);
  });

  it("rolls a failing migration back fully, does not record it, and skips later files", async () => {
    await write("0001_a.sql", "CREATE TABLE m_a (id int)");
    await write("0002_b.sql", "CREATE TABLE m_b (id int); SELECT 1/0;");
    await write("0003_c.sql", "CREATE TABLE m_c (id int)");
    await expect(migrate(pool, dir)).rejects.toThrow(/0002_b\.sql failed.*division by zero/);
    expect(await versions()).toEqual([{ version: 1, name: "a" }]);
    const { rows } = await pool.query(
      "SELECT to_regclass('m_a') AS a, to_regclass('m_b') AS b, to_regclass('m_c') AS c",
    );
    expect(rows[0]).toEqual({ a: "m_a", b: null, c: null });
  });

  it("rejects bad filenames with a clear error before applying anything", async () => {
    await write("0001_a.sql", "CREATE TABLE m_a (id int)");
    for (const bad of ["1_a.sql", "0002_Bad.sql", "0002-b.sql", "0002_b.txt", "0002_.sql"]) {
      await write(bad, "SELECT 1");
      await expect(migrate(pool, dir)).rejects.toThrow(
        new RegExp(`Invalid migration filename "${bad}"`),
      );
      await rm(join(dir, bad));
    }
    expect(await pool.query("SELECT to_regclass('m_a') AS a")).toMatchObject({
      rows: [{ a: null }],
    });
  });

  it("rejects duplicate version numbers", async () => {
    await write("0001_a.sql", "SELECT 1");
    await write("0001_b.sql", "SELECT 1");
    await expect(listMigrations(dir)).rejects.toThrow(/Duplicate migration version 0001/);
  });

  it("ignores dotfiles such as .gitkeep", async () => {
    await write(".gitkeep", "");
    await write("0001_a.sql", "CREATE TABLE m_a (id int)");
    expect(await migrate(pool, dir)).toEqual(["0001_a.sql"]);
  });

  it("concurrent runners apply each migration exactly once", async () => {
    await write("0001_a.sql", "CREATE TABLE m_a (id int)");
    await write("0002_b.sql", "CREATE TABLE m_b (id int)");
    const results = await Promise.all([migrate(pool, dir), migrate(pool, dir), migrate(pool, dir)]);
    expect(results.flat().sort()).toEqual(["0001_a.sql", "0002_b.sql"]);
    expect(await versions()).toHaveLength(2);
  });

  it("the default directory exists and lists cleanly", async () => {
    await expect(listMigrations()).resolves.toBeInstanceOf(Array);
  });
});
