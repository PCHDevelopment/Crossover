import { CrossoverError, newId } from "@crossover/protocol";
import type { PoolClient } from "@crossover/db";
import {
  loadAuthorKinds,
  principalKinds,
  provenanceOf,
  type AuthorKinds,
  type Provenance,
} from "../provenance.js";
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
  /** An accepted decision of this room that this one replaces if it is accepted (§7.1 step 5). */
  supersedes: z.string().min(1).max(100).optional(),
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

export interface DecisionRow {
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
  veto_rationale: string | null;
  decide_by: Date | null;
  links: { kind: string; id: string }[];
  supersedes: string | null;
  version: number;
  created_at: Date;
  decided_at: Date | null;
  vetoed_at: Date | null;
}

export const DECISION_COLUMNS = `id, room_id, title, context, options, status, outcome_option_id, rationale,
  proposed_by, decided_by, vetoed_by, veto_rationale, decide_by, links, supersedes, version,
  created_at, decided_at, vetoed_at`;

export interface DecisionView extends Omit<
  DecisionRow,
  "decide_by" | "created_at" | "decided_at" | "vetoed_at"
> {
  decide_by: string | null;
  created_at: string;
  decided_at: string | null;
  vetoed_at: string | null;
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
    vetoed_at: iso(row.vetoed_at),
    positions,
  };
}

/** A decision as a reader gets it: who proposed it, and who took each position (§16.5). */
export interface LabeledDecision extends Omit<DecisionView, "positions"> {
  provenance: Provenance;
  positions: (PositionView & { provenance: Provenance })[];
}

export const labelDecision = (view: DecisionView, kinds: AuthorKinds): LabeledDecision => ({
  ...view,
  provenance: provenanceOf(kinds, view.proposed_by),
  positions: view.positions.map((p) => ({
    ...p,
    provenance: provenanceOf(kinds, p.participant_id),
  })),
});

/** `row` with its positions, labeled for a reader: the one way a read returns a decision. */
export async function labeledDecision(
  client: PoolClient,
  roomId: string,
  row: DecisionRow,
): Promise<LabeledDecision> {
  const positions = await loadPositions(client, roomId, row.id);
  const kinds = await loadAuthorKinds(client, roomId, [
    row.proposed_by,
    ...positions.map((p) => p.participant_id),
  ]);
  return labelDecision(decisionView(row, positions), kinds);
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
      if (p.supersedes !== undefined) {
        const old = await loadDecision(ctx.client, ctx.room_id, p.supersedes).catch(
          (e: unknown) => {
            if (e instanceof CrossoverError && e.code === "NOT_FOUND") {
              throw new CrossoverError(
                "VALIDATION",
                `Can't supersede unknown decision ${p.supersedes}`,
                {
                  details: { supersedes: p.supersedes },
                },
              );
            }
            throw e;
          },
        );
        if (old.status !== "ACCEPTED") {
          throw new CrossoverError(
            "VALIDATION",
            `Only an accepted decision can be superseded (${old.id} is ${old.status})`,
            { details: { supersedes: old.id, status: old.status } },
          );
        }
      }
      const options: DecisionOption[] = p.options.map((o, i) => ({
        id: `opt_${i + 1}`,
        summary: o.summary,
        detail: o.detail,
      }));
      const { rows } = await ctx.client.query<DecisionRow>(
        `INSERT INTO decisions (id, room_id, title, context, options, proposed_by, decide_by, links, supersedes)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb, $9)
         RETURNING ${DECISION_COLUMNS}`,
        [
          newId("dec"),
          ctx.room_id,
          p.title,
          p.context,
          JSON.stringify(options),
          ctx.principal.participant_id,
          p.decide_by ?? null,
          JSON.stringify(p.links),
          p.supersedes ?? null,
        ],
      );
      const decision = decisionView(rows[0]!);
      return {
        response: labelDecision(decision, principalKinds(ctx.principal)),
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
        `SELECT ${DECISION_COLUMNS} FROM decisions WHERE id = $1 AND room_id = $2 FOR UPDATE`,
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

/** A decision's positions, oldest first. */
export async function loadPositions(
  client: PoolClient,
  roomId: string,
  decisionId: string,
): Promise<PositionView[]> {
  const { rows } = await client.query<{
    participant_id: string;
    option_id: string;
    argument: string;
    created_at: Date;
  }>(
    `SELECT participant_id, option_id, argument, created_at FROM decision_positions
     WHERE decision_id = $1 AND room_id = $2 ORDER BY created_at, participant_id`,
    [decisionId, roomId],
  );
  return rows.map((r) => ({ ...r, created_at: r.created_at.toISOString() }));
}

/** One decision with its positions; `NOT_FOUND` if it isn't this room's. */
export async function loadDecision(
  client: PoolClient,
  roomId: string,
  decisionId: string,
  forUpdate = false,
): Promise<DecisionRow> {
  const { rows } = await client.query<DecisionRow>(
    `SELECT ${DECISION_COLUMNS} FROM decisions WHERE id = $1 AND room_id = $2
     ${forUpdate ? "FOR UPDATE" : ""}`,
    [decisionId, roomId],
  );
  const row = rows[0];
  if (!row) throw new CrossoverError("NOT_FOUND", `Decision ${decisionId} not found`);
  return row;
}

/** The stale-write answer: `CONFLICT_VERSION` carrying the decision as it is now. */
export async function decisionConflict(
  client: PoolClient,
  roomId: string,
  decisionId: string,
): Promise<CrossoverError> {
  const row = await loadDecision(client, roomId, decisionId);
  const current = await labeledDecision(client, roomId, row);
  return new CrossoverError("CONFLICT_VERSION", "Decision was updated by another participant", {
    details: { current },
  });
}
