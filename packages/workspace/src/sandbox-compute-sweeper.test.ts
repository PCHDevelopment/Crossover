import type { Pool } from "@crossover/db";
import { describe, expect, it, vi } from "vitest";
import type { SandboxComputeBudgetMeter } from "./sandbox-compute-budget.js";
import { SandboxComputeSweeper } from "./sandbox-compute-sweeper.js";

const sampleAt = new Date("2026-10-13T04:00:00Z");

function sandboxRow(id = "sandbox-1") {
  return {
    id,
    room_id: "room-1",
    participant_id: "participant-1",
    status: "RUNNING" as const,
    limits: { disk_enforcement: "soft" as const },
    base_revision: "12",
    volume_ref: `volume:${id}`,
    container_ref: `container:${id}`,
    last_active_at: sampleAt,
    updated_at: sampleAt,
  };
}

describe("SandboxComputeSweeper", () => {
  it("samples running sandboxes, hibernates capped owners, and sweeps expired reservations", async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [sandboxRow()] }),
    } as unknown as Pool;
    const meter = {
      sample: vi.fn().mockResolvedValue(25n),
      isLimitReached: vi.fn().mockResolvedValue(true),
      sweepExpired: vi.fn().mockResolvedValue(0),
    } as unknown as SandboxComputeBudgetMeter;
    const readCpuUsage = vi.fn().mockResolvedValue({
      usage_usec: 125n,
      generation: "container-start-1",
    });
    const hibernate = vi.fn().mockResolvedValue(true);
    const sweeper = new SandboxComputeSweeper({
      pool,
      meter,
      readCpuUsage,
      hibernate,
      now: () => sampleAt,
    });

    await expect(sweeper.sweep(sampleAt)).resolves.toBe(1);

    expect(readCpuUsage).toHaveBeenCalledWith({
      ...sandboxRow(),
      base_revision: 12,
    });
    expect(meter.sample).toHaveBeenCalledWith({
      room_id: "room-1",
      participant_id: "participant-1",
      sandbox_id: "sandbox-1",
      usage_usec: 125n,
      generation: "container-start-1",
      sampled_at: sampleAt,
    });
    expect(hibernate).toHaveBeenCalledWith("room-1", "participant-1");
    expect(meter.sweepExpired).toHaveBeenCalledWith(sampleAt);
  });

  it("wraps the batch cursor back to the first page", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [sandboxRow()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [sandboxRow()] });
    const pool = { query } as unknown as Pool;
    const meter = {
      sample: vi.fn().mockResolvedValue(0n),
      isLimitReached: vi.fn().mockResolvedValue(false),
      sweepExpired: vi.fn().mockResolvedValue(0),
    } as unknown as SandboxComputeBudgetMeter;
    const sweeper = new SandboxComputeSweeper({
      pool,
      meter,
      readCpuUsage: vi.fn().mockResolvedValue({ usage_usec: 0n, generation: "start-1" }),
      hibernate: vi.fn(),
      now: () => sampleAt,
    });

    await sweeper.sweep(sampleAt);
    await expect(sweeper.sweep(sampleAt)).resolves.toBe(1);

    expect(query).toHaveBeenNthCalledWith(2, expect.any(String), [100, "sandbox-1"]);
    expect(query).toHaveBeenNthCalledWith(3, expect.any(String), [100, null]);
  });
});
