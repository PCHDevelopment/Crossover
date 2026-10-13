import { withTransaction } from "@crossover/db";
import { appendEvents, hashRequest, IDEMPOTENCY_TTL_HOURS } from "@crossover/ledger";
import { CrossoverError } from "@crossover/protocol";
import {
  BUDGET_DEFAULTS,
  budgetsOf,
  limitFor,
  readOverrides,
  type BudgetName,
} from "../budgets.js";
import type { Principal } from "../principal.js";
import type { DispatcherCore } from "./core.js";
import { afterCommitWork } from "./delivery.js";

/**
 * Count the command against the agent's budgets (§22.3) and refuse it with `BUDGET_EXCEEDED`
 * and `retry_after` (seconds) when one is used up. Agents only; the limits are the defaults
 * unless the room's `settings.budgets` or the participant's `budgets` override them. When both
 * have a finite value, the tighter limit applies. The first
 * refusal of a window is also recorded as `budget.exceeded`, so a flood of refused calls
 * writes one event, not one each. If the limiter or its overrides can't be read, the command
 * goes ahead.
 */
export async function enforceBudgets(
  core: DispatcherCore,

  principal: Principal,
  envelope: {
    method: string;
    id: string;
    idempotency_key?: string | undefined;
    params?: unknown;
  },
) {
  if (!core.budgets || principal.kind !== "AGENT") return;
  const room_id = principal.room_id;
  let refusal:
    { budget: BudgetName; limit: number; retry_after_ms: number; first: boolean } | undefined;
  try {
    // A retry of a command that already ran gets its stored result and costs nothing.
    if (await isReplay(core, principal, envelope)) return;
    const { rows } = await core.pool.query<{ room: unknown; mine: unknown }>(
      `SELECT r.settings -> 'budgets' AS room, p.budgets AS mine
       FROM participants p JOIN rooms r ON r.id = p.room_id
       WHERE p.id = $1 AND p.room_id = $2`,
      [principal.participant_id, room_id],
    );
    const room = readOverrides(rows[0]?.room);
    const mine = readOverrides(rows[0]?.mine);
    const keyOf = (budget: BudgetName) => ({
      room_id,
      participant_id: principal.participant_id,
      budget,
    });
    const applicable: { budget: BudgetName; limit: number }[] = [];
    for (const budget of budgetsOf(envelope.method)) {
      const limit = limitFor(budget, room, mine);
      if (limit !== null) applicable.push({ budget, limit });
    }
    // Look at every budget first: a command refused for one spends none of the others, so an
    // agent hammering a refused `messages.send` can still read.
    let exhausted: { budget: BudgetName; limit: number } | undefined;
    for (const item of applicable) {
      const used = await core.budgets.peek(
        keyOf(item.budget),
        BUDGET_DEFAULTS[item.budget].windowMs,
      );
      if (used >= item.limit) {
        exhausted = item;
        break;
      }
    }
    for (const item of exhausted ? [exhausted] : applicable) {
      const decision = await core.budgets.consume(
        keyOf(item.budget),
        item.limit,
        BUDGET_DEFAULTS[item.budget].windowMs,
      );
      if (!decision.allowed) {
        refusal = { ...item, ...decision };
        break;
      }
    }
  } catch (error) {
    try {
      core.onBudgetError(error, { method: envelope.method, room_id });
    } catch {
      // A broken error handler must not change the command's outcome.
    }
    return;
  }
  if (!refusal) return;
  const retryAfter = Math.max(1, Math.ceil(refusal.retry_after_ms / 1000));
  const details = {
    budget: refusal.budget,
    limit: refusal.limit,
    window_seconds: BUDGET_DEFAULTS[refusal.budget].windowMs / 1000,
    retry_after: retryAfter,
  };
  if (refusal.first) await recordBudgetExceeded(core, principal, envelope, details);
  throw new CrossoverError(
    "BUDGET_EXCEEDED",
    `The ${refusal.budget} budget (${refusal.limit} per ${details.window_seconds} s) is used up; retry in ${retryAfter} s`,
    { details },
  );
}

export function requestHashOf(
  principal: Principal,
  envelope: { method: string; params?: unknown },
): string {
  return hashRequest({
    room_id: principal.room_id,
    method: envelope.method,
    params: envelope.params,
  });
}

/** Whether this exact request (same participant, key and content) already ran and has a stored result. */
export async function isReplay(
  core: DispatcherCore,

  principal: Principal,
  envelope: { method: string; idempotency_key?: string | undefined; params?: unknown },
): Promise<boolean> {
  if (envelope.idempotency_key === undefined) return false;
  let requestHash: string;
  try {
    requestHash = hashRequest({
      room_id: principal.room_id,
      method: envelope.method,
      params: envelope.params,
    });
  } catch {
    return false; // the command itself will say the params are bad
  }
  const { rowCount } = await core.pool.query(
    `SELECT 1 FROM idempotency_keys
     WHERE participant_id = $1 AND idempotency_key = $2 AND request_hash = $3
       AND response IS NOT NULL
       AND created_at >= clock_timestamp() - make_interval(hours => $4)`,
    [principal.participant_id, envelope.idempotency_key, requestHash, IDEMPOTENCY_TTL_HOURS],
  );
  return (rowCount ?? 0) > 0;
}

/** Append `budget.exceeded` in a transaction of its own. Never throws. */
export async function recordBudgetExceeded(
  core: DispatcherCore,

  principal: Principal,
  envelope: { method: string; id: string },
  details: Record<string, unknown>,
): Promise<void> {
  const room_id = principal.room_id;
  try {
    await core.actors.get(room_id).submit(async () => {
      const token = await core.leases.ensure(room_id);
      const events = await withTransaction(core.pool, (client) =>
        appendEvents(
          client,
          room_id,
          [
            {
              type: "budget.exceeded",
              actor_id: principal.participant_id,
              causation_id: envelope.id,
              payload: { ...details, method: envelope.method },
            },
          ],
          token,
        ),
      );
      await afterCommitWork(core, room_id, envelope, [], {
        response: undefined,
        events,
        replayed: false,
      });
    });
  } catch (error) {
    core.onDenialRecordError(error, {
      method: envelope.method,
      command_id: envelope.id,
      room_id,
      action: "budget.exceeded",
    });
  }
}
