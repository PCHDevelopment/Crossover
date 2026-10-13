import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { authorize } from "@crossover/policy";
import { CrossoverError, newId } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryBudgetLimiter } from "../budgets.js";
import { Dispatcher } from "../dispatcher.js";
import type { Principal } from "../principal.js";
import { registerBudgetCommands } from "./budgets.js";

let db: TestDatabase;
let pool: Pool;
let n = 0;

beforeAll(async () => {
  db = await createTestDatabase();
  pool = db.pool;
});

afterAll(async () => {
  await db.drop();
});

interface Room {
  d: Dispatcher;
  limiter: MemoryBudgetLimiter;
  id: string;
  owner: Principal;
  admin: Principal;
  member: Principal;
  agent: Principal;
  human: Principal;
}

async function setup(
  settings?: Record<string, unknown>,
  now: () => Date = () => new Date(),
): Promise<Room> {
  const id = newId("room");
  const ownerId = newId("part");
  const adminId = newId("part");
  const memberId = newId("part");
  const agentId = newId("part");
  const humanId = newId("part");
  await pool.query(
    `INSERT INTO rooms (id, slug, name, objective, owner_id, lead_participant_id, settings)
     VALUES ($1, $1, 'Budgets', 'test', $2, $3, $4::jsonb)`,
    [
      id,
      ownerId,
      agentId,
      JSON.stringify(
        settings ?? { keep: true, budgets: { commands: 9, messages: 8, sandbox_compute: 17 } },
      ),
    ],
  );
  await pool.query(
    `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status, budgets)
     VALUES ($1, $6, 'HUMAN', 'Owner', 'OWNER', 'DEVELOPER', 'ACTIVE', '{}'),
            ($2, $6, 'HUMAN', 'Admin', 'ADMIN', 'DEVELOPER', 'ACTIVE', '{}'),
            ($3, $6, 'AGENT', 'Member', 'MEMBER', 'LEAD', 'ACTIVE', '{}'),
            ($4, $6, 'AGENT', 'Agent', 'MEMBER', 'DEVELOPER', 'ACTIVE', '{"messages":2}'::jsonb),
            ($5, $6, 'HUMAN', 'Human', 'MEMBER', 'DEVELOPER', 'ACTIVE', '{}')`,
    [ownerId, adminId, memberId, agentId, humanId, id],
  );
  const principal = (
    participant_id: string,
    kind: Principal["kind"],
    authority: Principal["authority"],
    role: Principal["role"],
  ): Principal => ({ participant_id, room_id: id, kind, authority, role });
  const limiter = new MemoryBudgetLimiter(() => 9_000_000);
  const d = new Dispatcher({ pool, authorize, nodeId: `node-budgets-${++n}` });
  registerBudgetCommands(d, limiter, now);
  return {
    d,
    limiter,
    id,
    owner: principal(ownerId, "HUMAN", "OWNER", "DEVELOPER"),
    admin: principal(adminId, "HUMAN", "ADMIN", "DEVELOPER"),
    member: principal(memberId, "AGENT", "MEMBER", "LEAD"),
    agent: principal(agentId, "AGENT", "MEMBER", "DEVELOPER"),
    human: principal(humanId, "HUMAN", "MEMBER", "DEVELOPER"),
  };
}

function command(method: string, params: Record<string, unknown> = {}) {
  return {
    id: newId("cmd"),
    method,
    params,
    idempotency_key: `budgets-${++n}`,
  };
}

async function dispatch(
  room: Room,
  principal: Principal,
  method: string,
  params: Record<string, unknown> = {},
) {
  return room.d.dispatch(principal, command(method, params));
}

describe("budgets.set and budgets.get", () => {
  it("replaces room overrides, keeps unrelated settings and future budget keys, and emits old/new maps", async () => {
    const room = await setup();
    const result = await dispatch(room, room.owner, "budgets.set", {
      budgets: { messages: 4, tool_invocations: null },
    });
    expect(result.response).toEqual({
      participant_id: null,
      budgets: { messages: 4, tool_invocations: null },
      changed: true,
    });
    expect(result.events[0]).toMatchObject({
      type: "room.budgets_changed",
      payload: {
        participant_id: null,
        old_budgets: { commands: 9, messages: 8 },
        new_budgets: { messages: 4, tool_invocations: null },
      },
    });
    const settings = (
      await pool.query<{ settings: Record<string, unknown> }>(
        "SELECT settings FROM rooms WHERE id = $1",
        [room.id],
      )
    ).rows[0]!.settings;
    expect(settings).toEqual({
      keep: true,
      budgets: { sandbox_compute: 17, messages: 4, tool_invocations: null },
    });

    const unchanged = await dispatch(room, room.admin, "budgets.set", {
      budgets: { tool_invocations: null, messages: 4 },
    });
    expect(unchanged.response).toMatchObject({ changed: false });
    expect(unchanged.events).toEqual([]);
  });

  it("sets per-agent overrides and only accepts a same-room agent", async () => {
    const room = await setup();
    const foreignRoom = await setup();
    const updated = await dispatch(room, room.admin, "budgets.set", {
      participant_id: room.agent.participant_id,
      budgets: { messages: 1 },
    });
    expect(updated.events[0]).toMatchObject({
      type: "room.budgets_changed",
      payload: {
        participant_id: room.agent.participant_id,
        old_budgets: { messages: 2 },
        new_budgets: { messages: 1 },
      },
    });
    const saved = await pool.query<{ budgets: Record<string, unknown> }>(
      "SELECT budgets FROM participants WHERE id = $1",
      [room.agent.participant_id],
    );
    expect(saved.rows[0]?.budgets).toEqual({ messages: 1 });

    await expect(
      dispatch(room, room.owner, "budgets.set", {
        participant_id: room.human.participant_id,
        budgets: {},
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(
      dispatch(room, room.owner, "budgets.set", {
        participant_id: newId("part"),
        budgets: {},
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      dispatch(room, room.owner, "budgets.set", {
        participant_id: foreignRoom.agent.participant_id,
        budgets: { messages: 1 },
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it.each([
    { budgets: { unknown: 1 } },
    { budgets: { messages: 0 } },
    { budgets: { messages: 1.5 } },
    { budgets: { messages: Number.MAX_SAFE_INTEGER + 1 } },
    { compute_budgets: { unknown: 1 } },
    { compute_budgets: { agent_vcpu_hours_per_day: 0 } },
    { compute_budgets: { room_vcpu_hours_per_day: Number.MAX_SAFE_INTEGER + 1 } },
    {},
  ])("rejects malformed budget overrides: %j", async (params) => {
    const room = await setup();
    await expect(dispatch(room, room.owner, "budgets.set", params)).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });

  it("sets room and per-agent CPU caps, applies the tighter limit, and reports daily usage", async () => {
    const room = await setup({ keep: true, budgets: { messages: 6 } });
    const roomSet = await dispatch(room, room.owner, "budgets.set", {
      compute_budgets: { agent_vcpu_hours_per_day: 2, room_vcpu_hours_per_day: 8 },
    });
    expect(roomSet.response).toEqual({
      participant_id: null,
      compute_budgets: { agent_vcpu_hours_per_day: 2, room_vcpu_hours_per_day: 8 },
      changed: true,
    });
    expect(roomSet.events[0]).toMatchObject({
      type: "room.budgets_changed",
      payload: {
        participant_id: null,
        old_compute_budgets: {},
        new_compute_budgets: {
          agent_vcpu_hours_per_day: 2,
          room_vcpu_hours_per_day: 8,
        },
      },
    });
    const settingsAfterComputeUpdate = (
      await pool.query<{ settings: Record<string, unknown> }>(
        "SELECT settings FROM rooms WHERE id = $1",
        [room.id],
      )
    ).rows[0]!.settings;
    expect(settingsAfterComputeUpdate).toMatchObject({
      keep: true,
      budgets: { messages: 6 },
      compute_budgets: { agent_vcpu_hours_per_day: 2, room_vcpu_hours_per_day: 8 },
    });

    const agentSet = await dispatch(room, room.admin, "budgets.set", {
      participant_id: room.agent.participant_id,
      compute_budgets: { agent_vcpu_hours_per_day: 1 },
    });
    expect(agentSet.response).toMatchObject({
      participant_id: room.agent.participant_id,
      compute_budgets: { agent_vcpu_hours_per_day: 1 },
      changed: true,
    });
    expect(agentSet.events[0]).toMatchObject({
      type: "room.budgets_changed",
      payload: {
        participant_id: room.agent.participant_id,
        old_compute_budgets: {},
        new_compute_budgets: { agent_vcpu_hours_per_day: 1 },
      },
    });
    const participantBudgets = (
      await pool.query<{ budgets: Record<string, unknown> }>(
        "SELECT budgets FROM participants WHERE id = $1",
        [room.agent.participant_id],
      )
    ).rows[0]!.budgets;
    expect(participantBudgets).toEqual({ messages: 2, agent_vcpu_hours_per_day: 1 });

    const usageDate = new Date().toISOString().slice(0, 10);
    await pool.query(
      `INSERT INTO sandbox_compute_room_daily
         (room_id, usage_date, used_cpu_usec, reserved_cpu_usec)
       VALUES ($1, $2::date, 1800000000, 900000000)`,
      [room.id, usageDate],
    );
    await pool.query(
      `INSERT INTO sandbox_compute_agent_daily
         (room_id, participant_id, usage_date, used_cpu_usec, reserved_cpu_usec)
       VALUES ($1, $2, $3::date, 720000000, 360000000)`,
      [room.id, room.agent.participant_id, usageDate],
    );

    const result = await dispatch(room, room.owner, "budgets.get");
    const response = result.response as {
      room_compute: {
        limit_vcpu_hours_per_day: number | null;
        used_vcpu_hours: number;
        reserved_vcpu_hours: number;
      };
      agents: {
        participant_id: string;
        compute_budgets: Record<string, number | null>;
        compute: {
          limit_vcpu_hours_per_day: number | null;
          used_vcpu_hours: number;
          reserved_vcpu_hours: number;
        };
      }[];
    };
    expect(response.room_compute).toEqual({
      limit_vcpu_hours_per_day: 8,
      used_vcpu_hours: 0.5,
      reserved_vcpu_hours: 0.25,
    });
    expect(response.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          participant_id: room.agent.participant_id,
          compute_budgets: { agent_vcpu_hours_per_day: 1 },
          compute: {
            limit_vcpu_hours_per_day: 1,
            used_vcpu_hours: 0.2,
            reserved_vcpu_hours: 0.1,
          },
        }),
      ]),
    );

    await dispatch(room, room.admin, "budgets.set", {
      participant_id: room.agent.participant_id,
      compute_budgets: { agent_vcpu_hours_per_day: 12 },
    });
    const tighterRoomCap = await dispatch(room, room.owner, "budgets.get");
    const agent = (tighterRoomCap.response as typeof response).agents.find(
      (entry) => entry.participant_id === room.agent.participant_id,
    );
    expect(agent?.compute.limit_vcpu_hours_per_day).toBe(2);

    await dispatch(room, room.admin, "budgets.set", {
      participant_id: room.agent.participant_id,
      compute_budgets: { agent_vcpu_hours_per_day: null },
    });
    const inheritedRoomCap = await dispatch(room, room.owner, "budgets.get");
    expect(
      (inheritedRoomCap.response as typeof response).agents.find(
        (entry) => entry.participant_id === room.agent.participant_id,
      )?.compute.limit_vcpu_hours_per_day,
    ).toBe(2);

    await dispatch(room, room.owner, "budgets.set", {
      compute_budgets: {
        agent_vcpu_hours_per_day: null,
        room_vcpu_hours_per_day: 8,
      },
    });
    const noAgentCap = await dispatch(room, room.owner, "budgets.get");
    expect(
      (noAgentCap.response as typeof response).agents.find(
        (entry) => entry.participant_id === room.agent.participant_id,
      )?.compute.limit_vcpu_hours_per_day,
    ).toBeNull();
  });

  it("rejects room-only compute limits when targeting an agent", async () => {
    const room = await setup();
    await expect(
      dispatch(room, room.owner, "budgets.set", {
        participant_id: room.agent.participant_id,
        compute_budgets: { room_vcpu_hours_per_day: 5 },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("uses the injected UTC day for daily compute usage", async () => {
    const room = await setup(undefined, () => new Date("2040-01-02T00:30:00Z"));
    await pool.query(
      `INSERT INTO sandbox_compute_room_daily
         (room_id, usage_date, used_cpu_usec, reserved_cpu_usec)
       VALUES ($1, '2040-01-02'::date, 7200000000, 1800000000),
              ($1, '2040-01-01'::date, 3600000000, 900000000)`,
      [room.id],
    );

    const result = await dispatch(room, room.owner, "budgets.get");
    expect(
      (
        result.response as {
          room_compute: { used_vcpu_hours: number; reserved_vcpu_hours: number };
        }
      ).room_compute,
    ).toMatchObject({ used_vcpu_hours: 2, reserved_vcpu_hours: 0.5 });
  });

  it("shows effective limits and current counts to owners and admins only", async () => {
    const room = await setup();
    await dispatch(room, room.owner, "budgets.set", { budgets: { messages: 5 } });
    await room.limiter.consume(
      { room_id: room.id, participant_id: room.agent.participant_id, budget: "messages" },
      10,
      60_000,
    );
    const result = await dispatch(room, room.owner, "budgets.get");
    const response = result.response as {
      room_budgets: Record<string, number | null>;
      room_compute: { limit_vcpu_hours_per_day: number | null };
      agents: {
        participant_id: string;
        effective: Record<string, number | null>;
        usage: Record<string, number>;
        compute_budgets: Record<string, number | null>;
        compute: { limit_vcpu_hours_per_day: number | null };
      }[];
    };
    expect(response.room_budgets).toEqual({ messages: 5 });
    expect(response.room_compute.limit_vcpu_hours_per_day).toBe(40);
    expect(response.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          participant_id: room.agent.participant_id,
          effective: expect.objectContaining({ commands: 120, messages: 2 }),
          usage: expect.objectContaining({ commands: 0, messages: 1 }),
          compute_budgets: {},
          compute: expect.objectContaining({ limit_vcpu_hours_per_day: 4 }),
        }),
      ]),
    );
    await expect(dispatch(room, room.admin, "budgets.get")).resolves.toBeDefined();
    await expect(dispatch(room, room.member, "budgets.get")).rejects.toBeInstanceOf(CrossoverError);
    await expect(
      dispatch(room, room.member, "budgets.set", { budgets: { messages: 1 } }),
    ).rejects.toBeInstanceOf(CrossoverError);
  });
});
