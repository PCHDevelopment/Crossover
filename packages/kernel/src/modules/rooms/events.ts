import { listEvents, MAX_LIST_LIMIT, DEFAULT_LIST_LIMIT } from "@crossover/ledger";
import { z } from "zod";
import type { Dispatcher } from "../../dispatcher.js";

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
      return {
        response: {
          events,
          next_after: events.length === p.limit && last ? last.sequence : null,
        },
      };
    },
  });
}
