import { randomBytes } from "node:crypto";
import { createPool, type Pool } from "./index.js";
import { DEFAULT_MIGRATIONS_DIR, migrate } from "./migrate.js";

export interface TestDatabase {
  /** Pool connected to the new, fully migrated database. */
  pool: Pool;
  /** Database name, e.g. `crossover_test_1234_9f2c01ab`. */
  name: string;
  /** Close the pool and drop the database. Safe to call more than once. */
  drop(): Promise<void>;
}

export interface CreateTestDatabaseOptions {
  /** Server to create the database on; defaults to `DATABASE_URL`. */
  url?: string;
  /** Migrations to apply; defaults to `packages/db/migrations`. */
  migrationsDir?: string;
}

/**
 * Create a uniquely named database, run all migrations on it, and return a pool for it.
 * Use in every DB integration test so parallel test files never share data.
 *
 * Names are unique per call (pid + random suffix), so a database left behind by a crashed
 * test never collides with a later run.
 */
export async function createTestDatabase(
  options: CreateTestDatabaseOptions = {},
): Promise<TestDatabase> {
  const base = options.url ?? process.env["DATABASE_URL"];
  if (!base) {
    throw new Error("createTestDatabase: no url given and DATABASE_URL is not set");
  }
  const name = `crossover_test_${process.pid}_${randomBytes(4).toString("hex")}`;

  const admin = createPool(base);
  admin.on("error", () => {});
  try {
    // `name` is generated above from [a-z0-9_] only, so it is safe to interpolate.
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }

  const url = new URL(base);
  url.pathname = `/${name}`;
  const pool = createPool(url.toString());
  // Dropping the database with FORCE can kill a still-closing connection; that's expected.
  pool.on("error", () => {});
  // The pool only listens for errors on idle clients. A client that is checked out when the
  // database is dropped (an in-flight query or transaction) emits 57P01 / "Connection
  // terminated unexpectedly" with no listener, which fails the whole test run as an unhandled
  // error even though every assertion passed. The query that held it still rejects.
  pool.on("connect", (client) => client.on("error", () => {}));

  let dropped = false;
  let closing: Promise<void> | undefined;
  const drop = async (): Promise<void> => {
    if (dropped) return;
    // pool.end() waits for checked-out clients, so a test that leaks one would hang here.
    // Drop first (FORCE kills every connection), then close the pool without waiting
    // for clients that are still checked out. The pool is closed even if the DROP fails;
    // `dropped` is only set on success, so a failed drop can be retried.
    try {
      const dropper = createPool(base);
      dropper.on("error", () => {});
      try {
        await dropper.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await dropper.end();
      }
      dropped = true;
    } finally {
      closing ??= pool.end().catch(() => {});
      if (pool.totalCount === pool.idleCount) await closing;
    }
  };

  try {
    await migrate(pool, options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR);
  } catch (err) {
    await drop();
    throw err;
  }
  return { pool, name, drop };
}
