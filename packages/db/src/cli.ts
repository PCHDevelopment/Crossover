import { createPool, type Pool } from "./index.js";
import { migrate } from "./migrate.js";

let pool: Pool | undefined;
try {
  pool = createPool();
  const applied = await migrate(pool);
  console.error(applied.length ? `Applied: ${applied.join(", ")}` : "No pending migrations");
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await pool?.end();
}
