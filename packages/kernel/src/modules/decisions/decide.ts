import { CrossoverError } from "@crossover/protocol";
import { z } from "zod";
import type { Dispatcher } from "../../dispatcher.js";
import {
  DECISION_COLUMNS,
  decisionConflict,
  decisionView,
  loadDecision,
  loadPositions,
  type DecisionRow,
} from "./decisions.js";

export const DEFAULT_DECISION_PAGE = 50;
export const MAX_DECISION_PAGE = 100;

const decisionId = z.string().min(1).max(100);
const expectedVersion = z.number().int().min(1);

export const decisionsDecideParams = z
  .strictObject({
    decision_id: decisionId,
    /** The version you last saw; a stale one is `CONFLICT_VERSION`. */
    expected_version: expectedVersion,
    /** Accept this option… */
    outcome_option_id: z.string().min(1).max(100).optional(),
    /** …or reject the proposal. Exactly one of the two. */
    reject: z.literal(true).optional(),
    /** Why. Required: a decision with no reason isn't one (§7.1). */
    rationale: z.string().trim().min(1).max(10_000),
  })
  .refine(
    (p) => (p.outcome_option_id === undefined) !== (p.reject === undefined),
    "Give either outcome_option_id or reject: true",
  );

export const decisionsVetoParams = z.strictObject({
  decision_id: decisionId,
  expected_version: expectedVersion,
  /** Why. Required (§7.1 step 4). */
  rationale: z.string().trim().min(1).max(10_000),
});

/** How long after it is decided that the owner may still veto (§7.1). */
export const VETO_WINDOW_HOURS = 24;

export const decisionsWithdrawParams = z.strictObject({
  decision_id: decisionId,
  expected_version: expectedVersion,
});

export const decisionsGetParams = z.strictObject({ decision_id: decisionId });

export const decisionsListParams = z.strictObject({
  /** Only these statuses. Default: all. */
  status: z
    .array(z.enum(["PROPOSED", "ACCEPTED", "REJECTED", "WITHDRAWN", "SUPERSEDED", "VETOED"]))
    .min(1)
    .max(6)
    .optional(),
  /** Continue after this decision id (the last of the previous page). */
  after: z.string().min(1).max(100).optional(),
  limit: z.number().int().min(1).max(MAX_DECISION_PAGE).default(DEFAULT_DECISION_PAGE),
});

const notProposed = (row: DecisionRow, what: string) =>
  new CrossoverError("VALIDATION", `Can't ${what} a decision that is ${row.status}`, {
    details: { status: row.status },
  });

/**
 * Register `decisions.decide`, `decisions.withdraw`, `decisions.get` and `decisions.list` (T405,
 * §7.1).
 *
 * - **decide** (the lead, via `decisions.decide`): accepts one option or rejects the proposal,
 *   with a written rationale. `PROPOSED → ACCEPTED | REJECTED`, version + 1, `decided_by` and
 *   `decided_at` set, `decision.decided` emitted. Anyone else is `FORBIDDEN`. Only a `PROPOSED`
 *   decision can be decided (`VALIDATION`), a stale `expected_version` is `CONFLICT_VERSION`
 *   with the decision as it is now, and the option must be one of its own.
 * - **withdraw** (the proposer, while `PROPOSED`): `→ WITHDRAWN`, `decision.withdrawn`. Anyone
 *   else is `FORBIDDEN` (`not_proposer`).
 * - **get** returns the decision with its positions; **list** pages decisions oldest first by id,
 *   optionally filtered by status, with `next_after` when there may be more.
 */
export function registerDecisionDecideCommands(dispatcher: Dispatcher): void {
  dispatcher.registerCommand({
    method: "decisions.decide",
    mutating: true,
    params: decisionsDecideParams,
    execute: async (ctx, p) => {
      const row = await loadDecision(ctx.client, ctx.room_id, p.decision_id, true);
      if (row.version !== p.expected_version) {
        throw await decisionConflict(ctx.client, ctx.room_id, row.id);
      }
      if (row.status !== "PROPOSED") throw notProposed(row, "decide");
      if (
        p.outcome_option_id !== undefined &&
        !row.options.some((o) => o.id === p.outcome_option_id)
      ) {
        throw new CrossoverError(
          "VALIDATION",
          `Decision ${row.id} has no option ${p.outcome_option_id}`,
          { details: { option_id: p.outcome_option_id, options: row.options.map((o) => o.id) } },
        );
      }
      const status = p.reject ? "REJECTED" : "ACCEPTED";
      const { rows } = await ctx.client.query<DecisionRow>(
        `UPDATE decisions
         SET status = $4, outcome_option_id = $5, rationale = $6, decided_by = $7,
             decided_at = clock_timestamp(), version = version + 1
         WHERE id = $1 AND room_id = $2 AND version = $3 AND status = 'PROPOSED'
         RETURNING ${DECISION_COLUMNS}`,
        [
          row.id,
          ctx.room_id,
          row.version,
          status,
          p.outcome_option_id ?? null,
          p.rationale,
          ctx.principal.participant_id,
        ],
      );
      const updated = rows[0];
      if (!updated) throw await decisionConflict(ctx.client, ctx.room_id, row.id);
      // Accepting a decision that supersedes an earlier one moves that one to SUPERSEDED (§7.1).
      let superseded: { id: string; version: number } | undefined;
      if (status === "ACCEPTED" && updated.supersedes) {
        const { rows: old } = await ctx.client.query<{ id: string; version: number }>(
          `UPDATE decisions SET status = 'SUPERSEDED', version = version + 1
           WHERE id = $1 AND room_id = $2 AND status = 'ACCEPTED'
           RETURNING id, version`,
          [updated.supersedes, ctx.room_id],
        );
        superseded = old[0];
      }
      const decision = decisionView(updated, await loadPositions(ctx.client, ctx.room_id, row.id));
      return {
        response: decision,
        events: [
          {
            type: "decision.decided" as const,
            payload: {
              decision_id: row.id,
              status,
              outcome_option_id: updated.outcome_option_id,
              rationale: p.rationale,
              decided_by: ctx.principal.participant_id,
              from_version: row.version,
              version: updated.version,
            },
          },
          ...(superseded
            ? [
                {
                  type: "decision.superseded" as const,
                  payload: {
                    decision_id: superseded.id,
                    superseded_by: row.id,
                    version: superseded.version,
                  },
                },
              ]
            : []),
        ],
      };
    },
  });

  dispatcher.registerCommand({
    method: "decisions.veto",
    mutating: true,
    params: decisionsVetoParams,
    execute: async (ctx, p) => {
      const row = await loadDecision(ctx.client, ctx.room_id, p.decision_id, true);
      if (row.version !== p.expected_version) {
        throw await decisionConflict(ctx.client, ctx.room_id, row.id);
      }
      if (row.status !== "ACCEPTED" && row.status !== "REJECTED") {
        throw notProposed(row, "veto");
      }
      const { rows: window } = await ctx.client.query<{ open: boolean }>(
        `SELECT $1::timestamptz + make_interval(hours => ${VETO_WINDOW_HOURS}) > clock_timestamp() AS open`,
        [row.decided_at],
      );
      if (!window[0]?.open) {
        throw new CrossoverError(
          "VALIDATION",
          `The ${VETO_WINDOW_HOURS}-hour window to veto this decision has passed`,
          { details: { decided_at: row.decided_at?.toISOString() ?? null } },
        );
      }
      const { rows } = await ctx.client.query<DecisionRow>(
        `UPDATE decisions
         SET status = 'VETOED', vetoed_by = $4, veto_rationale = $5, vetoed_at = clock_timestamp(),
             version = version + 1
         WHERE id = $1 AND room_id = $2 AND version = $3 AND status IN ('ACCEPTED', 'REJECTED')
         RETURNING ${DECISION_COLUMNS}`,
        [row.id, ctx.room_id, row.version, ctx.principal.participant_id, p.rationale],
      );
      const updated = rows[0];
      if (!updated) throw await decisionConflict(ctx.client, ctx.room_id, row.id);
      return {
        response: decisionView(updated, await loadPositions(ctx.client, ctx.room_id, row.id)),
        events: [
          {
            type: "decision.vetoed" as const,
            payload: {
              decision_id: row.id,
              previous_status: row.status,
              rationale: p.rationale,
              vetoed_by: ctx.principal.participant_id,
              from_version: row.version,
              version: updated.version,
            },
          },
        ],
      };
    },
  });

  dispatcher.registerCommand({
    method: "decisions.withdraw",
    mutating: true,
    params: decisionsWithdrawParams,
    execute: async (ctx, p) => {
      const row = await loadDecision(ctx.client, ctx.room_id, p.decision_id, true);
      if (row.proposed_by !== ctx.principal.participant_id) {
        throw new CrossoverError("FORBIDDEN", "Only the proposer can withdraw a decision", {
          details: { reason: "not_proposer" },
        });
      }
      if (row.version !== p.expected_version) {
        throw await decisionConflict(ctx.client, ctx.room_id, row.id);
      }
      if (row.status !== "PROPOSED") throw notProposed(row, "withdraw");
      const { rows } = await ctx.client.query<DecisionRow>(
        `UPDATE decisions SET status = 'WITHDRAWN', version = version + 1
         WHERE id = $1 AND room_id = $2 AND version = $3 AND status = 'PROPOSED'
         RETURNING ${DECISION_COLUMNS}`,
        [row.id, ctx.room_id, row.version],
      );
      const updated = rows[0];
      if (!updated) throw await decisionConflict(ctx.client, ctx.room_id, row.id);
      return {
        response: decisionView(updated, await loadPositions(ctx.client, ctx.room_id, row.id)),
        events: [
          {
            type: "decision.withdrawn" as const,
            payload: {
              decision_id: row.id,
              withdrawn_by: ctx.principal.participant_id,
              from_version: row.version,
              version: updated.version,
            },
          },
        ],
      };
    },
  });

  dispatcher.registerCommand({
    method: "decisions.get",
    action: "decisions.read",
    mutating: false,
    params: decisionsGetParams,
    execute: async (ctx, p) => {
      const row = await loadDecision(ctx.client, ctx.room_id, p.decision_id);
      return {
        response: decisionView(row, await loadPositions(ctx.client, ctx.room_id, row.id)),
      };
    },
  });

  dispatcher.registerCommand({
    method: "decisions.list",
    action: "decisions.read",
    mutating: false,
    params: decisionsListParams,
    execute: async (ctx, p) => {
      const { rows } = await ctx.client.query<DecisionRow & { position_count: number }>(
        `SELECT ${DECISION_COLUMNS.split(",")
          .map((c) => `d.${c.trim()}`)
          .join(", ")},
                (SELECT count(*)::int FROM decision_positions x WHERE x.decision_id = d.id) AS position_count
         FROM decisions d
         WHERE d.room_id = $1
           AND ($2::text[] IS NULL OR d.status = ANY($2::text[]))
           AND ($3::text IS NULL OR d.id > $3)
         ORDER BY d.id
         LIMIT $4`,
        [ctx.room_id, p.status ?? null, p.after ?? null, p.limit],
      );
      const decisions = rows.map(({ position_count, ...row }) => {
        const { positions: _positions, ...view } = decisionView(row);
        void _positions;
        return { ...view, position_count };
      });
      const last = rows[rows.length - 1];
      return {
        response: {
          decisions,
          next_after: rows.length === p.limit && last ? last.id : null,
        },
      };
    },
  });
}
