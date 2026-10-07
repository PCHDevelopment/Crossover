import { CrossoverError, newId } from "@crossover/protocol";
import { z } from "zod";
import { deliverInbox } from "../inbox/inbox.js";
import { checkLoopProtection } from "./loop.js";
import type { Dispatcher } from "../../dispatcher.js";

export const MAX_BODY_BYTES = 32 * 1024;
export const MAX_MENTIONS = 50;
export const MAX_REFS = 20;
export const DEFAULT_MESSAGE_PAGE = 50;
export const MAX_MESSAGE_PAGE = 100;

const body = z
  .string()
  .refine((v) => v.trim() !== "", "A message needs some text")
  .refine(
    (v) => Buffer.byteLength(v, "utf8") <= MAX_BODY_BYTES,
    `A message is at most ${MAX_BODY_BYTES} bytes`,
  );

const ref = z.strictObject({
  /** What it points at: `task`, `file`, `changeset`, `decision`, `memory`, `message`… */
  kind: z.string().regex(/^[a-z][a-z_]{0,31}$/),
  id: z.string().min(1).max(512),
});

export const messagesSendParams = z.strictObject({
  body,
  /** Explicit participant ids. The server never parses `@names` out of the text (§17.5). */
  mentions: z.array(z.string().min(1).max(100)).max(MAX_MENTIONS).default([]),
  refs: z.array(ref).max(MAX_REFS).default([]),
  reply_to: z.string().min(1).max(100).optional(),
});

export const messagesEditParams = z.strictObject({
  message_id: z.string().min(1).max(100),
  body,
});

export const messagesListParams = z
  .strictObject({
    /** Messages older than this message id. */
    before: z.string().min(1).max(100).optional(),
    /** Messages newer than this message id. */
    after: z.string().min(1).max(100).optional(),
    limit: z.number().int().min(1).max(MAX_MESSAGE_PAGE).default(DEFAULT_MESSAGE_PAGE),
  })
  .refine((p) => p.before === undefined || p.after === undefined, "Use before or after, not both");

interface MessageRow {
  id: string;
  room_id: string;
  author_id: string;
  body: string;
  mentions: string[];
  refs: { kind: string; id: string }[];
  reply_to: string | null;
  created_at: Date;
  edited_at: Date | null;
}

export interface MessageView extends Omit<MessageRow, "created_at" | "edited_at"> {
  created_at: string;
  edited_at: string | null;
}

const COLUMNS = "id, room_id, author_id, body, mentions, refs, reply_to, created_at, edited_at";

export function messageView(row: MessageRow): MessageView {
  return {
    ...row,
    created_at: row.created_at.toISOString(),
    edited_at: row.edited_at ? row.edited_at.toISOString() : null,
  };
}

/**
 * Register `messages.send`, `messages.edit` and `messages.list` (T401, §17.5).
 *
 * - **send** posts a message. Every mention must be a participant of the room (`VALIDATION`
 *   names the first that isn't); `reply_to` must be a message of the room. The owner of a task
 *   named in `refs` keeps their claim lease alive by posting about it (§8.4). Emits
 *   `message.sent`, which carries the message as sent, so the original text stays in the ledger.
 * - **edit** changes the text; only the author may (`FORBIDDEN`). Emits `message.edited` with
 *   the new text; the `message.sent` event still holds the original.
 * - **list** pages by message id: the latest `limit` messages by default, `before` an id for
 *   older ones, `after` an id for newer ones, always oldest first; `has_more` says whether
 *   there is more in the direction asked.
 */
export function registerMessageCommands(dispatcher: Dispatcher): void {
  dispatcher.registerCommand({
    method: "messages.send",
    mutating: true,
    params: messagesSendParams,
    execute: async (ctx, p) => {
      // §17.6: a room of agents answering each other with nothing changing is throttled.
      const loop = await checkLoopProtection(ctx.client, ctx.room_id, {
        id: ctx.principal.participant_id,
        kind: ctx.principal.kind,
      });
      const mentions = [...new Set(p.mentions)];
      if (mentions.length > 0) {
        const { rows } = await ctx.client.query<{ id: string }>(
          "SELECT id FROM participants WHERE room_id = $1 AND id = ANY($2::text[]) AND status <> 'REMOVED'",
          [ctx.room_id, mentions],
        );
        const known = new Set(rows.map((r) => r.id));
        const unknown = mentions.filter((m) => !known.has(m));
        if (unknown.length > 0) {
          throw new CrossoverError(
            "VALIDATION",
            `Mentioned ${unknown[0]} isn't a participant of this room`,
            {
              details: { unknown_mentions: unknown },
            },
          );
        }
      }
      if (p.reply_to !== undefined) {
        const { rowCount } = await ctx.client.query(
          "SELECT 1 FROM messages WHERE id = $1 AND room_id = $2",
          [p.reply_to, ctx.room_id],
        );
        if (!rowCount) {
          throw new CrossoverError("VALIDATION", `Message ${p.reply_to} to reply to not found`, {
            details: { reply_to: p.reply_to },
          });
        }
      }
      const { rows } = await ctx.client.query<MessageRow>(
        `INSERT INTO messages (id, room_id, author_id, body, mentions, refs, reply_to)
         VALUES ($1, $2, $3, $4, $5::text[], $6::jsonb, $7)
         RETURNING ${COLUMNS}`,
        [
          newId("msg"),
          ctx.room_id,
          ctx.principal.participant_id,
          p.body,
          mentions,
          JSON.stringify(p.refs),
          p.reply_to ?? null,
        ],
      );
      // Posting about a task you own counts as working on it (§8.4).
      const taskRefs = p.refs.filter((r) => r.kind === "task").map((r) => r.id);
      if (taskRefs.length > 0) {
        await ctx.client.query(
          `UPDATE tasks t SET lease_expires_at = clock_timestamp() + interval '15 minutes'
           FROM participants o
           WHERE t.room_id = $1 AND t.id = ANY($2::text[]) AND t.owner_id = $3
             AND t.status IN ('CLAIMED', 'IN_PROGRESS', 'BLOCKED') AND t.lease_expires_at IS NOT NULL
             AND o.id = t.owner_id AND o.room_id = t.room_id AND o.kind = 'AGENT'`,
          [ctx.room_id, taskRefs, ctx.principal.participant_id],
        );
      }
      const message = messageView(rows[0]!);
      // Each mentioned participant (not the author mentioning themselves) gets it in their inbox.
      for (const who of mentions) {
        if (who === ctx.principal.participant_id) continue;
        await deliverInbox(ctx.client, ctx.room_id, who, {
          kind: "MENTION",
          ref: { kind: "message", id: message.id },
          summary: p.body.slice(0, 200),
        });
      }
      return {
        response: message,
        events: [
          { type: "message.sent" as const, payload: { message } },
          ...(loop.detected ? [loop.detected.event] : []),
        ],
      };
    },
  });

  dispatcher.registerCommand({
    method: "messages.edit",
    mutating: true,
    params: messagesEditParams,
    execute: async (ctx, p) => {
      const { rows: found } = await ctx.client.query<MessageRow>(
        `SELECT ${COLUMNS} FROM messages WHERE id = $1 AND room_id = $2 FOR UPDATE`,
        [p.message_id, ctx.room_id],
      );
      const current = found[0];
      if (!current) throw new CrossoverError("NOT_FOUND", `Message ${p.message_id} not found`);
      if (current.author_id !== ctx.principal.participant_id) {
        throw new CrossoverError("FORBIDDEN", "Only the author can edit a message", {
          details: { reason: "not_author" },
        });
      }
      const { rows } = await ctx.client.query<MessageRow>(
        `UPDATE messages SET body = $3, edited_at = clock_timestamp()
         WHERE id = $1 AND room_id = $2 RETURNING ${COLUMNS}`,
        [p.message_id, ctx.room_id, p.body],
      );
      const message = messageView(rows[0]!);
      return {
        response: message,
        events: [
          {
            type: "message.edited" as const,
            payload: { message_id: message.id, body: message.body, edited_at: message.edited_at },
          },
        ],
      };
    },
  });

  dispatcher.registerCommand({
    method: "messages.list",
    action: "messages.read",
    mutating: false,
    view: "none",
    view_reason: "messages are visible to every member alike",
    params: messagesListParams,
    execute: async (ctx, p) => {
      let cursor: { created_at: string; id: string } | undefined;
      const anchorId = p.before ?? p.after;
      if (anchorId !== undefined) {
        // Microsecond-exact timestamp as text: a JS Date would lose it.
        const { rows } = await ctx.client.query<{ created_at: string }>(
          `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
           FROM messages WHERE id = $1 AND room_id = $2`,
          [anchorId, ctx.room_id],
        );
        if (!rows[0]) throw new CrossoverError("NOT_FOUND", `Message ${anchorId} not found`);
        cursor = { created_at: rows[0].created_at, id: anchorId };
      }
      const older = p.after === undefined; // latest-N and `before` walk backwards
      const values: unknown[] = [ctx.room_id, p.limit + 1];
      let where = "room_id = $1";
      if (cursor) {
        values.push(cursor.created_at, cursor.id);
        where += older
          ? " AND (created_at, id) < ($3::timestamptz, $4)"
          : " AND (created_at, id) > ($3::timestamptz, $4)";
      }
      const { rows } = await ctx.client.query<MessageRow>(
        `SELECT ${COLUMNS} FROM messages WHERE ${where}
         ORDER BY created_at ${older ? "DESC" : "ASC"}, id ${older ? "DESC" : "ASC"}
         LIMIT $2`,
        values,
      );
      const page = rows.slice(0, p.limit);
      if (older) page.reverse(); // oldest first
      return { response: { messages: page.map(messageView), has_more: rows.length > p.limit } };
    },
  });
}
