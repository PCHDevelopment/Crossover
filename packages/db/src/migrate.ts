import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { withTransaction, type Pool } from "./index.js";

/** Default location: `packages/db/migrations`, resolved from both `src/` and `dist/`. */
export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

const FILENAME_RE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

/** Arbitrary constant: transaction-scoped advisory lock serializing concurrent runners. */
const MIGRATE_LOCK_KEY = 7_281_001;

export interface MigrationFile {
  version: number;
  name: string;
  filename: string;
}

/**
 * List migration files in order. Any entry (other than dotfiles) whose name is not
 * `NNNN_name.sql` is rejected, as are duplicate version numbers.
 */
export async function listMigrations(
  dir: string = DEFAULT_MIGRATIONS_DIR,
): Promise<MigrationFile[]> {
  const entries = await readdir(dir);
  const files: MigrationFile[] = [];
  for (const filename of entries.filter((f) => !f.startsWith(".")).sort()) {
    const m = FILENAME_RE.exec(filename);
    if (!m) {
      throw new Error(
        `Invalid migration filename "${filename}" in ${dir}: expected NNNN_name.sql matching ${FILENAME_RE.source}`,
      );
    }
    const version = Number(m[1]);
    const previous = files[files.length - 1];
    if (previous && previous.version === version) {
      throw new Error(
        `Duplicate migration version ${m[1]}: "${previous.filename}" and "${filename}"`,
      );
    }
    files.push({ version, name: m[2]!, filename });
  }
  return files;
}

/**
 * Apply pending migrations in order, each in its own transaction, recording it in
 * `schema_migrations`. Returns the filenames applied by this call. A failing
 * migration rolls back fully, is not recorded, and stops the run.
 */
export async function migrate(pool: Pool, dir: string = DEFAULT_MIGRATIONS_DIR): Promise<string[]> {
  // Validate every filename before touching the database.
  const files = await listMigrations(dir);

  // Under the lock too: concurrent first runs would otherwise race on CREATE TABLE.
  await withTransaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATE_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    integer PRIMARY KEY,
        name       text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
  });

  const applied: string[] = [];
  for (const file of files) {
    const sql = await readFile(join(dir, file.filename), "utf8");
    const didApply = await withTransaction(pool, async (client) => {
      // Serialize concurrent runners, then re-check inside the lock.
      await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATE_LOCK_KEY]);
      const done = await client.query("SELECT 1 FROM schema_migrations WHERE version = $1", [
        file.version,
      ]);
      if (done.rowCount) return false;
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version, name) VALUES ($1, $2)", [
          file.version,
          file.name,
        ]);
      } catch (err) {
        throw new Error(`Migration ${file.filename} failed: ${(err as Error).message}`, {
          cause: err,
        });
      }
      return true;
    });
    if (didApply) applied.push(file.filename);
  }
  return applied;
}
