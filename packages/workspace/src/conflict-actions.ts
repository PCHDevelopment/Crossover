import type { Dispatcher } from "@crossover/kernel";
import { CrossoverError } from "@crossover/protocol";
import { z } from "zod";

const abandonParamsSchema = z.strictObject({ conflict_id: z.string().min(1) });

/** Register the mutating conflict lifecycle actions (T605). */
export function registerWorkspaceConflictActions(dispatcher: Dispatcher): void {
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
        `UPDATE changesets SET status = 'REJECTED', rejection_reason = 'ABANDONED'
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
