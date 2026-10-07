import { CrossoverError } from "@crossover/protocol";
import { z } from "zod";
import type { Dispatcher } from "../../dispatcher.js";

/** What a redacted event's payload is replaced with. */
export const REDACTION_TOMBSTONE = { redacted: true } as const;

export const eventsRedactParams = z.strictObject({
  sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  /** Why, for the record. It is shown to everyone who reads the ledger: don't repeat the secret. */
  reason: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .refine((v) => !v.includes("\0"), "Text contains NUL"),
});

/**
 * Register `events.redact { sequence, reason }` (T906, §19.6): the owner replaces an event's
 * payload with a tombstone (`{ redacted: true }`) and sets its `redacted` flag, for a secret
 * that got into the ledger. `payload_hash` is kept, so the ledger's audit trail still shows
 * that the event was there and what it hashed to. An `event.redacted` event, authored by the
 * owner, records which sequence, its type, and the reason.
 *
 * Every read of the ledger (the REST list, the WebSocket backfill, digests) reads the stored
 * row, so the original payload is gone from all of them at once. It is `NOT_FOUND` for a
 * sequence the room doesn't have, `VALIDATION` for one already redacted, and for an
 * `event.redacted` event itself (the record of redactions can't be erased). The owner only
 * (`FORBIDDEN` for anyone else, by the policy).
 *
 * This redacts the event. Where the same text also lives in a table the event was derived from
 * (a message's body, a memory value), that copy is not touched.
 */
export function registerEventsRedactCommand(dispatcher: Dispatcher): void {
  dispatcher.registerCommand({
    method: "events.redact",
    mutating: true,
    params: eventsRedactParams,
    execute: async (ctx, p) => {
      const { rows } = await ctx.client.query<{
        type: string;
        redacted: boolean;
        payload_hash: string;
      }>(
        `SELECT type, redacted, payload_hash FROM events
         WHERE room_id = $1 AND sequence = $2 FOR UPDATE`,
        [ctx.room_id, p.sequence],
      );
      const event = rows[0];
      if (!event) throw new CrossoverError("NOT_FOUND", `Event ${p.sequence} not found`);
      if (event.type === "event.redacted") {
        throw new CrossoverError("VALIDATION", "A redaction record can't itself be redacted", {
          details: { reason: "redaction_record" },
        });
      }
      if (event.redacted) {
        throw new CrossoverError("VALIDATION", "That event is already redacted", {
          details: { reason: "already_redacted" },
        });
      }
      await ctx.client.query(
        `UPDATE events SET payload = $3::jsonb, redacted = true
         WHERE room_id = $1 AND sequence = $2`,
        [ctx.room_id, p.sequence, JSON.stringify(REDACTION_TOMBSTONE)],
      );
      const redaction = {
        sequence: p.sequence,
        event_type: event.type,
        payload_hash: event.payload_hash,
        reason: p.reason,
      };
      return {
        response: redaction,
        events: [{ type: "event.redacted" as const, payload: redaction }],
      };
    },
  });
}
