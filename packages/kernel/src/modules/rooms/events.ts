import { listEvents, MAX_LIST_LIMIT, DEFAULT_LIST_LIMIT } from "@crossover/ledger";
import { z } from "zod";
import type { Dispatcher } from "../../dispatcher.js";
import { redactEventFor } from "./redact.js";

export const roomEventsListParams = z.strictObject({
  /** Only events after this sequence (the last one you have). Default: from the start. */
  after: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(MAX_LIST_LIMIT).default(DEFAULT_LIST_LIMIT),
  /** Exact event types or `prefix.*` wildcards (`task.*`). */
  types: z.array(z.string().min(1).max(100)).min(1).max(50).optional(),
});

/**
 * Register `room.events.list` (T702, §19.2): a room's events in order, after a sequence, so a
 * client can read history or backfill a gap. `next_after` is the sequence to pass next time,

 * set when the page is full (there may be more), `null` when it isn't (you are caught up).
 * `capability.denied` events are redacted for most readers (see {@link redactEventFor}).
 */
export function registerRoomEventsCommand(dispatcher: Dispatcher): void {
  dispatcher.registerCommand({
    method: "room.events.list",
    action: "room.read",
    mutating: false,
    params: roomEventsListParams,
    execute: async (ctx, p) => {
      const events = await listEvents(ctx.client, ctx.room_id, {
        after: p.after,
        limit: p.limit,
        ...(p.types ? { types: p.types } : {}),
      });
      const last = events[events.length - 1];
      // Who is asking, as the database has them now (the principal is a snapshot).
      const { rows } = await ctx.client.query<{ role: string; authority: string }>(
        "SELECT role, authority FROM participants WHERE id = $1 AND room_id = $2",
        [ctx.principal.participant_id, ctx.room_id],
      );
      const viewer = {
        participant_id: ctx.principal.participant_id,
        role: rows[0]?.role ?? ctx.principal.role,
        authority: rows[0]?.authority ?? ctx.principal.authority,
      };
      return {
        response: {
          events: events.map((e) => redactEventFor(viewer, e)),
          next_after: events.length === p.limit && last ? last.sequence : null,
        },
      };
    },
  });
}
