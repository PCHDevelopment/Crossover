import { CrossoverError } from "@crossover/protocol";
import { z } from "zod";
import type { Dispatcher } from "../../dispatcher.js";

const HEALTH_COMMAND_MAX_LENGTH = 4096;
const HEALTH_IMAGE_MAX_LENGTH = 255;

export const roomSetHealthParams = z.strictObject({
  health_command: z.string().trim().min(1).max(HEALTH_COMMAND_MAX_LENGTH).nullable(),
  health_image: z.string().min(1).max(HEALTH_IMAGE_MAX_LENGTH).nullable().optional(),
});

export interface RoomHealthSettingsOptions {
  /** Images the operator permits rooms to use for health runs. */
  allowedImages: readonly string[];
  /** The default used when a room has no explicit health image. */
  defaultImage: string;
}

/** Register the lead/owner health settings writer (ARCHITECTURE §24.1). */
export function registerRoomHealthSettingsCommand(
  dispatcher: Dispatcher,
  options: RoomHealthSettingsOptions,
): void {
  const allowedImages = new Set(options.allowedImages);
  if (!allowedImages.has(options.defaultImage)) {
    throw new Error("The default health image must be in the operator allowlist");
  }

  dispatcher.registerCommand({
    method: "room.set_health",
    action: "health.set",
    mutating: true,
    params: roomSetHealthParams,
    execute: async (ctx, params) => {
      const { rows } = await ctx.client.query<{ settings: unknown }>(
        "SELECT settings FROM rooms WHERE id = $1 FOR UPDATE",
        [ctx.room_id],
      );
      const row = rows[0];
      if (!row) throw new CrossoverError("NOT_FOUND", "Room not found");

      const settings = isSettingsRecord(row.settings) ? row.settings : {};
      const currentCommand =
        typeof settings.health_command === "string" && settings.health_command.trim()
          ? settings.health_command
          : null;
      const currentImage =
        typeof settings.health_image === "string" && settings.health_image.length > 0
          ? settings.health_image
          : options.defaultImage;
      const command = params.health_command;
      const image =
        params.health_image === undefined
          ? currentImage
          : (params.health_image ?? options.defaultImage);

      if (!allowedImages.has(image)) {
        throw new CrossoverError("VALIDATION", "Health image is not in the operator allowlist", {
          details: { reason: "health_image_not_allowed", health_image: image },
        });
      }

      if (currentCommand === command && currentImage === image) {
        return { response: { health_command: command, health_image: image, changed: false } };
      }

      await ctx.client.query(
        `UPDATE rooms
            SET settings = jsonb_set(
              jsonb_set(
                CASE WHEN jsonb_typeof(settings) = 'object' THEN settings ELSE '{}'::jsonb END,
                '{health_command}', $2::jsonb, true
              ),
              '{health_image}', $3::jsonb, true
            )
          WHERE id = $1`,
        [ctx.room_id, JSON.stringify(command), JSON.stringify(image)],
      );

      return {
        response: { health_command: command, health_image: image, changed: true },
        events: [
          {
            type: "room.health_settings_changed",
            payload: { health_command: command, health_image: image },
          },
        ],
      };
    },
  });
}

function isSettingsRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
