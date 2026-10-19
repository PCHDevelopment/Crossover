import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ConflictMetricsReporter } from "./conflict-metrics-reporter.js";

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
});

describe("ConflictMetricsReporter", () => {
  it("writes one conflict_rate_report line per tick", async () => {
    const lines: string[] = [];
    const reporter = new ConflictMetricsReporter({
      pool: db.pool,
      now: () => new Date("2026-10-19T00:00:00Z"),
      write: (line) => void lines.push(line),
    });
    expect(await reporter.tick()).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.endsWith("\n")).toBe(true);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      msg: "conflict_rate_report",
      report_version: 1,
      since: "2026-10-12T00:00:00.000Z",
      until: "2026-10-19T00:00:00.000Z",
    });
    expect(await reporter.tick()).toBe(true);
    expect(lines).toHaveLength(2);
  });

  it("writes nothing when another holder has the advisory lock", async () => {
    const lines: string[] = [];
    const reporter = new ConflictMetricsReporter({
      pool: db.pool,
      write: (line) => void lines.push(line),
    });
    const holder = await db.pool.connect();
    try {
      await holder.query("SELECT pg_advisory_lock(hashtext('crossover.conflict_rate_report'))");
      expect(await reporter.tick()).toBe(false);
      expect(lines).toEqual([]);
    } finally {
      await holder.query("SELECT pg_advisory_unlock(hashtext('crossover.conflict_rate_report'))");
      holder.release();
    }
    expect(await reporter.tick()).toBe(true);
    expect(lines).toHaveLength(1);
  });

  it("rejects an interval Node's timers cannot hold (it would fire every millisecond)", () => {
    for (const intervalMs of [0, -1, 2_147_483_648, 2_592_000_000, 1.5])
      expect(
        () => new ConflictMetricsReporter({ pool: db.pool, intervalMs }),
        String(intervalMs),
      ).toThrow(RangeError);
    expect(
      () => new ConflictMetricsReporter({ pool: db.pool, intervalMs: 2_147_483_647 }),
    ).not.toThrow();
  });

  it("stop() clears the timer", async () => {
    vi.useFakeTimers();
    try {
      const lines: string[] = [];
      const reporter = new ConflictMetricsReporter({
        pool: db.pool,
        intervalMs: 1_000,
        write: (line) => void lines.push(line),
      });
      reporter.start();
      await reporter.stop();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(lines).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
