import { CrossoverError } from "@crossover/protocol";
import { z } from "zod";
import type { CommandContext, Dispatcher } from "../../dispatcher.js";

/** How long a lead transfer offer can be accepted (§6.4). */
export const LEAD_OFFER_TTL_SECONDS = 10 * 60;

const target = z.strictObject({ participant_id: z.string().min(1).max(100) });
const none = z.strictObject({});

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

async function loadParticipant(
  ctx: CommandContext,
  id: string,
  lock = "",
): Promise<Row | undefined> {
  const { rows } = await ctx.client.query<Row>(
    `SELECT id, kind, authority, role, status FROM participants WHERE id = $1 AND room_id = $2 ${lock}`,
    [id, ctx.room_id],
  );
  return rows[0];
}

/** The room's one lead. More or fewer than one is a bug elsewhere: refuse rather than guess. */
async function currentLead(ctx: CommandContext): Promise<Row> {
  const { rows } = await ctx.client.query<Row>(
    `SELECT id, kind, authority, role, status FROM participants
     WHERE room_id = $1 AND role = 'LEAD' AND status <> 'REMOVED' FOR UPDATE`,
    [ctx.room_id],
  );
  if (rows.length !== 1) {
    throw new Error(`room ${ctx.room_id} has ${rows.length} leads; expected exactly one`);
  }
  return rows[0]!;
}

/** Make `to` the lead and the old lead a developer, keeping `rooms.lead_participant_id` in step. */
async function changeLead(
  ctx: CommandContext,
  from: Row,
  to: Row,
  reason: "appointed" | "transfer_accepted",
) {
  await ctx.client.query(
    "UPDATE participants SET role = 'DEVELOPER' WHERE id = $1 AND room_id = $2",
    [from.id, ctx.room_id],
  );
  await ctx.client.query("UPDATE participants SET role = 'LEAD' WHERE id = $1 AND room_id = $2", [
    to.id,
    ctx.room_id,
  ]);
  await ctx.client.query("UPDATE rooms SET lead_participant_id = $2 WHERE id = $1", [
    ctx.room_id,
    to.id,
  ]);
  return {
    type: "lead.changed" as const,
    payload: { from: from.id, to: to.id, reason, changed_by: ctx.principal.participant_id },
  };
}

/**
 * Register `room.set_lead`, `room.transfer_lead` and `room.accept_lead` (T213, §6.4).
 *
 * There is always exactly one lead (the `LEAD` participant, mirrored in
 * `rooms.lead_participant_id`). The old lead becomes a `DEVELOPER`.
 * - **`room.set_lead`** (owner, admin): appoints any `ACTIVE` participant at once.
 * - **`room.transfer_lead`** (the current lead): offers the lead to an `ACTIVE` participant
 *   who can accept; emits `lead.transfer_offered` with an `expires_at` ten minutes ahead. A
 *   newer offer replaces an older one.
 * - **`room.accept_lead`** (the one offered): within ten minutes, and only while the offering
 *   lead is still the lead, makes them lead. Later, or after any other `lead.changed`, it is a
 *   `VALIDATION` error and the lead is unchanged.
 *
 * Offers live in the ledger, not in a table: the latest `lead.transfer_offered` event is the
 * pending offer unless a later `lead.changed` voided it.
 */
export function registerLeadCommands(dispatcher: Dispatcher): void {
  dispatcher.registerCommand({
    method: "room.set_lead",
    mutating: true,
    params: target,
    execute: async (ctx, p) => {
      const to = await loadParticipant(ctx, p.participant_id, "FOR UPDATE");
      if (!to) throw new CrossoverError("NOT_FOUND", `Participant ${p.participant_id} not found`);
      if (to.status !== "ACTIVE") {
        throw validation(`The lead must be an active participant (${to.id} is ${to.status})`);
      }
      const from = await currentLead(ctx);
      if (from.id === to.id) {
        return { response: { lead: to.id, previous_lead: from.id, changed: false } };
      }
      const event = await changeLead(ctx, from, to, "appointed");
      return {
        response: { lead: to.id, previous_lead: from.id, changed: true },
        events: [event],
      };
    },
  });

  dispatcher.registerCommand({
    method: "room.transfer_lead",
    mutating: true,
    params: target,
    execute: async (ctx, p) => {
      const lead = await currentLead(ctx);
      if (lead.id !== ctx.principal.participant_id) {
        throw new CrossoverError("FORBIDDEN", "Only the current lead can offer the lead", {
          details: { reason: "not_the_lead" },
        });
      }
      if (p.participant_id === lead.id) throw validation("You are already the lead");
      const to = await loadParticipant(ctx, p.participant_id);
      if (!to) throw new CrossoverError("NOT_FOUND", `Participant ${p.participant_id} not found`);
      if (to.status !== "ACTIVE") {
        throw validation(`The lead must be an active participant (${to.id} is ${to.status})`);
      }
      // An offer nobody can accept is a mistake: check the recipient could (not an observer).
      try {
        await ctx.authorizeAs(to.id, "room.accept_lead");
      } catch (err) {
        if (err instanceof CrossoverError && err.code === "FORBIDDEN") {
          throw validation(`${to.id} (${to.role}) can't accept the lead`, {
            participant_id: to.id,
          });
        }
        throw err;
      }
      const { rows } = await ctx.client.query<{ expires_at: Date }>(
        "SELECT clock_timestamp() + make_interval(secs => $1) AS expires_at",
        [LEAD_OFFER_TTL_SECONDS],
      );
      const expiresAt = rows[0]!.expires_at.toISOString();
      return {
        response: { from: lead.id, to: to.id, expires_at: expiresAt },
        events: [
          {
            type: "lead.transfer_offered" as const,
            payload: { from: lead.id, to: to.id, expires_at: expiresAt },
          },
        ],
      };
    },
  });

  dispatcher.registerCommand({
    method: "room.accept_lead",
    mutating: true,
    params: none,
    execute: async (ctx) => {
      const me = ctx.principal.participant_id;
      const { rows } = await ctx.client.query<{
        sequence: string;
        payload: { from: string; to: string; expires_at: string };
        expired: boolean;
        voided: boolean;
      }>(
        `SELECT o.sequence, o.payload,
                (o.payload ->> 'expires_at')::timestamptz <= clock_timestamp() AS expired,
                EXISTS (SELECT 1 FROM events c
                         WHERE c.room_id = o.room_id AND c.type = 'lead.changed'
                           AND c.sequence > o.sequence) AS voided
         FROM events o
         WHERE o.room_id = $1 AND o.type = 'lead.transfer_offered'
         ORDER BY o.sequence DESC LIMIT 1`,
        [ctx.room_id],
      );
      const offer = rows[0];
      if (!offer || offer.payload.to !== me) {
        throw new CrossoverError("NOT_FOUND", "No pending lead offer for you");
      }
      if (offer.voided) throw validation("That lead offer is no longer valid");
      if (offer.expired) throw validation("That lead offer has expired (offers last 10 minutes)");

      const from = await currentLead(ctx);
      if (from.id !== offer.payload.from) throw validation("That lead offer is no longer valid");
      const to = await loadParticipant(ctx, me, "FOR UPDATE");
      if (!to || to.status !== "ACTIVE") throw validation("Only an active participant can lead");
      const event = await changeLead(ctx, from, to, "transfer_accepted");
      return {
        response: { lead: to.id, previous_lead: from.id, changed: true },
        events: [event],
      };
    },
  });
}
