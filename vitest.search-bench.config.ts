import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    include: [
      "packages/workspace/src/search.bench.ts",
      "packages/kernel/src/modules/memory/search.bench.ts",
    ],
    testTimeout: 3_600_000,
    // The two benchmarks share one PostgreSQL server and one Zoekt port: run them one at a time.
    fileParallelism: false,
    env: {
      DATABASE_URL:
        process.env["DATABASE_URL"] ?? "postgres://crossover:crossover@localhost:5432/crossover",
    },
  },
});
