import { ROLE_BUNDLES, ROLES, type Role } from "@crossover/policy";
import { CrossoverError } from "@crossover/protocol";
import { z } from "zod";
import type { Dispatcher } from "../../dispatcher.js";

export const participantsSetRoleParams = z.strictObject({
  participant_id: z.string().min(1).max(100),
  role: z.enum(ROLES),
});

interface Row {
  id: string;
  kind: "HUMAN" | "AGENT";
  authority: "OWNER" | "ADMIN" | "MEMBER";
  role: Role;
  status: string;
}

function validation(message: string, details?: Record<string, unknown>): CrossoverError {
  return new CrossoverError("VALIDATION", message, details ? { details } : {});
}

function forbidden(message: string, reason: string): CrossoverError {
  return new CrossoverError("FORBIDDEN", message, { details: { reason } });
}

/**
 * Register `participants.set_role` (T211, ARCHITECTURE §6.1, §6.3).
 *
 * The dispatcher has already checked the `participants.set_role` capability (owner, admin and
 * the lead role have it); this adds the limits:
 * - the **lead is not changed here**: a new role of `LEAD`, or a target who is the lead, is a
 *   `VALIDATION` error pointing at `room.set_lead` (T213), so there is always exactly one lead;
 * - an **admin can't change the owner's role**;
 * - anyone who is not owner or admin (the lead) can't change the owner or an admin, and an
 *   **agent** lead can't change a human at all (§6.3), both `FORBIDDEN`;
 * - such an actor **never grants what it doesn't hold**: every capability the new role adds
 *   over the target's current one must be held by the actor right now (grants and revocations
 *   included), otherwise `FORBIDDEN` naming the missing capability.
 *
 * The role is read from the participant row on every command, so the change takes effect on
 * the target's next command. Setting the role a participant already has changes nothing and
 * emits no event.
 */
export function registerParticipantRoleCommand(dispatcher: Dispatcher): void {
  dispatcher.registerCommand({
    method: "participants.set_role",
    mutating: true,
    params: participantsSetRoleParams,
    execute: async (ctx, params) => {
      if (params.role === "LEAD") {
        throw validation("Use room.set_lead to appoint the lead", { role: params.role });
      }
      const query = (id: string, lock: string) =>
        ctx.client.query<Row>(
          `SELECT id, kind, authority, role, status FROM participants WHERE id = $1 AND room_id = $2 ${lock}`,
          [id, ctx.room_id],
        );
      const target = (await query(params.participant_id, "FOR UPDATE")).rows[0];
      if (!target) {
        throw new CrossoverError("NOT_FOUND", `Participant ${params.participant_id} not found`);
      }
      const actor = (await query(ctx.principal.participant_id, "")).rows[0];
      if (!actor) throw forbidden("Not a participant of this room", "not_a_participant");

      if (target.status === "REMOVED") {
        throw validation(`Participant ${target.id} has been removed`);
      }
      if (target.role === "LEAD") {
        throw validation("Use room.set_lead to replace the lead", { participant_id: target.id });
      }

      const governs = actor.authority === "OWNER" || actor.authority === "ADMIN";
      if (governs) {
        if (actor.authority === "ADMIN" && target.authority === "OWNER") {
          throw forbidden("Only the owner can change the owner's role", "owner_role");
        }
      } else {
        if (actor.kind === "AGENT" && target.kind !== "AGENT") {
          throw forbidden("An agent lead can't change a human's role (§6.3)", "agent_lead_human");
        }
        if (target.authority !== "MEMBER") {
          throw forbidden("The lead can't change the owner or an admin (§6.3)", "governing_target");
        }
        // Never grant what you don't hold: the capabilities this change adds.
        const current = ROLE_BUNDLES[target.role];
        for (const capability of [...ROLE_BUNDLES[params.role]].sort()) {
          if (!current.has(capability)) await ctx.authorize(capability);
        }
      }

      const changed = target.role !== params.role;
      if (changed) {
        await ctx.client.query("UPDATE participants SET role = $3 WHERE id = $1 AND room_id = $2", [
          target.id,
          ctx.room_id,
          params.role,
        ]);
      }
      const response = {
        participant_id: target.id,
        from_role: target.role,
        to_role: params.role,
        changed,
      };
      return {
        response,
        events: changed
          ? [
              {
                type: "participant.role_changed" as const,
                payload: {
                  participant_id: target.id,
                  from_role: target.role,
                  to_role: params.role,
                  changed_by: actor.id,
                },
              },
            ]
          : [],
      };
    },
  });
}
