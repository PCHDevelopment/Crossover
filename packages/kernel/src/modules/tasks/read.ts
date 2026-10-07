import { CrossoverError } from "@crossover/protocol";
import { z } from "zod";
import type { Dispatcher } from "../../dispatcher.js";
import { loadTask, TASK_COLUMNS, TASK_STATUSES, taskView, type TaskRow } from "./task.js";

export const MAX_PAGE = 100;
export const DEFAULT_PAGE = 50;

export const tasksListParams = z.strictObject({
  /** Only tasks in one of these states. */
  status: z.array(z.enum(TASK_STATUSES)).min(1).max(TASK_STATUSES.length).optional(),
  owner_id: z.string().min(1).max(100).optional(),
  /** Only tasks owned by the caller. Not together with `owner_id`. */
  mine: z.boolean().optional(),
  limit: z.number().int().min(1).max(MAX_PAGE).default(DEFAULT_PAGE),
  /** The `next_cursor` of the previous page. */
  cursor: z.string().min(1).max(200).optional(),
});

export const tasksGetParams = z.strictObject({ task_id: z.string().min(1).max(100) });

/** `created_at` at full microsecond precision, which a JS `Date` can't carry. */
const CREATED_AT_TEXT = `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const CURSOR = /^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z)\|(.+)$/;

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  const match = CURSOR.exec(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!match) throw new CrossoverError("VALIDATION", "Invalid cursor", { details: { cursor } });
  return { createdAt: match[1]!, id: match[2]! };
}

/**
 * Register `tasks.list` and `tasks.get` (T303). The list is ordered by `(created_at, id)` and
 * paged with an opaque cursor over that same pair, so every task appears exactly once across
 * pages even when several share a timestamp or new tasks arrive meanwhile (they sort after
 * the cursor). `get` also returns the task's reviews (§8.1).
 */
export function registerTaskReadCommands(dispatcher: Dispatcher): void {
  dispatcher.registerCommand({
    method: "tasks.list",
    action: "tasks.read",
    mutating: false,
    view: "none",
    view_reason: "tasks are visible to every member alike: no events, paths or denials in them",
    params: tasksListParams,
    execute: async (ctx, p) => {
      if (p.mine && p.owner_id !== undefined && p.owner_id !== ctx.principal.participant_id) {
        throw new CrossoverError("VALIDATION", "Use either mine or owner_id, not both");
      }
      const where = ["room_id = $1"];
      const values: unknown[] = [ctx.room_id];
      const add = (sql: (n: number) => string, value: unknown) => {
        values.push(value);
        where.push(sql(values.length));
      };
      if (p.status) add((n) => `status = ANY($${n}::text[])`, p.status);
      const owner = p.mine ? ctx.principal.participant_id : p.owner_id;
      if (owner !== undefined) add((n) => `owner_id = $${n}`, owner);
      if (p.cursor !== undefined) {
        const c = decodeCursor(p.cursor);
        values.push(c.createdAt, c.id);
        where.push(`(created_at, id) > ($${values.length - 1}::timestamptz, $${values.length})`);
      }
      values.push(p.limit + 1); // one extra row says whether there is a next page
      const { rows } = await ctx.client.query<TaskRow & { created_at_text: string }>(
        `SELECT ${TASK_COLUMNS}, ${CREATED_AT_TEXT} AS created_at_text
         FROM tasks WHERE ${where.join(" AND ")}
         ORDER BY created_at, id LIMIT $${values.length}`,
        values,
      );
      const page = rows.slice(0, p.limit);
      const last = page[page.length - 1];
      return {
        response: {
          tasks: page.map(taskView),
          next_cursor:
            rows.length > p.limit && last ? encodeCursor(last.created_at_text, last.id) : null,
        },
      };
    },
  });

  dispatcher.registerCommand({
    method: "tasks.get",
    action: "tasks.read",
    mutating: false,
    view: "none",
    view_reason: "tasks are visible to every member alike: no events, paths or denials in them",
    params: tasksGetParams,
    execute: async (ctx, p) => {
      const task = await loadTask(ctx.client, ctx.room_id, p.task_id);
      const { rows } = await ctx.client.query<{
        id: string;
        reviewer_id: string;
        verdict: string;
        comments: string;
        revision: string;
        created_at: Date;
      }>(
        `SELECT id, reviewer_id, verdict, comments, revision, created_at
         FROM task_reviews WHERE task_id = $1 AND room_id = $2 ORDER BY created_at, id`,
        [task.id, ctx.room_id],
      );
      return {
        response: {
          ...taskView(task),
          reviews: rows.map((r) => ({
            id: r.id,
            reviewer_id: r.reviewer_id,
            verdict: r.verdict,
            comments: r.comments,
            revision: Number(r.revision),
            created_at: r.created_at.toISOString(),
          })),
        },
      };
    },
  });
}
