import { z } from "zod";
import type { Dispatcher } from "../../dispatcher.js";

export const roomEventsSubscribeParams = z.strictObject({
  /** The last sequence the client has; the stream starts after it. */
  after: z.number().int().min(0).default(0),
});

/**
 * Register `room.events.subscribe` (T703): the authorization step of a subscription. It
 * answers with the room's current `last_sequence`; the gateway then streams events from
 * `after`. Going through the dispatcher means the same policy, room-state rules and denial
 * recording as any read.
 */
export function registerRoomEventsSubscribeCommand(dispatcher: Dispatcher): void {
  dispatcher.registerCommand({
    method: "room.events.subscribe",
    action: "room.read",
    mutating: false,
    params: roomEventsSubscribeParams,
    execute: async (ctx, p) => {
      const { rows } = await ctx.client.query<{ last_sequence: string }>(
        "SELECT last_sequence FROM rooms WHERE id = $1",
        [ctx.room_id],
      );
      return { response: { after: p.after, last_sequence: Number(rows[0]?.last_sequence ?? 0) } };
    },
  });
}
