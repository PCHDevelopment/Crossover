import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["{packages,apps}/*/src/**/*.test.ts"],
    setupFiles: ["./vitest.policy-setup.mjs"],
    env: {
      // Same default as .env.example / docker-compose; CI overrides it.
      DATABASE_URL:
        process.env["DATABASE_URL"] ?? "postgres://crossover:crossover@localhost:5432/crossover",
      REDIS_URL: process.env["REDIS_URL"] ?? "redis://localhost:6379",
    },
  },
});
