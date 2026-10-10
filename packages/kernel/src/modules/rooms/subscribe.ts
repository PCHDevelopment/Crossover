import { z } from "zod";
import { CrossoverError } from "@crossover/protocol";
import type { Dispatcher } from "../../dispatcher.js";
import { filterParams, resolveFilter } from "./event-filter.js";

export const roomEventsSubscribeParams = z.strictObject({
  /** The last sequence the client has; the stream starts after it. */
  after: z.number().int().min(0).default(0),
  ...filterParams,
});

/**
 * Register `room.events.subscribe` (T703): the authorization step of a subscription. It
 * answers with the room's current `last_sequence`; the gateway then streams events from
 * `after`. Going through the dispatcher means the same policy, room-state rules and denial
 * recording as any read.
 *
 * **Filtering (§17.1, T704):** `profile` is `relevant` (the default for agents: what concerns
 * them), `all` (the default for humans) or `custom` (`types` patterns such as `task.*`, and
 * `scopes` `{ tasks: "mine" | "all", mentions }`). The answer carries the resolved `filter`. The
 * gateway applies it to the stream; `sequence` numbers of what is delivered stay the room's, so a
 * filtered stream has gaps by design.
 */
export function registerRoomEventsSubscribeCommand(dispatcher: Dispatcher): void {
  dispatcher.registerCommand({
    method: "room.events.subscribe",
    action: "room.read",
    mutating: false,
    view: "participant",
    params: roomEventsSubscribeParams,
    execute: async (ctx, p) => {
      const { rows } = await ctx.client.query<{ last_sequence: string }>(
        "SELECT last_sequence FROM rooms WHERE id = $1",
        [ctx.room_id],
      );
      let filter;
      try {
        filter = resolveFilter(ctx.principal.kind, p);
      } catch (error) {
        throw new CrossoverError("VALIDATION", (error as Error).message);
      }
      return {
        response: { after: p.after, last_sequence: Number(rows[0]?.last_sequence ?? 0), filter },
      };
    },
  });
}
