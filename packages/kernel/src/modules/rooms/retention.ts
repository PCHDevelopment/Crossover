import { CrossoverError } from "@crossover/protocol";
import { z } from "zod";
import type { Dispatcher } from "../../dispatcher.js";
import { restartAgentLeases } from "../tasks/task.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_NOTICE_MS = 7 * DAY_MS;

export const setRoomRetentionParams = z.strictObject({
  retention_days: z.number().int().min(30).max(365),
});

export const unarchiveRoomParams = z.strictObject({});

/** Register owner-only room retention changes and unarchive. */
export function registerRoomRetentionCommands(dispatcher: Dispatcher): void {
  dispatcher.registerCommand({
    method: "rooms.set_retention",
    mutating: true,
    params: setRoomRetentionParams,
    execute: async (ctx, params) => {
      const { rows } = await ctx.client.query<{
        status: string;
        archived_at: Date | null;
        retention_days: number;
        purge_started_at: Date | null;
      }>(
        `SELECT status, archived_at, retention_days, purge_started_at
           FROM rooms WHERE id = $1 FOR UPDATE`,
        [ctx.room_id],
      );
      const room = rows[0];
      if (!room || room.status === "DELETED")
        throw new CrossoverError("NOT_FOUND", "Room not found");

      if (room.status === "ARCHIVED") {
        if (room.purge_started_at) {
          throw new CrossoverError("CONFLICT_VERSION", "room deletion is in progress");
        }
        if (!room.archived_at)
          throw new CrossoverError("UNAVAILABLE", "Archived room has no archive time");
        const deadline = room.archived_at.getTime() + params.retention_days * DAY_MS;
        if (deadline < Date.now() + RETENTION_NOTICE_MS) {
          throw new CrossoverError(
            "VALIDATION",
            "retention would end within the 7-day notice period",
          );
        }
      }

      const changed = room.retention_days !== params.retention_days;
      if (changed) {
        await ctx.client.query(
          `UPDATE rooms SET retention_days = $2, retention_notice_sent_at = NULL WHERE id = $1`,
          [ctx.room_id, params.retention_days],
        );
      }
      return {
        response: {
          room_id: ctx.room_id,
          retention_days: params.retention_days,
          changed,
        },
        ...(changed
          ? {
              events: [
                {
                  type: "room.retention_changed" as const,
                  payload: {
                    retention_days: params.retention_days,
                    changed_by: ctx.principal.participant_id,
                  },
                },
              ],
            }
          : {}),
      };
    },
  });

  dispatcher.registerCommand({
    method: "rooms.unarchive",
    mutating: true,
    params: unarchiveRoomParams,
    execute: async (ctx) => {
      const { rows } = await ctx.client.query<{
        status: string;
        archived_at: Date | null;
        retention_days: number;
        purge_started_at: Date | null;
      }>(
        `SELECT status, archived_at, retention_days, purge_started_at
           FROM rooms WHERE id = $1 FOR UPDATE`,
        [ctx.room_id],
      );
      const room = rows[0];
      if (!room || room.status === "DELETED")
        throw new CrossoverError("NOT_FOUND", "Room not found");
      if (room.status !== "ARCHIVED") {
        throw new CrossoverError("VALIDATION", `Can't unarchive a room that is ${room.status}`, {
          details: { room_status: room.status, allowed_from: ["ARCHIVED"] },
        });
      }
      if (room.purge_started_at) {
        throw new CrossoverError("CONFLICT_VERSION", "room deletion is in progress");
      }
      if (
        !room.archived_at ||
        room.archived_at.getTime() + room.retention_days * DAY_MS <= Date.now()
      ) {
        throw new CrossoverError("VALIDATION", "Room retention has ended");
      }
      await ctx.client.query(
        `UPDATE rooms SET status = 'ACTIVE', archived_at = NULL,
                          retention_notice_sent_at = NULL, purge_started_at = NULL, purge_phase = NULL
         WHERE id = $1`,
        [ctx.room_id],
      );
      await restartAgentLeases(ctx.client, ctx.room_id);
      return {
        response: {
          room_id: ctx.room_id,
          status: "ACTIVE",
          previous_status: "ARCHIVED",
        },
        events: [
          {
            type: "room.unarchived" as const,
            payload: { changed_by: ctx.principal.participant_id },
          },
        ],
      };
    },
  });
}
