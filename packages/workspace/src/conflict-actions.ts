import type { PoolClient } from "@crossover/db";
import { deliverInbox, type Dispatcher, type EmittedEvent } from "@crossover/kernel";
import { CrossoverError } from "@crossover/protocol";
import { z } from "zod";

const abandonParamsSchema = z.strictObject({ conflict_id: z.string().min(1) });

interface EscalationTarget {
  id: string;
  status: string;
  changeset_id: string;
  submitter_id: string;
  attempts: number;
  owner_id: string;
  lead_participant_id: string | null;
}

/** Escalate a locked open conflict and create its inbox item in the caller's transaction. */
export async function escalateOpenConflict(
  client: PoolClient,
  roomId: string,
  conflict: EscalationTarget,
  trigger: "attempts" | "timeout" | "manual",
): Promise<EmittedEvent | undefined> {
  if (conflict.status !== "OPEN") return undefined;
  const recipient =
    conflict.lead_participant_id && conflict.lead_participant_id !== conflict.submitter_id
      ? conflict.lead_participant_id
      : conflict.owner_id;
  await client.query(
    `UPDATE conflicts SET status = 'ESCALATED', escalated_at = clock_timestamp()
     WHERE id = $1 AND room_id = $2 AND status = 'OPEN'`,
    [conflict.id, roomId],
  );
  await deliverInbox(client, roomId, recipient, {
    kind: "ESCALATION",
    ref: { kind: "conflict", id: conflict.id },
    summary: "Conflict requires your decision.",
    author_id: "system",
  });
  return {
    type: "workspace.conflict.escalated",
    payload: {
      conflict_id: conflict.id,
      changeset_id: conflict.changeset_id,
      submitter_id: conflict.submitter_id,
      escalated_to: recipient,
      trigger,
    },
  };
}

/** Register the mutating conflict lifecycle actions (T604, T605). */
export function registerWorkspaceConflictActions(dispatcher: Dispatcher): void {
  dispatcher.registerCommand({
    method: "conflicts.escalate",
    action: "conflicts.escalate",
    mutating: true,
    params: abandonParamsSchema,
    execute: async (ctx, params) => {
      const { rows } = await ctx.client.query<
        EscalationTarget & {
          submitter_kind: "HUMAN" | "AGENT";
          created_at: Date;
          observed_at: Date;
        }
      >(
        `SELECT c.id, c.status, c.changeset_id, c.submitter_id, c.attempts, c.created_at,
                p.kind AS submitter_kind, clock_timestamp() AS observed_at,
                r.owner_id, r.lead_participant_id
         FROM conflicts c JOIN rooms r ON r.id = c.room_id
         JOIN participants p ON p.id = c.submitter_id AND p.room_id = c.room_id
         WHERE c.id = $1 AND c.room_id = $2
         FOR UPDATE OF c`,
        [params.conflict_id, ctx.room_id],
      );
      const conflict = rows[0];
      if (!conflict) throw new CrossoverError("NOT_FOUND", "Conflict not found");
      if (ctx.principal.participant_id !== conflict.submitter_id)
        throw new CrossoverError("FORBIDDEN", "Only the conflict submitter may escalate it");
      if (conflict.status === "ESCALATED")
        return { response: { conflict_id: conflict.id, status: "ESCALATED" as const } };
      if (conflict.status !== "OPEN")
        throw new CrossoverError("CONFLICT_VERSION", "Conflict is no longer open", {
          details: { status: conflict.status },
        });
      const expiredAgentWindow =
        conflict.submitter_kind === "AGENT" &&
        conflict.created_at.getTime() <= conflict.observed_at.getTime() - 10 * 60 * 1000;
      const trigger =
        conflict.attempts >= 2 ? "attempts" : expiredAgentWindow ? "timeout" : "manual";
      const event = await escalateOpenConflict(ctx.client, ctx.room_id, conflict, trigger);
      return {
        response: { conflict_id: conflict.id, status: "ESCALATED" as const },
        events: event ? [event] : [],
      };
    },
  });

  dispatcher.registerCommand({
    method: "conflicts.abandon",
    action: "conflicts.abandon",
    mutating: true,
    params: abandonParamsSchema,
    execute: async (ctx, params) => {
      const { rows } = await ctx.client.query<{
        id: string;
        status: string;
        changeset_id: string;
        submitter_id: string;
        owner_id: string;
        lead_participant_id: string | null;
      }>(
        `SELECT c.id, c.status, c.changeset_id, c.submitter_id,
                r.owner_id, r.lead_participant_id
         FROM conflicts c JOIN rooms r ON r.id = c.room_id
         WHERE c.id = $1 AND c.room_id = $2
         FOR UPDATE OF c`,
        [params.conflict_id, ctx.room_id],
      );
      const conflict = rows[0];
      if (!conflict) throw new CrossoverError("NOT_FOUND", "Conflict not found");
      if (conflict.status !== "OPEN" && conflict.status !== "ESCALATED")
        throw new CrossoverError("CONFLICT_VERSION", "Conflict is no longer open", {
          details: { status: conflict.status },
        });
      if (
        ctx.principal.participant_id !== conflict.submitter_id &&
        ctx.principal.participant_id !== conflict.lead_participant_id &&
        ctx.principal.participant_id !== conflict.owner_id
      )
        throw new CrossoverError(
          "FORBIDDEN",
          "Only the submitter, lead, or owner may abandon a conflict",
        );

      await ctx.client.query(
        "UPDATE conflicts SET status = 'ABANDONED' WHERE id = $1 AND room_id = $2",
        [conflict.id, ctx.room_id],
      );
      await ctx.client.query(
        `UPDATE changesets SET status = 'REJECTED', rejection_reason = 'ABANDONED',
         rejected_at = clock_timestamp()
         WHERE id = $1 AND room_id = $2`,
        [conflict.changeset_id, ctx.room_id],
      );
      return {
        response: {
          conflict_id: conflict.id,
          changeset_id: conflict.changeset_id,
          status: "ABANDONED" as const,
        },
        events: [
          {
            type: "workspace.conflict.abandoned" as const,
            payload: {
              conflict_id: conflict.id,
              changeset_id: conflict.changeset_id,
              submitter_id: conflict.submitter_id,
              abandoned_by: ctx.principal.participant_id,
            },
          },
        ],
      };
    },
  });
}
