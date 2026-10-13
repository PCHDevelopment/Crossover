import type { PoolClient } from "@crossover/db";
import { describe, expect, it } from "vitest";
import { authorize } from "./authorize.js";

/**
 * What one command costs in authorization (T1509): reading the facts and asking the policy. The
 * database is a stand-in that answers the two lookups from memory, so the number is this code's
 * own cost, not the runner's load; a real round trip to a local Postgres adds about 0.2 ms each.
 * Reads, a grant-covered write and a refusal all go through it.
 */
const client = {
  query: async (sql: string) =>
    sql.includes("FROM participants")
      ? {
          rows: [
            { authority: "MEMBER", role: "DEVELOPER", status: "ACTIVE", room_status: "ACTIVE" },
          ],
        }
      : {
          rows: [
            {
              id: "grant_1",
              effect: "GRANT",
              capability: "memory.write:notes/**",
              requires_approval: false,
              expires_at: null,
            },
          ],
        },
} as unknown as PoolClient;

const call = (action: string, path?: string) =>
  authorize(
    { participant_id: "part_1", room_id: "room_1" },
    action,
    { room_id: "room_1", ...(path === undefined ? {} : { path }) },
    { method: "tasks.list", params: {}, client },
  );

describe("authorization cost per command", () => {
  it("stays under 1 ms at the 99th percentile, facts included", async () => {
    const rounds = 3000;
    const durations: number[] = [];
    for (let i = 0; i < 200; i++) await call("tasks.read"); // warm up the module and the JIT
    for (let i = 0; i < rounds; i++) {
      const kind = i % 3;
      const started = performance.now();
      if (kind === 0) await call("tasks.read");
      else if (kind === 1) await call("workspace.write", "src/a.ts");
      else await call("capabilities.grant").catch(() => undefined); // a refusal costs the same
      durations.push(performance.now() - started);
    }
    durations.sort((a, b) => a - b);
    const p99 = durations[Math.floor(rounds * 0.99)]!;
    expect(p99).toBeLessThan(1);
  });
});
