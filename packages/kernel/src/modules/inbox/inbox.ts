import type { PoolClient } from "@crossover/db";
import { CrossoverError, newId } from "@crossover/protocol";
import { z } from "zod";
import type { Dispatcher } from "../../dispatcher.js";
import { loadAuthorKinds, provenanceOf, type AuthorKinds, type Provenance } from "../provenance.js";

/** What an inbox item asks for (§17.2). */
export const INBOX_KINDS = [
  "ASSIGNMENT",
  "REVIEW_REQUEST",
  "MENTION",
  "CONFLICT",
  "HEALTH_RED",
  "APPROVAL",
  "LEASE_WARNING",
  "LEASE_EXPIRED",
  "ESCALATION",
  "VETO",
  "LOOP_DETECTED",
  "MANIFEST_CHANGED",
] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];

export interface InboxRef {
  kind: string;
  id: string;
}

export interface InboxItemInput {
  kind: InboxKind;
  /** What it is about, e.g. `{ kind: "task", id: "task_…" }`. */
  ref: InboxRef;
  /** One line for the recipient, at most 500 characters. */
  summary: string;
  /**
   * Whose words the summary quotes: a participant's id (a mention's text, a task title they
   * wrote, a manifest they declared), or `"system"` when it is the platform's own wording.
   * Required, so a producer can't quote someone and read as the platform by omission.
   */
  author_id: string;
}

export interface InboxItem {
  id: string;
  kind: InboxKind;
  ref: InboxRef;
  summary: string;
  /** Who wrote the summary, and how far to trust it (§16.5). */
  provenance: Provenance;
  created_at: string;
  acked_at: string | null;
}

/**
 * Put an item in a participant's inbox (T402). Internal: the commands that cause something
 * for someone to look at call it inside their own transaction (so the item exists exactly when
 * the change does), with the room's `roomId`; the recipient must be a participant of that room
 * (a foreign key enforces it). Returns the new item's id.
 */
export async function deliverInbox(
  client: PoolClient,
  roomId: string,
  participantId: string,
  item: InboxItemInput,
): Promise<string> {
  const id = newId("inbox");
  await client.query(
    `INSERT INTO inbox_items (id, room_id, participant_id, kind, ref, summary, author_id, wake_notified_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7,
             CASE WHEN EXISTS (SELECT 1 FROM participants
                               WHERE id = $3 AND room_id = $2 AND kind = 'AGENT'
                                 AND agent_manifest ->> 'wake_webhook_url' IS NOT NULL)
                  THEN NULL ELSE clock_timestamp() END)`,
    [
      id,
      roomId,
      participantId,
      item.kind,
      JSON.stringify(item.ref),
      item.summary.slice(0, 500),
      item.author_id,
    ],
  );
  return id;
}

export const MAX_ACK = 100;
export const DEFAULT_INBOX_PAGE = 50;
export const MAX_INBOX_PAGE = 100;

export const inboxListParams = z.strictObject({
  /** Only items not yet acknowledged. Default true: the inbox is "what still needs me". */
  unacked_only: z.boolean().default(true),
  limit: z.number().int().min(1).max(MAX_INBOX_PAGE).default(DEFAULT_INBOX_PAGE),
  /** Continue after this item id (the last of the previous page). */
  after: z.string().min(1).max(100).optional(),
});

export const inboxAckParams = z.strictObject({
  ids: z.array(z.string().min(1).max(100)).min(1).max(MAX_ACK),
});

interface Row {
  id: string;
  kind: InboxKind;
  ref: InboxRef;
  summary: string;
  author_id: string;
  created_at: Date;
  acked_at: Date | null;
}

const view = (r: Row, kinds: AuthorKinds): InboxItem => ({
  id: r.id,
  kind: r.kind,
  ref: r.ref,
  summary: r.summary,
  provenance: provenanceOf(kinds, r.author_id),
  created_at: r.created_at.toISOString(),
  acked_at: r.acked_at ? r.acked_at.toISOString() : null,
});

/**
 * Register `inbox.list` and `inbox.ack` (T402). Everyone sees only their own inbox.
 *
 * - **list** returns the caller's items oldest first (the order to deal with them in), by
 *   default only the unacknowledged ones, paged with `after`.
 * - **ack** marks items acknowledged. It is idempotent (acking an acknowledged item is fine
 *   and changes nothing) and all-or-nothing: if any id isn't one of the caller's items, which
 *   includes another participant's, the whole request is `NOT_FOUND` and nothing is acked.
 */
export function registerInboxCommands(dispatcher: Dispatcher): void {
  dispatcher.registerCommand({
    method: "inbox.list",
    action: "inbox.read",
    mutating: false,
    view: "own",
    params: inboxListParams,
    execute: async (ctx, p) => {
      const me = ctx.principal.participant_id;
      const values: unknown[] = [ctx.room_id, me, p.limit + 1];
      let where = "room_id = $1 AND participant_id = $2";
      if (p.unacked_only) where += " AND acked_at IS NULL";
      if (p.after !== undefined) {
        const { rows } = await ctx.client.query<{ ts: string }>(
          `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ts
           FROM inbox_items WHERE id = $1 AND room_id = $2 AND participant_id = $3`,
          [p.after, ctx.room_id, me],
        );
        if (!rows[0]) throw new CrossoverError("NOT_FOUND", `Inbox item ${p.after} not found`);
        values.push(rows[0].ts, p.after);
        where += ` AND (created_at, id) > ($4::timestamptz, $5)`;
      }
      const { rows } = await ctx.client.query<Row>(
        `SELECT id, kind, ref, summary, author_id, created_at, acked_at FROM inbox_items
         WHERE ${where} ORDER BY created_at, id LIMIT $3`,
        values,
      );
      const page = rows.slice(0, p.limit);
      const kinds = await loadAuthorKinds(
        ctx.client,
        ctx.room_id,
        page.map((r) => r.author_id),
      );
      return {
        response: { items: page.map((r) => view(r, kinds)), has_more: rows.length > p.limit },
      };
    },
  });

  dispatcher.registerCommand({
    method: "inbox.ack",
    action: "inbox.ack",
    mutating: true,
    params: inboxAckParams,
    execute: async (ctx, p) => {
      const ids = [...new Set(p.ids)];
      const me = ctx.principal.participant_id;
      const { rows } = await ctx.client.query<{ id: string }>(
        "SELECT id FROM inbox_items WHERE room_id = $1 AND participant_id = $2 AND id = ANY($3::text[]) FOR UPDATE",
        [ctx.room_id, me, ids],
      );
      const mine = new Set(rows.map((r) => r.id));
      const missing = ids.filter((id) => !mine.has(id));
      if (missing.length > 0) {
        // Same answer for "doesn't exist" and "belongs to someone else".
        throw new CrossoverError("NOT_FOUND", `Inbox item ${missing[0]} not found`, {
          details: { ids: missing },
        });
      }
      const { rowCount } = await ctx.client.query(
        `UPDATE inbox_items SET acked_at = clock_timestamp()
         WHERE room_id = $1 AND participant_id = $2 AND id = ANY($3::text[]) AND acked_at IS NULL`,
        [ctx.room_id, me, ids],
      );
      return { response: { acked: rowCount ?? 0, ids } };
    },
  });
}

/**
 * The room's current lead, if there is one who hasn't been removed (T403). Looked up in the
 * caller's transaction so a transfer that commits first is respected.
 */
export async function currentLeadId(client: PoolClient, roomId: string): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    "SELECT id FROM participants WHERE room_id = $1 AND role = 'LEAD' AND status <> 'REMOVED' LIMIT 1",
    [roomId],
  );
  return rows[0]?.id ?? null;
}
