import { CrossoverError } from "@crossover/protocol";
import { z } from "zod";
import type { Dispatcher } from "../../dispatcher.js";
import { restartAgentLeases } from "../tasks/task.js";

export type RoomStatus = "ACTIVE" | "PAUSED" | "ARCHIVED" | "DELETED";
export type LifecycleCommand = "room.freeze" | "room.resume" | "room.archive";

/**
 * The room state machine (ARCHITECTURE §5). `DELETED` is reached by the grace-period job,
 * never by these commands, and `ARCHIVED` has no way back.
 */
export const ROOM_TRANSITIONS: Readonly<
  Record<LifecycleCommand, { from: readonly RoomStatus[]; to: RoomStatus }>
> = {
  "room.freeze": { from: ["ACTIVE"], to: "PAUSED" },
  "room.resume": { from: ["PAUSED"], to: "ACTIVE" },
  "room.archive": { from: ["ACTIVE", "PAUSED"], to: "ARCHIVED" },
};

const EVENT_TYPES = {
  "room.freeze": "room.paused",
  "room.resume": "room.resumed",
  "room.archive": "room.archived",
} as const;

export interface RoomLifecycleOptions {
  /**
   * Runs once a transition has committed, on the room's actor: stop agent sandboxes on a
   * freeze, destroy them on an archive (§5). A failure is reported, never undoes the change.
   */
  afterChange?: (info: {
    room_id: string;
    from: RoomStatus;
    to: RoomStatus;
    changed_by: string;
  }) => void | Promise<void>;
}

/**
 * Register `room.freeze`, `room.resume` and `room.archive` (T214, §5, §22.1). The dispatcher
 * checks the capability (owner only); the policy enforces what each state allows
 * (`authorize()` answers `ROOM_PAUSED` for a mutation in a frozen room by anyone but the owner,
 * and for any mutation in an archived one). Here: the transitions in {@link ROOM_TRANSITIONS},
 * with anything else a `VALIDATION` error that names the current state. `archive` also stamps
 * `archived_at`.
 */
export function registerRoomLifecycleCommands(
  dispatcher: Dispatcher,
  options: RoomLifecycleOptions = {},
): void {
  for (const method of Object.keys(ROOM_TRANSITIONS) as LifecycleCommand[]) {
    const { from, to } = ROOM_TRANSITIONS[method];
    dispatcher.registerCommand({
      method,
      mutating: true,
      params: z.strictObject({}),
      execute: async (ctx) => {
        const { rows } = await ctx.client.query<{ status: RoomStatus }>(
          "SELECT status FROM rooms WHERE id = $1 FOR UPDATE",
          [ctx.room_id],
        );
        const current = rows[0]?.status;
        if (current === undefined) throw new CrossoverError("NOT_FOUND", "Room not found");
        if (!from.includes(current)) {
          throw new CrossoverError(
            "VALIDATION",
            `Can't ${method.slice(5)} a room that is ${current}`,
            { details: { room_status: current, allowed_from: from } },
          );
        }
        await ctx.client.query(
          `UPDATE rooms SET status = $2,
                            archived_at = CASE WHEN $2 = 'ARCHIVED' THEN clock_timestamp() ELSE archived_at END
           WHERE id = $1`,
          [ctx.room_id, to],
        );
        // Claims were frozen with the room: on resume their lease clocks start over (§22.1).
        if (to === "ACTIVE") await restartAgentLeases(ctx.client, ctx.room_id);
        const changedBy = ctx.principal.participant_id;
        if (options.afterChange) {
          const after = options.afterChange;
          ctx.afterCommit(() =>
            after({ room_id: ctx.room_id, from: current, to, changed_by: changedBy }),
          );
        }
        return {
          response: { room_id: ctx.room_id, status: to, previous_status: current },
          events: [
            {
              type: EVENT_TYPES[method],
              payload: { previous_status: current, status: to, changed_by: changedBy },
            },
          ],
        };
      },
    });
  }
}
