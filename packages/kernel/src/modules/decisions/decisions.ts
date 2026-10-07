import { CrossoverError, newId } from "@crossover/protocol";
import { z } from "zod";
import type { Dispatcher } from "../../dispatcher.js";

export const MAX_OPTIONS = 10;
export const MAX_DECISION_LINKS = 20;

const link = z.strictObject({
  /** What it concerns: `task`, `changeset`, `conflict`, `memory`, `file`… */
  kind: z.string().regex(/^[a-z][a-z_]{0,31}$/),
  id: z.string().min(1).max(512),
});

const option = z.strictObject({
  summary: z.string().trim().min(1).max(200),
  detail: z.string().max(5000).default(""),
});

export const decisionsProposeParams = z.strictObject({
  title: z.string().trim().min(1).max(200),
  context: z.string().max(20_000).default(""),
  /** At least two; the server gives each an id (`opt_1`, `opt_2`, …) in the order given. */
  options: z.array(option).min(2).max(MAX_OPTIONS),
  /** When the lead should have decided by. */
  decide_by: z.iso.datetime({ offset: true }).optional(),
  links: z.array(link).max(MAX_DECISION_LINKS).default([]),
});

export const decisionsAddPositionParams = z.strictObject({
  decision_id: z.string().min(1).max(100),
  option_id: z.string().min(1).max(100),
  argument: z.string().trim().min(1).max(10_000),
});

export interface DecisionOption {
  id: string;
  summary: string;
  detail: string;
}

interface DecisionRow {
  id: string;
  room_id: string;
  title: string;
  context: string;
  options: DecisionOption[];
  status: string;
  outcome_option_id: string | null;
  rationale: string | null;
  proposed_by: string;
  decided_by: string | null;
  vetoed_by: string | null;
  decide_by: Date | null;
  links: { kind: string; id: string }[];
  supersedes: string | null;
  version: number;
  created_at: Date;
  decided_at: Date | null;
}

const COLUMNS = `id, room_id, title, context, options, status, outcome_option_id, rationale,
  proposed_by, decided_by, vetoed_by, decide_by, links, supersedes, version, created_at, decided_at`;

export interface DecisionView extends Omit<DecisionRow, "decide_by" | "created_at" | "decided_at"> {
  decide_by: string | null;
  created_at: string;
  decided_at: string | null;
  positions: PositionView[];
}

export interface PositionView {
  participant_id: string;
  option_id: string;
  argument: string;
  created_at: string;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function decisionView(row: DecisionRow, positions: PositionView[] = []): DecisionView {
  return {
    ...row,
    decide_by: iso(row.decide_by),
    created_at: row.created_at.toISOString(),
    decided_at: iso(row.decided_at),
    positions,
  };
}

/**
 * Register `decisions.propose` and `decisions.add_position` (T404, §7.1-7.2).
 *
 * - **propose** opens a decision with context and at least two options (`PROPOSED`, version 1)
 *   and emits `decision.proposed`. `decide_by` must be in the future.
 * - **add_position** records the caller's chosen option and argument; one position per
 *   participant, and adding another **replaces** it. Only a `PROPOSED` decision takes positions
 *   (`VALIDATION` otherwise), the option must be one of its own, and an unknown decision is
 *   `NOT_FOUND`. Positions don't change the decision's version: they never make a lead's
 *   `expected_version` stale. Emits `decision.position_added` (`replaced` says which).
 */
export function registerDecisionCommands(dispatcher: Dispatcher): void {
  dispatcher.registerCommand({
    method: "decisions.propose",
    mutating: true,
    params: decisionsProposeParams,
    execute: async (ctx, p) => {
      if (p.decide_by !== undefined && new Date(p.decide_by).getTime() <= Date.now()) {
        throw new CrossoverError("VALIDATION", "decide_by must be in the future", {
          details: { decide_by: p.decide_by },
        });
      }
      const options: DecisionOption[] = p.options.map((o, i) => ({
        id: `opt_${i + 1}`,
        summary: o.summary,
        detail: o.detail,
      }));
      const { rows } = await ctx.client.query<DecisionRow>(
        `INSERT INTO decisions (id, room_id, title, context, options, proposed_by, decide_by, links)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb)
         RETURNING ${COLUMNS}`,
        [
          newId("dec"),
          ctx.room_id,
          p.title,
          p.context,
          JSON.stringify(options),
          ctx.principal.participant_id,
          p.decide_by ?? null,
          JSON.stringify(p.links),
        ],
      );
      const decision = decisionView(rows[0]!);
      return {
        response: decision,
        events: [{ type: "decision.proposed" as const, payload: { decision } }],
      };
    },
  });

  dispatcher.registerCommand({
    method: "decisions.add_position",
    mutating: true,
    params: decisionsAddPositionParams,
    execute: async (ctx, p) => {
      const { rows: found } = await ctx.client.query<DecisionRow>(
        `SELECT ${COLUMNS} FROM decisions WHERE id = $1 AND room_id = $2 FOR UPDATE`,
        [p.decision_id, ctx.room_id],
      );
      const decision = found[0];
      if (!decision) throw new CrossoverError("NOT_FOUND", `Decision ${p.decision_id} not found`);
      if (decision.status !== "PROPOSED") {
        throw new CrossoverError(
          "VALIDATION",
          `Decision ${decision.id} is ${decision.status}, so it takes no more positions`,
          { details: { status: decision.status } },
        );
      }
      if (!decision.options.some((o) => o.id === p.option_id)) {
        throw new CrossoverError(
          "VALIDATION",
          `Decision ${decision.id} has no option ${p.option_id}`,
          {
            details: { option_id: p.option_id, options: decision.options.map((o) => o.id) },
          },
        );
      }
      const me = ctx.principal.participant_id;
      const { rows } = await ctx.client.query<{ created_at: Date; replaced: boolean }>(
        `INSERT INTO decision_positions (decision_id, room_id, participant_id, option_id, argument)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (decision_id, participant_id) DO UPDATE
           SET option_id = EXCLUDED.option_id, argument = EXCLUDED.argument,
               updated_at = clock_timestamp()
         RETURNING created_at, (xmax <> 0) AS replaced`,
        [decision.id, ctx.room_id, me, p.option_id, p.argument],
      );
      const position = {
        decision_id: decision.id,
        participant_id: me,
        option_id: p.option_id,
        argument: p.argument,
        replaced: rows[0]!.replaced,
        created_at: rows[0]!.created_at.toISOString(),
      };
      return {
        response: position,
        events: [{ type: "decision.position_added" as const, payload: position }],
      };
    },
  });
}
