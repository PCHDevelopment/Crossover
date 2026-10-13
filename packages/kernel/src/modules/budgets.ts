import { CrossoverError, isId } from "@crossover/protocol";
import { z } from "zod";
import {
  BUDGET_DEFAULTS,
  BUDGET_NAMES,
  COMPUTE_BUDGET_DEFAULTS,
  computeLimitFor,
  limitFor,
  readComputeOverrides,
  readOverrides,
  type BudgetName,
  type BudgetLimiter,
  type BudgetOverrides,
  type ComputeBudgetName,
  type ComputeBudgetOverrides,
} from "../budgets.js";
import type { Dispatcher } from "../dispatcher.js";

const valueSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).nullable();

const budgetMapSchema = z.record(z.string(), valueSchema).superRefine((budgets, ctx) => {
  for (const name of Object.keys(budgets)) {
    if (!BUDGET_NAMES.includes(name as BudgetName)) {
      ctx.addIssue({ code: "custom", path: [name], message: "Unknown budget name" });
    }
  }
});

const computeBudgetMapSchema = z.record(z.string(), valueSchema).superRefine((budgets, ctx) => {
  for (const name of Object.keys(budgets)) {
    if (!Object.hasOwn(COMPUTE_BUDGET_DEFAULTS, name))
      ctx.addIssue({ code: "custom", path: [name], message: "Unknown compute budget name" });
  }
});

const setParams = z
  .strictObject({
    participant_id: z
      .string()
      .refine((value) => isId(value, "part"), "Invalid participant id")
      .optional(),
    budgets: budgetMapSchema.optional(),
    compute_budgets: computeBudgetMapSchema.optional(),
  })
  .superRefine((params, ctx) => {
    if (params.budgets === undefined && params.compute_budgets === undefined)
      ctx.addIssue({ code: "custom", path: [], message: "At least one budget map is required" });
    if (
      params.participant_id !== undefined &&
      params.compute_budgets !== undefined &&
      Object.hasOwn(params.compute_budgets, "room_vcpu_hours_per_day")
    )
      ctx.addIssue({
        code: "custom",
        path: ["compute_budgets"],
        message: "The room compute budget can only be set at the room level",
      });
  });

const getParams = z.strictObject({});

interface AgentRow {
  id: string;
  display_name: string;
  status: string;
  budgets: unknown;
  kind: string;
}

/** Register budget configuration and its owner/admin read surface (§22.3, T1504). */
export function registerBudgetCommands(dispatcher: Dispatcher, limiter: BudgetLimiter): void {
  dispatcher.registerCommand({
    method: "budgets.set",
    action: "budgets.set",
    mutating: true,
    params: setParams,
    execute: async (ctx, params) => {
      const input = normalizeBudgets(params.budgets ?? {});
      const computeInput =
        params.compute_budgets === undefined
          ? undefined
          : normalizeComputeBudgets(params.compute_budgets);
      if (params.participant_id !== undefined) {
        const { rows } = await ctx.client.query<AgentRow>(
          `SELECT id, display_name, status, budgets, kind
             FROM participants
            WHERE id = $1 AND room_id = $2
            FOR UPDATE`,
          [params.participant_id, ctx.room_id],
        );
        const participant = rows[0];
        if (!participant) throw new CrossoverError("NOT_FOUND", "Agent not found");
        if (participant.kind !== "AGENT") {
          throw new CrossoverError("VALIDATION", "Budgets can only be set for an agent");
        }

        const oldBudgets = readOverrides(participant.budgets);
        const oldComputeBudgets = readComputeOverrides(participant.budgets);
        const nextBudgets = replaceKnownBudgets(participant.budgets, input);
        const nextComputeBudgets =
          computeInput === undefined
            ? undefined
            : replaceKnownComputeBudgets(participant.budgets, computeInput);
        const budgetsChanged = params.budgets !== undefined && !sameBudgets(oldBudgets, input);
        const computeBudgetsChanged =
          computeInput !== undefined && !sameComputeBudgets(oldComputeBudgets, computeInput);
        const changed = budgetsChanged || computeBudgetsChanged;
        if (changed) {
          await ctx.client.query(
            "UPDATE participants SET budgets = $2::jsonb WHERE id = $1 AND room_id = $3",
            [
              participant.id,
              JSON.stringify({
                ...nextBudgets,
                ...(nextComputeBudgets ?? {}),
              }),
              ctx.room_id,
            ],
          );
        }
        return {
          response: {
            participant_id: participant.id as string | null,
            ...(params.budgets === undefined ? {} : { budgets: input }),
            ...(computeInput === undefined ? {} : { compute_budgets: computeInput }),
            changed,
          },
          events: changed
            ? [
                {
                  type: "room.budgets_changed",
                  payload: {
                    participant_id: participant.id,
                    ...(budgetsChanged ? { old_budgets: oldBudgets, new_budgets: input } : {}),
                    ...(computeBudgetsChanged
                      ? {
                          old_compute_budgets: oldComputeBudgets,
                          new_compute_budgets: computeInput,
                        }
                      : {}),
                  },
                },
              ]
            : [],
        };
      }

      const { rows } = await ctx.client.query<{ settings: unknown }>(
        "SELECT settings FROM rooms WHERE id = $1 FOR UPDATE",
        [ctx.room_id],
      );
      const room = rows[0];
      if (!room) throw new CrossoverError("NOT_FOUND", "Room not found");
      const settings = asRecord(room.settings) ? room.settings : {};
      const oldBudgets = readOverrides(settings["budgets"]);
      const oldComputeBudgets = readComputeOverrides(settings["compute_budgets"]);
      const nextBudgets =
        params.budgets === undefined ? undefined : replaceKnownBudgets(settings["budgets"], input);
      const nextComputeBudgets =
        computeInput === undefined
          ? undefined
          : replaceKnownComputeBudgets(settings["compute_budgets"], computeInput);
      const budgetsChanged = nextBudgets !== undefined && !sameBudgets(oldBudgets, input);
      const computeBudgetsChanged =
        computeInput !== undefined && !sameComputeBudgets(oldComputeBudgets, computeInput);
      const changed = budgetsChanged || computeBudgetsChanged;
      if (changed) {
        await ctx.client.query("UPDATE rooms SET settings = $2::jsonb WHERE id = $1", [
          ctx.room_id,
          JSON.stringify({
            ...settings,
            ...(nextBudgets === undefined ? {} : { budgets: nextBudgets }),
            ...(nextComputeBudgets === undefined ? {} : { compute_budgets: nextComputeBudgets }),
          }),
        ]);
      }
      return {
        response: {
          participant_id: null,
          ...(params.budgets === undefined ? {} : { budgets: input }),
          ...(computeInput === undefined ? {} : { compute_budgets: computeInput }),
          changed,
        },
        events: changed
          ? [
              {
                type: "room.budgets_changed",
                payload: {
                  participant_id: null,
                  ...(budgetsChanged ? { old_budgets: oldBudgets, new_budgets: input } : {}),
                  ...(computeBudgetsChanged
                    ? {
                        old_compute_budgets: oldComputeBudgets,
                        new_compute_budgets: computeInput,
                      }
                    : {}),
                },
              },
            ]
          : [],
      };
    },
  });

  dispatcher.registerCommand({
    method: "budgets.get",
    action: "budgets.set",
    mutating: false,
    view: "none",
    view_reason:
      "owner/admin budget controls need the same per-room data for every authorized reader",
    params: getParams,
    execute: async (ctx) => {
      const roomResult = await ctx.client.query<{ settings: unknown }>(
        "SELECT settings FROM rooms WHERE id = $1",
        [ctx.room_id],
      );
      const room = roomResult.rows[0];
      if (!room) throw new CrossoverError("NOT_FOUND", "Room not found");
      const settings = asRecord(room.settings) ? room.settings : {};
      const roomBudgets = readOverrides(settings["budgets"]);
      const computeBudgets = readComputeOverrides(settings["compute_budgets"]);
      const usageDate = new Date().toISOString().slice(0, 10);
      const roomComputeUsageResult = await ctx.client.query<{
        used_cpu_usec: string;
        reserved_cpu_usec: string;
      }>(
        `SELECT COALESCE(used_cpu_usec, 0)::text AS used_cpu_usec,
                COALESCE(reserved_cpu_usec, 0)::text AS reserved_cpu_usec
           FROM sandbox_compute_room_daily WHERE room_id = $1 AND usage_date = $2::date`,
        [ctx.room_id, usageDate],
      );
      const roomComputeUsage = roomComputeUsageResult.rows[0] ?? {
        used_cpu_usec: "0",
        reserved_cpu_usec: "0",
      };
      const agentComputeUsageResult = await ctx.client.query<{
        participant_id: string;
        used_cpu_usec: string;
        reserved_cpu_usec: string;
      }>(
        `SELECT participant_id, used_cpu_usec::text, reserved_cpu_usec::text
           FROM sandbox_compute_agent_daily
          WHERE room_id = $1 AND usage_date = $2::date`,
        [ctx.room_id, usageDate],
      );
      const agentComputeUsage = new Map(
        agentComputeUsageResult.rows.map((row) => [row.participant_id, row]),
      );
      const agentResult = await ctx.client.query<AgentRow>(
        `SELECT id, display_name, status, budgets, kind
           FROM participants
          WHERE room_id = $1 AND kind = 'AGENT' AND status <> 'REMOVED'
          ORDER BY joined_at NULLS LAST, id`,
        [ctx.room_id],
      );
      const agents = await Promise.all(
        agentResult.rows.map(async (agent) => {
          const budgets = readOverrides(agent.budgets);
          const agentComputeBudgets = readComputeOverrides(agent.budgets);
          const computeUsage = agentComputeUsage.get(agent.id);
          const effective = {} as Record<BudgetName, number | null>;
          const usage = {} as Record<BudgetName, number>;
          await Promise.all(
            BUDGET_NAMES.map(async (name) => {
              effective[name] = limitFor(name, roomBudgets, budgets);
              usage[name] = await limiter.peek(
                { room_id: ctx.room_id, participant_id: agent.id, budget: name },
                BUDGET_DEFAULTS[name].windowMs,
              );
            }),
          );
          return {
            participant_id: agent.id,
            display_name: agent.display_name,
            status: agent.status,
            budgets,
            effective,
            usage,
            compute_budgets: agentComputeBudgets,
            compute: {
              limit_vcpu_hours_per_day: computeLimitFor(
                "agent_vcpu_hours_per_day",
                computeBudgets,
                agentComputeBudgets,
              ),
              used_vcpu_hours: vcpuHours(computeUsage?.used_cpu_usec ?? "0"),
              reserved_vcpu_hours: vcpuHours(computeUsage?.reserved_cpu_usec ?? "0"),
            },
          };
        }),
      );
      return {
        response: {
          room_budgets: roomBudgets,
          compute_budgets: computeBudgets,
          compute_definitions: Object.entries(COMPUTE_BUDGET_DEFAULTS).map(([name, value]) => ({
            name,
            default: value,
            unit: "vCPU-hours/day",
          })),
          room_compute: {
            limit_vcpu_hours_per_day: computeLimitFor("room_vcpu_hours_per_day", computeBudgets),
            used_vcpu_hours: vcpuHours(roomComputeUsage.used_cpu_usec),
            reserved_vcpu_hours: vcpuHours(roomComputeUsage.reserved_cpu_usec),
          },
          definitions: BUDGET_NAMES.map((name) => ({
            name,
            default: BUDGET_DEFAULTS[name].limit,
            window_seconds: BUDGET_DEFAULTS[name].windowMs / 1000,
          })),
          agents,
        },
      };
    },
  });
}

function replaceKnownBudgets(raw: unknown, replacement: BudgetOverrides): Record<string, unknown> {
  const current = asRecord(raw) ? raw : {};
  const preserved = Object.fromEntries(
    Object.entries(current).filter(([key]) => !BUDGET_NAMES.includes(key as BudgetName)),
  );
  return { ...preserved, ...replacement };
}

function replaceKnownComputeBudgets(
  raw: unknown,
  replacement: ComputeBudgetOverrides,
): Record<string, unknown> {
  const current = asRecord(raw) ? raw : {};
  const preserved = Object.fromEntries(
    Object.entries(current).filter(([key]) => !Object.hasOwn(COMPUTE_BUDGET_DEFAULTS, key)),
  );
  return { ...preserved, ...replacement };
}

function sameBudgets(left: BudgetOverrides, right: BudgetOverrides): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameComputeBudgets(left: ComputeBudgetOverrides, right: ComputeBudgetOverrides): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeBudgets(raw: Record<string, number | null>): BudgetOverrides {
  const result: BudgetOverrides = {};
  for (const name of BUDGET_NAMES) {
    if (Object.hasOwn(raw, name)) result[name] = raw[name]!;
  }
  return result;
}

function normalizeComputeBudgets(raw: Record<string, number | null>): ComputeBudgetOverrides {
  const result: ComputeBudgetOverrides = {};
  for (const name of Object.keys(COMPUTE_BUDGET_DEFAULTS) as ComputeBudgetName[]) {
    if (Object.hasOwn(raw, name)) result[name] = raw[name]!;
  }
  return result;
}

function vcpuHours(usageUsec: string): number {
  return Number(BigInt(usageUsec)) / 3_600_000_000;
}

function asRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
