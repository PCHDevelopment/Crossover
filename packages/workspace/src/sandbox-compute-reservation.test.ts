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
     VALUES ($1, $1, 'Compute', 'reservation test', $2, $3::jsonb)`,
    [roomId, ownerId, JSON.stringify(settings)],
  );
  await db.pool.query(
    `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status)
     VALUES ($1, $3, 'HUMAN', 'Owner', 'OWNER', 'DEVELOPER', 'ACTIVE'),
            ($2, $3, 'AGENT', 'Agent', 'MEMBER', 'DEVELOPER', 'ACTIVE')`,
    [ownerId, participantId, roomId],
  );
  await db.pool.query(
    `INSERT INTO sandboxes (id, room_id, participant_id, status)
     VALUES ($1, $2, $3, 'CREATING')`,
    [sandboxId, roomId, participantId],
  );
  return { room_id: roomId, participant_id: participantId, sandbox_id: sandboxId };
}

describe("SandboxComputeBudgetMeter reservations", () => {
  it("caps requested runtime at the tighter agent limit and releases unused capacity", async () => {
    const ids = await fixture({
      compute_budgets: { agent_vcpu_hours_per_day: 4, room_vcpu_hours_per_day: 8 },
    });
    await db.pool.query(
      "UPDATE participants SET budgets = '{\"agent_vcpu_hours_per_day\":1}'::jsonb WHERE id = $1",
      [ids.participant_id],
    );
    const meter = new SandboxComputeBudgetMeter(db.pool, () => new Date("2026-10-01T12:00:00Z"));
    const execId = newId("exec");
    const timeoutMs = await meter.reserve({
      ...ids,
      exec_id: execId,
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
    expect(await meter.release(execId)).toBe(3_600_000_000n);
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
  });

  it("expires reservations left by a crashed exec", async () => {
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
