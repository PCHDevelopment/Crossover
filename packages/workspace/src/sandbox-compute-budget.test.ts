import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { newId } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SandboxComputeBudgetMeter } from "./sandbox-compute-budget.js";

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
});

async function fixture(settings: Record<string, unknown> = {}) {
  const roomId = newId("room");
  const ownerId = newId("part");
  const participantId = newId("part");
  const sandboxId = newId("sandbox");
  await db.pool.query(
    `INSERT INTO rooms (id, slug, name, objective, owner_id, settings)
     VALUES ($1, $1, 'Compute', 'meter test', $2, $3::jsonb)`,
    [roomId, ownerId, JSON.stringify(settings)],
  );
  for (const participant of [
    { id: ownerId, name: "Owner", authority: "OWNER", kind: "HUMAN" },
    { id: participantId, name: "Agent", authority: "MEMBER", kind: "AGENT" },
  ]) {
    await db.pool.query(
      `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status)
       VALUES ($1, $2, $3, $4, $5, 'DEVELOPER', 'ACTIVE')`,
      [participant.id, roomId, participant.kind, participant.name, participant.authority],
    );
  }
  await db.pool.query(
    `INSERT INTO sandboxes (id, room_id, participant_id, status)
     VALUES ($1, $2, $3, 'CREATING')`,
    [sandboxId, roomId, participantId],
  );
  return { room_id: roomId, participant_id: participantId, sandbox_id: sandboxId };
}

describe("SandboxComputeBudgetMeter", () => {
  it("caps exec timeout by the per-agent limit and refuses exhausted capacity", async () => {
    const ids = await fixture({
      compute_budgets: { agent_vcpu_hours_per_day: 4, room_vcpu_hours_per_day: 8 },
    });
    await db.pool.query(
      "UPDATE participants SET budgets = '{\"agent_vcpu_hours_per_day\":1}'::jsonb WHERE id = $1",
      [ids.participant_id],
    );
    const meter = new SandboxComputeBudgetMeter(db.pool, () => new Date("2026-10-01T12:00:00Z"));
    const timeoutMs = await meter.reserve({
      ...ids,
      exec_id: newId("exec"),
      requested_timeout_ms: 3_600_000,
      vcpus: 2,
    });
    expect(timeoutMs).toBe(1_800_000);
    await expect(
      meter.reserve({
        ...ids,
        exec_id: newId("exec"),
        requested_timeout_ms: 1_000,
        vcpus: 2,
      }),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
  });

  it("serializes room-wide reservations across agents", async () => {
    const ids = await fixture({
      compute_budgets: { agent_vcpu_hours_per_day: 4, room_vcpu_hours_per_day: 1 },
    });
    const otherParticipantId = newId("part");
    const otherSandboxId = newId("sandbox");
    await db.pool.query(
      `INSERT INTO participants (id, room_id, kind, display_name, role, status)
       VALUES ($1, $2, 'AGENT', 'Other', 'DEVELOPER', 'ACTIVE')`,
      [otherParticipantId, ids.room_id],
    );
    await db.pool.query(
      `INSERT INTO sandboxes (id, room_id, participant_id, status)
       VALUES ($1, $2, $3, 'CREATING')`,
      [otherSandboxId, ids.room_id, otherParticipantId],
    );
    const meter = new SandboxComputeBudgetMeter(db.pool, () => new Date("2026-10-01T12:00:00Z"));
    const attempts = await Promise.allSettled(
      [
        ids,
        { room_id: ids.room_id, participant_id: otherParticipantId, sandbox_id: otherSandboxId },
      ].map((identity) =>
        meter.reserve({
          ...identity,
          exec_id: newId("exec"),
          requested_timeout_ms: 1_800_000,
          vcpus: 2,
        }),
      ),
    );
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    expect(attempts.find((attempt) => attempt.status === "rejected")).toMatchObject({
      reason: { code: "BUDGET_EXCEEDED" },
    });
  });

  it("charges cgroup deltas once and reconciles the completed exec reservation", async () => {
    const ids = await fixture();
    let now = new Date("2026-10-01T12:00:00Z");
    const meter = new SandboxComputeBudgetMeter(db.pool, () => now);
    const execId = newId("exec");
    await meter.reserve({ ...ids, exec_id: execId, requested_timeout_ms: 600_000, vcpus: 2 });
    const sample = (usage: bigint, at = now, generation = "start-1") =>
      meter.sample({ ...ids, usage_usec: usage, generation, sampled_at: at });
    expect(await sample(0n)).toBe(0n);
    now = new Date("2026-10-01T12:01:00Z");
    expect(await sample(500_000_000n)).toBe(500_000_000n);
    expect(await sample(500_000_000n)).toBe(0n);
    expect(await meter.release(execId)).toBe(700_000_000n);
    const room = await db.pool.query<{ used: string; reserved: string }>(
      `SELECT used_cpu_usec::text AS used, reserved_cpu_usec::text AS reserved
         FROM sandbox_compute_room_daily WHERE room_id = $1 AND usage_date = '2026-10-01'`,
      [ids.room_id],
    );
    expect(room.rows[0]).toEqual({ used: "500000000", reserved: "0" });
    const agent = await db.pool.query<{ used_cpu_usec: string }>(
      `SELECT used_cpu_usec::text FROM sandbox_compute_agent_daily
        WHERE room_id = $1 AND participant_id = $2 AND usage_date = '2026-10-01'`,
      [ids.room_id, ids.participant_id],
    );
    expect(agent.rows[0]?.used_cpu_usec).toBe("500000000");
  });

  it("reports an exhausted measured cap so a running sandbox can be hibernated", async () => {
    const ids = await fixture({
      compute_budgets: { agent_vcpu_hours_per_day: 1, room_vcpu_hours_per_day: 4 },
    });
    const firstSampleAt = new Date("2026-10-01T12:00:00Z");
    const meter = new SandboxComputeBudgetMeter(db.pool, () => new Date("2026-10-01T13:00:00Z"));
    expect(
      await meter.sample({
        ...ids,
        usage_usec: 0n,
        generation: "start-1",
        sampled_at: firstSampleAt,
      }),
    ).toBe(0n);
    expect(
      await meter.sample({
        ...ids,
        usage_usec: 3_600_000_000n,
        generation: "start-1",
        sampled_at: new Date(firstSampleAt.getTime() + 60_000),
      }),
    ).toBe(3_600_000_000n);
    expect(await meter.isLimitReached(ids, new Date("2026-10-01T13:00:00Z"))).toBe(true);
    await expect(
      meter.reserve({
        ...ids,
        exec_id: newId("exec"),
        requested_timeout_ms: 1_000,
        vcpus: 2,
      }),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
  });

  it("charges a new cgroup generation and ignores out-of-order samples", async () => {
    const ids = await fixture();
    const meter = new SandboxComputeBudgetMeter(db.pool);
    const at = new Date("2026-10-01T12:00:00Z");
    expect(
      await meter.sample({ ...ids, usage_usec: 4_000n, generation: "first", sampled_at: at }),
    ).toBe(0n);
    expect(
      await meter.sample({
        ...ids,
        usage_usec: 3_000n,
        generation: "restarted",
        sampled_at: new Date(at.getTime() + 1_000),
      }),
    ).toBe(3_000n);
    expect(
      await meter.sample({ ...ids, usage_usec: 9_000n, generation: "first", sampled_at: at }),
    ).toBe(0n);
  });

  it("expires a crashed exec reservation", async () => {
    const ids = await fixture();
    let now = new Date("2026-10-01T12:00:00Z");
    const meter = new SandboxComputeBudgetMeter(db.pool, () => now);
    await meter.reserve({
      ...ids,
      exec_id: newId("exec"),
      requested_timeout_ms: 600_000,
      vcpus: 2,
    });
    now = new Date(now.getTime() + 700_000);
    expect(await meter.sweepExpired()).toBe(1);
    const usage = await db.pool.query<{ reserved_cpu_usec: string }>(
      `SELECT reserved_cpu_usec::text FROM sandbox_compute_room_daily
        WHERE room_id = $1 AND usage_date = '2026-10-01'`,
      [ids.room_id],
    );
    expect(usage.rows[0]?.reserved_cpu_usec).toBe("0");
  });
});
