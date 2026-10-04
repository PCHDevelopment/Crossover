import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["{packages,apps}/*/src/**/*.test.ts"],
    env: {
      // Same default as .env.example / docker-compose; CI overrides it.
      DATABASE_URL:
        process.env["DATABASE_URL"] ?? "postgres://crossover:crossover@localhost:5432/crossover",
    },
  },
});
