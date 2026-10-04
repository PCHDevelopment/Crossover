import pg from "pg";

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

/**
 * Create a PostgreSQL pool. Falls back to `DATABASE_URL` when `url` is omitted.
 */
export function createPool(url?: string): Pool {
  const connectionString = url ?? process.env["DATABASE_URL"];
  if (!connectionString) {
    throw new Error("createPool: no connection URL given and DATABASE_URL is not set");
  }
  return new pg.Pool({ connectionString });
}

/**
 * Run `fn` inside `BEGIN … COMMIT` on a dedicated client. If `fn` throws, the
 * transaction is rolled back and the original error is rethrown. The client is
 * always released (§19.2: every mutation is one transaction).
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  // Set when the connection state is unknown; it is then destroyed, not reused.
  let discard = false;
  try {
    try {
      await client.query("BEGIN");
    } catch (err) {
      discard = true;
      throw err;
    }
    let result: T;
    try {
      result = await fn(client);
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        discard = true; // the original error is what the caller needs to see
      }
      throw err;
    }
    try {
      await client.query("COMMIT");
    } catch (err) {
      discard = true;
      throw err;
    }
    return result;
  } finally {
    client.release(discard ? true : undefined);
  }
}
