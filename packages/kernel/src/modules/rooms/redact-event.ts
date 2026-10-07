import type { PoolClient } from "@crossover/db";
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
 * Events the platform's own state is rebuilt from (the health gate reads `task.submitted` and
 * applied ChangeSets, a lead transfer reads its offer). They carry no user text, so redacting
 * one would only break behaviour.
 */
const isStateEvent = (type: string): boolean =>
  type.startsWith("workspace.") || type.startsWith("lead.") || type === "task.submitted";

const STORED_TOMBSTONE = JSON.stringify({ response: { redacted: true }, events: [] });

/** Blank an event's payload; the hash stays. */
async function tombstone(client: PoolClient, roomId: string, sequences: number[]): Promise<void> {
  await client.query(
    `UPDATE events SET payload = $3::jsonb, redacted = true
     WHERE room_id = $1 AND sequence = ANY($2::bigint[])`,
    [roomId, sequences, JSON.stringify(REDACTION_TOMBSTONE)],
  );
  // A replay of the command that wrote the event returns the stored response and events;
  // they must not give the text back.
  for (const sequence of sequences) {
    await client.query(
      `UPDATE idempotency_keys k SET response = $3::jsonb
       FROM participants p
       WHERE p.id = k.participant_id AND p.room_id = $1 AND k.response IS NOT NULL
         AND k.response -> 'events' @> jsonb_build_array(
               jsonb_build_object('room_id', $1::text, 'sequence', $2::bigint))`,
      [roomId, sequence, STORED_TOMBSTONE],
    );
  }
}

/**
 * The same text lives outside the ledger in the table the event was derived from. Blank those
 * copies too, and any other event that carries the same text. Returns every sequence redacted
 * beyond the one asked for.
 */
async function redactCopies(
  client: PoolClient,
  roomId: string,
  event: { type: string; payload: Record<string, unknown> },
): Promise<number[]> {
  const also: number[] = [];
  if (event.type === "message.sent" || event.type === "message.edited") {
    const messageId =
      event.type === "message.sent"
        ? (event.payload["message"] as { id?: unknown } | undefined)?.id
        : event.payload["message_id"];
    if (typeof messageId !== "string") return also;
    await client.query(
      "UPDATE messages SET body = '', redacted = true WHERE room_id = $1 AND id = $2",
      [roomId, messageId],
    );
    // A mention's inbox item quotes the message.
    await client.query(
      `UPDATE inbox_items SET summary = '[redacted]'
       WHERE room_id = $1 AND ref ->> 'kind' = 'message' AND ref ->> 'id' = $2`,
      [roomId, messageId],
    );
    // The message's other events (its send, its edits) carry the text too.
    const { rows } = await client.query<{ sequence: string }>(
      `SELECT sequence FROM events
       WHERE room_id = $1 AND NOT redacted
         AND ((type = 'message.sent' AND payload -> 'message' ->> 'id' = $2)
           OR (type = 'message.edited' AND payload ->> 'message_id' = $2))
       ORDER BY sequence`,
      [roomId, messageId],
    );
    also.push(...rows.map((r) => Number(r.sequence)));
  } else if (event.type === "memory.updated") {
    const key = event.payload["key"];
    const revision = event.payload["revision"];
    if (typeof key === "string" && typeof revision === "number") {
      await client.query(
        `UPDATE memory_revisions SET value = '', redacted = true
         WHERE room_id = $1 AND key = $2 AND revision = $3`,
        [roomId, key, revision],
      );
      await client.query(
        `UPDATE memory_entries SET value = '', redacted = true
         WHERE room_id = $1 AND key = $2 AND revision = $3`,
        [roomId, key, revision],
      );
    }
  }
  return also;
}

/**
 * Register `events.redact { sequence, reason }` (T906, §19.6): the owner replaces an event's
 * payload with a tombstone (`{ redacted: true }`) and sets its `redacted` flag, for a secret
 * that got into the ledger. `payload_hash` is kept, so the ledger still shows that the event was
 * there and what it hashed to (which also lets someone confirm a guess at a short secret: don't
 * rely on it for low-entropy text). An `event.redacted` event, authored by the owner, records
 * which sequence, its type, and the reason (shown to everyone who reads the ledger: don't repeat
 * the secret in it).
 *
 * Redaction reaches the copies a reader can still fetch:
 * - **`message.sent` / `message.edited`:** the message row is blanked and flagged (`messages.list`
 *   then returns `redacted: true` and no body), every event of that message (its send and its
 *   edits) is tombstoned too, and the `MENTION` inbox items quoting it say `[redacted]`. A
 *   redacted message can't be edited.
 * - **`memory.updated`:** that revision's value is blanked and flagged in `memory_revisions`,
 *   and in `memory_entries` if it is still the current one.
 * - **The stored response of an idempotent command** that wrote a redacted event: a replay of
 *   it returns a tombstone, not the original text.
 * - **Task text** (`task.created`, `task.updated`) is not reached: edit it with `tasks.update`.
 *
 * Every ledger read (the REST list, the WebSocket backfill, digests) reads the stored row, so
 * the payload is gone from all of them at once. It is `NOT_FOUND` for a sequence the room
 * doesn't have, and `VALIDATION` for one already redacted, for an `event.redacted` event (the
 * record of redactions can't be erased), and for the platform's own state-bearing events
 * (`workspace.*`, `lead.*`, `task.submitted`). The owner only (`FORBIDDEN` for anyone else, by
 * the policy).
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
        payload: Record<string, unknown>;
      }>(
        `SELECT type, redacted, payload_hash, payload FROM events
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
      if (isStateEvent(event.type)) {
        throw new CrossoverError(
          "VALIDATION",
          "The platform's own state events can't be redacted",
          {
            details: { reason: "state_event", event_type: event.type },
          },
        );
      }
      if (event.redacted) {
        throw new CrossoverError("VALIDATION", "That event is already redacted", {
          details: { reason: "already_redacted" },
        });
      }
      const others = (await redactCopies(ctx.client, ctx.room_id, event)).filter(
        (sequence) => sequence !== p.sequence,
      );
      await tombstone(ctx.client, ctx.room_id, [p.sequence, ...others]);
      const redaction = {
        sequence: p.sequence,
        event_type: event.type,
        payload_hash: event.payload_hash,
        reason: p.reason,
        ...(others.length > 0 ? { also_redacted: others } : {}),
      };
      return {
        response: redaction,
        events: [{ type: "event.redacted" as const, payload: redaction }],
      };
    },
  });
}
