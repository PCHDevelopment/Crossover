import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    include: ["packages/workspace/src/workspace.bench.ts"],
    testTimeout: 3_600_000,
    env: {
      DATABASE_URL:
        process.env["DATABASE_URL"] ?? "postgres://crossover:crossover@localhost:5432/crossover",
    },
  },
});
