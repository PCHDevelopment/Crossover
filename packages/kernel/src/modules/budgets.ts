import { CrossoverError, isId } from "@crossover/protocol";
import { z } from "zod";
import {
  BUDGET_DEFAULTS,
  BUDGET_NAMES,
  limitFor,
  readOverrides,
  type BudgetName,
  type BudgetLimiter,
  type BudgetOverrides,
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

const setParams = z.strictObject({
  participant_id: z
    .string()
    .refine((value) => isId(value, "part"), "Invalid participant id")
    .optional(),
  budgets: budgetMapSchema,
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
      const input = normalizeBudgets(params.budgets);
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
        const nextBudgets = replaceKnownBudgets(participant.budgets, input);
        const changed = !sameBudgets(oldBudgets, input);
        if (changed) {
          await ctx.client.query(
            "UPDATE participants SET budgets = $2::jsonb WHERE id = $1 AND room_id = $3",
            [participant.id, JSON.stringify(nextBudgets), ctx.room_id],
          );
        }
        return {
          response: { participant_id: participant.id as string | null, budgets: input, changed },
          events: changed
            ? [
                {
                  type: "room.budgets_changed",
                  payload: {
                    participant_id: participant.id,
                    old_budgets: oldBudgets,
                    new_budgets: input,
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
      const nextBudgets = replaceKnownBudgets(settings["budgets"], input);
      const changed = !sameBudgets(oldBudgets, input);
      if (changed) {
        await ctx.client.query(
          `UPDATE rooms
              SET settings = jsonb_set(
                CASE WHEN jsonb_typeof(settings) = 'object' THEN settings ELSE '{}'::jsonb END,
                '{budgets}', $2::jsonb, true
              )
            WHERE id = $1`,
          [ctx.room_id, JSON.stringify(nextBudgets)],
        );
      }
      return {
        response: { participant_id: null, budgets: input, changed },
        events: changed
          ? [
              {
                type: "room.budgets_changed",
                payload: {
                  participant_id: null,
                  old_budgets: oldBudgets,
                  new_budgets: input,
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
          };
        }),
      );
      return {
        response: {
          room_budgets: roomBudgets,
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

function sameBudgets(left: BudgetOverrides, right: BudgetOverrides): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeBudgets(raw: Record<string, number | null>): BudgetOverrides {
  const result: BudgetOverrides = {};
  for (const name of BUDGET_NAMES) {
    if (Object.hasOwn(raw, name)) result[name] = raw[name]!;
  }
  return result;
}

function asRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
