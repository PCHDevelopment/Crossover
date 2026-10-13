import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPool } from "./index.js";
import { createTestDatabase, type TestDatabase } from "./testing.js";

const URL =
  process.env["DATABASE_URL"] ?? "postgres://crossover:crossover@localhost:5432/crossover";

const open: TestDatabase[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((d) => d.drop()));
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function create(migrations: Record<string, string> = {}): Promise<TestDatabase> {
  const dir = await mkdtemp(join(tmpdir(), "t103-"));
  dirs.push(dir);
  for (const [file, sql] of Object.entries(migrations)) await writeFile(join(dir, file), sql);
  const db = await createTestDatabase({ url: URL, migrationsDir: dir });
  open.push(db);
  return db;
}

async function emptyDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "t103-"));
  dirs.push(dir);
  return dir;
}

async function exists(name: string): Promise<boolean> {
  const admin = createPool(URL);
  try {
    const { rowCount } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    return rowCount === 1;
  } finally {
    await admin.end();
  }
}

describe("createTestDatabase", () => {
  it("returns a migrated database", async () => {
    const db = await create({ "0001_t.sql": "CREATE TABLE t (id int)" });
    const { rows } = await db.pool.query("SELECT version FROM schema_migrations");
    expect(rows).toEqual([{ version: 1 }]);
    await db.pool.query("INSERT INTO t VALUES (1)");
  });

  it("runs the repository's real migrations by default", async () => {
    const db = await createTestDatabase({ url: URL });
    open.push(db);
    const { rows } = await db.pool.query("SELECT to_regclass('schema_migrations') AS t");
    expect(rows[0].t).toBe("schema_migrations");
  });

  it("databases created in parallel don't see each other's data", async () => {
    const dbs = await Promise.all(
      Array.from({ length: 4 }, () => create({ "0001_t.sql": "CREATE TABLE t (who text)" })),
    );
    await Promise.all(dbs.map((d, i) => d.pool.query("INSERT INTO t VALUES ($1)", [`db${i}`])));
    for (const [i, d] of dbs.entries()) {
      const { rows } = await d.pool.query("SELECT who FROM t");
      expect(rows).toEqual([{ who: `db${i}` }]);
    }
    expect(new Set(dbs.map((d) => d.name)).size).toBe(4);
  });

  it("drop() removes the database and is idempotent", async () => {
    const db = await create();
    expect(await exists(db.name)).toBe(true);
    await db.drop();
    expect(await exists(db.name)).toBe(false);
    await db.drop();
  });

  it("drop() works while a client still holds a connection", async () => {
    const db = await create();
    const client = await db.pool.connect();
    client.on("error", () => {}); // the forced drop kills this connection
    await client.query("SELECT 1");
    await db.drop();
    expect(await exists(db.name)).toBe(false);
    client.release(true);
  });

  it("a client killed by the drop mid-query doesn't raise an unhandled error (T1520)", async () => {
    const db = await create();
    // No error listener: the pool leaves checked-out clients without one, and this is the case
    // that failed whole test files with "Connection terminated unexpectedly" after every
    // assertion had passed.
    const client = await db.pool.connect();
    const running = client.query("SELECT pg_sleep(30)").then(
      () => undefined,
      (error: unknown) => error,
    );
    await new Promise((resolve) => setTimeout(resolve, 100)); // let the query reach the server
    await db.drop();
    expect(await running).toMatchObject({ code: "57P01" }); // the query itself still fails
    expect(client.listenerCount("error")).toBeGreaterThan(0);
    client.release(true);
  });

  it("a database left behind doesn't break later runs", async () => {
    const leaked = await create({ "0001_t.sql": "CREATE TABLE t (id int)" });
    const next = await create({ "0001_t.sql": "CREATE TABLE t (id int)" });
    expect(next.name).not.toBe(leaked.name);
    expect(await exists(leaked.name)).toBe(true);
  });

  it("closes the pool when the DROP fails, and a retry can still drop the database", async () => {
    // A role that owns the test database can drop it; once ownership moves away it can't.
    const role = `t103_role_${process.pid}`;
    const admin = createPool(URL);
    const limited = new globalThis.URL(URL);
    limited.username = role;
    limited.password = "pw";
    let db: TestDatabase | undefined;
    try {
      await admin.query(`CREATE ROLE ${role} LOGIN CREATEDB PASSWORD 'pw'`);
      db = await createTestDatabase({ url: limited.toString(), migrationsDir: await emptyDir() });
      const { current_user: owner } = (await admin.query("SELECT current_user")).rows[0];
      await admin.query(`ALTER DATABASE ${db.name} OWNER TO ${owner}`);

      await expect(db.drop()).rejects.toThrow(/must be owner/);
      expect(db.pool.ended).toBe(true); // closed despite the failure
      expect(await exists(db.name)).toBe(true);

      await admin.query(`ALTER DATABASE ${db.name} OWNER TO ${role}`);
      await db.drop(); // not a no-op: the first attempt didn't count
      expect(await exists(db.name)).toBe(false);
    } finally {
      if (db) await admin.query(`DROP DATABASE IF EXISTS ${db.name} WITH (FORCE)`);
      await admin.query(`DROP ROLE IF EXISTS ${role}`);
      await admin.end();
    }
  });

  it("drops the database and rethrows when a migration fails", async () => {
    const before = await listTestDbs();
    await expect(create({ "0001_bad.sql": "SELECT 1/0" })).rejects.toThrow(/division by zero/);
    expect(await listTestDbs()).toEqual(before);
  });
});

async function listTestDbs(): Promise<string[]> {
  const admin = createPool(URL);
  try {
    const { rows } = await admin.query(
      `SELECT datname FROM pg_database WHERE datname LIKE $1 ORDER BY 1`,
      [`crossover_test_${process.pid}_%`],
    );
    return rows.map((r) => r.datname);
  } finally {
    await admin.end();
  }
}
