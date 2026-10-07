import { CrossoverError } from "@crossover/protocol";
import type { PoolClient } from "@crossover/db";
import { z } from "zod";
import type { Dispatcher } from "../../dispatcher.js";
import { revokeParticipantTokens } from "../auth/tokens.js";
import { restartAgentLeases } from "../tasks/task.js";

const params = z.strictObject({ participant_id: z.string().min(1).max(100) });

interface Row {
  id: string;
  kind: "HUMAN" | "AGENT";
  authority: "OWNER" | "ADMIN" | "MEMBER";
  role: "LEAD" | "DEVELOPER" | "REVIEWER" | "OBSERVER";
  status: "INVITED" | "ACTIVE" | "PAUSED" | "REMOVED";
}

function validation(message: string, details?: Record<string, unknown>): CrossoverError {
  return new CrossoverError("VALIDATION", message, details ? { details } : {});
}

function forbidden(message: string, reason: string): CrossoverError {
  return new CrossoverError("FORBIDDEN", message, { details: { reason } });
}

export interface RemovalInfo {
  room_id: string;
  participant_id: string;
  removed_by: string;
}

export interface ParticipantLifecycleOptions {
  /**
   * Runs inside the removal's transaction, after the participant is marked `REMOVED` and
   * their tokens are revoked: release their claimed tasks to OPEN, and so on (§22.1). If it
   * throws, the removal rolls back.
   */
  onRemove?: (client: PoolClient, info: RemovalInfo) => Promise<void>;
  /** Runs once the removal has committed, on the room's actor: close sockets, destroy the sandbox. */
  afterRemove?: (info: RemovalInfo) => void | Promise<void>;
}

/**
 * Register `participants.pause`, `participants.resume` and `participants.remove` (T212,
 * ARCHITECTURE §22.1, §6.3). The dispatcher has checked the capability (owner and admin
 * have all three; the lead role has pause and resume); these are the limits on top.
 *
 * **Pause** freezes a participant: they still authenticate (their tokens stay valid), and the
 * policy answers `PARTICIPANT_PAUSED` to every command they send. Only an `ACTIVE`
 * participant can be paused.
 * - Nobody can pause the owner or themselves; only the owner can pause an admin.
 * - Only the owner or an admin can pause a human: the **lead cannot pause humans**.
 *
 * **Resume** undoes a pause. Same limits, plus: **an agent can't un-pause what a human
 * paused**. Who paused is read from the ledger (the latest `participant.paused` event for the
 * target); if there is none, the pause is treated as a human's.
 *
 * **Remove** is permanent: the participant is marked `REMOVED` and every token they hold is
 * revoked in the same transaction, so their next request is `UNAUTHENTICATED`. Owner and
 * admin only; nobody can remove the owner or themselves, only the owner can remove an admin,
 * and the lead can't be removed (appoint another with `room.set_lead` first, so the room
 * always has one). Task release and sandbox cleanup are the `onRemove` / `afterRemove` hooks.
 *
 * A pause or resume that changes nothing (already paused, already active) emits no event.
 */
export function registerParticipantLifecycleCommands(
  dispatcher: Dispatcher,
  options: ParticipantLifecycleOptions = {},
): void {
  type Ctx = Parameters<Parameters<typeof dispatcher.registerCommand>[0]["execute"]>[0];

  async function load(ctx: Ctx, participantId: string) {
    const query = (id: string, lock: string) =>
      ctx.client.query<Row>(
        `SELECT id, kind, authority, role, status FROM participants WHERE id = $1 AND room_id = $2 ${lock}`,
        [id, ctx.room_id],
      );
    const target = (await query(participantId, "FOR UPDATE")).rows[0];
    if (!target) throw new CrossoverError("NOT_FOUND", `Participant ${participantId} not found`);
    const actor = (await query(ctx.principal.participant_id, "")).rows[0];
    if (!actor) throw forbidden("Not a participant of this room", "not_a_participant");
    return { actor, target };
  }

  /** Limits shared by pause, resume and remove: who may touch the owner and admins. */
  function guardGoverning(actor: Row, target: Row): void {
    if (target.authority === "OWNER") throw forbidden("Nobody can do that to the owner", "owner");
    if (target.authority === "ADMIN" && actor.authority !== "OWNER") {
      throw forbidden("Only the owner can do that to an admin", "governing_target");
    }
  }

  const governs = (actor: Row) => actor.authority === "OWNER" || actor.authority === "ADMIN";

  /** Was this participant's current pause made by a human? Unknown counts as human. */
  async function pausedByHuman(ctx: Ctx, targetId: string): Promise<boolean> {
    const { rows } = await ctx.client.query<{ kind: string | null }>(
      `SELECT p.kind
       FROM (SELECT actor_id FROM events
             WHERE room_id = $1 AND type = 'participant.paused' AND payload ->> 'participant_id' = $2
             ORDER BY sequence DESC LIMIT 1) e
       LEFT JOIN participants p ON p.id = e.actor_id AND p.room_id = $1`,
      [ctx.room_id, targetId],
    );
    const kind = rows[0]?.kind;
    return kind !== "AGENT";
  }

  dispatcher.registerCommand({
    method: "participants.pause",
    mutating: true,
    params,
    execute: async (ctx, p) => {
      const { actor, target } = await load(ctx, p.participant_id);
      if (target.id === actor.id) throw validation("You can't pause yourself");
      if (target.status === "REMOVED")
        throw validation(`Participant ${target.id} has been removed`);
      if (target.status === "INVITED")
        throw validation(`Participant ${target.id} hasn't joined yet`);
      guardGoverning(actor, target);
      if (!governs(actor) && target.kind === "HUMAN") {
        throw forbidden("The lead can't pause humans (§22.1)", "lead_human");
      }
      const changed = target.status === "ACTIVE";
      if (changed) {
        await ctx.client.query(
          "UPDATE participants SET status = 'PAUSED' WHERE id = $1 AND room_id = $2",
          [target.id, ctx.room_id],
        );
      }
      return {
        response: { participant_id: target.id, status: "PAUSED" as const, changed },
        events: changed
          ? [
              {
                type: "participant.paused" as const,
                payload: { participant_id: target.id, paused_by: actor.id },
              },
            ]
          : [],
      };
    },
  });

  dispatcher.registerCommand({
    method: "participants.resume",
    mutating: true,
    params,
    execute: async (ctx, p) => {
      const { actor, target } = await load(ctx, p.participant_id);
      if (target.status === "REMOVED")
        throw validation(`Participant ${target.id} has been removed`);
      if (target.status === "INVITED")
        throw validation(`Participant ${target.id} hasn't joined yet`);
      guardGoverning(actor, target);
      if (!governs(actor) && target.kind === "HUMAN") {
        throw forbidden("The lead can't resume humans (§22.1)", "lead_human");
      }
      const changed = target.status === "PAUSED";
      if (changed) {
        if (actor.kind === "AGENT" && (await pausedByHuman(ctx, target.id))) {
          throw forbidden(
            "Only a human can un-pause what a human paused (§6.3)",
            "paused_by_human",
          );
        }
        await ctx.client.query(
          "UPDATE participants SET status = 'ACTIVE' WHERE id = $1 AND room_id = $2",
          [target.id, ctx.room_id],
        );
        // Their claims were frozen while paused: the lease clock starts over (§22.1).
        await restartAgentLeases(ctx.client, ctx.room_id, target.id);
      }
      return {
        response: { participant_id: target.id, status: "ACTIVE" as const, changed },
        events: changed
          ? [
              {
                type: "participant.resumed" as const,
                payload: { participant_id: target.id, resumed_by: actor.id },
              },
            ]
          : [],
      };
    },
  });

  dispatcher.registerCommand({
    method: "participants.remove",
    mutating: true,
    params,
    execute: async (ctx, p) => {
      const { actor, target } = await load(ctx, p.participant_id);
      if (target.id === actor.id) throw validation("You can't remove yourself");
      if (target.status === "REMOVED")
        throw validation(`Participant ${target.id} is already removed`);
      guardGoverning(actor, target);
      if (target.role === "LEAD") {
        throw validation("Appoint another lead with room.set_lead before removing the lead", {
          participant_id: target.id,
        });
      }
      await ctx.client.query(
        "UPDATE participants SET status = 'REMOVED' WHERE id = $1 AND room_id = $2",
        [target.id, ctx.room_id],
      );
      const tokensRevoked = await revokeParticipantTokens(ctx.client, target.id);
      const info: RemovalInfo = {
        room_id: ctx.room_id,
        participant_id: target.id,
        removed_by: actor.id,
      };
      await options.onRemove?.(ctx.client, info);
      if (options.afterRemove) {
        const after = options.afterRemove;
        ctx.afterCommit(() => after(info));
      }
      return {
        response: {
          participant_id: target.id,
          status: "REMOVED" as const,
          tokens_revoked: tokensRevoked,
        },
        events: [
          {
            type: "participant.removed" as const,
            payload: {
              participant_id: target.id,
              removed_by: actor.id,
              tokens_revoked: tokensRevoked,
            },
          },
        ],
      };
    },
  });
}
