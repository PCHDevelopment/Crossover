import { createPool } from "@crossover/db";
import { HashEmbeddingProvider, MemoryEmbeddingIndexer } from "@crossover/kernel";
import { loadConfig } from "./config.js";

/** Rebuild one room or all rooms without printing memory keys or values. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const one = args.length === 2 && args[0] === "--room" && Boolean(args[1]);
  const all = args.length === 1 && args[0] === "--all";
  if (!one && !all) throw new Error("Usage: rebuild-memory-index --room <room_id> | --all");
  const config = loadConfig();
  if (config.memorySearchProvider !== "local-hash")
    throw new Error("MEMORY_SEARCH_PROVIDER must be local-hash to rebuild");
  const pool = createPool(config.databaseUrl);
  const indexer = new MemoryEmbeddingIndexer({ pool, provider: new HashEmbeddingProvider() });
  try {
    const rooms = one
      ? [args[1]!]
      : (
          await pool.query<{ id: string }>(
            "SELECT id FROM rooms WHERE purge_started_at IS NULL ORDER BY id",
          )
        ).rows.map((row) => row.id);
    process.stdout.write(`rooms: ${rooms.length}\n`);
    for (const room of rooms) {
      try {
        await indexer.rebuild(room);
        process.stdout.write(`${room}: ok\n`);
      } catch (error) {
        const code =
          error && typeof error === "object" && "code" in error && typeof error.code === "string"
            ? error.code
            : "REBUILD_FAILED";
        process.stdout.write(`${room}: failed: ${code}\n`);
        process.exitCode = 1;
      }
    }
  } finally {
    await indexer.close();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "REBUILD_FAILED");
  process.exitCode = 1;
});
