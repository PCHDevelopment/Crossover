import { parseCapability } from "@crossover/policy";
import { CrossoverError } from "@crossover/protocol";
import { z } from "zod";
import type { Dispatcher } from "../../dispatcher.js";

const params = z.strictObject({ patterns: z.array(z.string().min(1).max(512)).max(100) });

/** Register the owner-only protected-path policy writer (T903, ARCHITECTURE §22.4). */
export function registerRoomProtectedPathsCommand(dispatcher: Dispatcher): void {
  dispatcher.registerCommand({
    method: "room.set_protected_paths",
    action: "protected_paths.set",
    mutating: true,
    params,
    execute: async (ctx, p) => {
      const patterns = [...new Set(p.patterns)].sort();
      for (const pattern of patterns) {
        try {
          parseCapability(`workspace.write:${pattern}`);
        } catch {
          throw new CrossoverError("VALIDATION", "Invalid protected path glob", {
            details: { reason: "invalid_protected_path_glob", pattern },
          });
        }
      }

      const { rows } = await ctx.client.query<{ settings: unknown }>(
        "SELECT settings FROM rooms WHERE id = $1 FOR UPDATE",
        [ctx.room_id],
      );
      const settingsValue = rows[0]?.settings;
      if (!rows[0]) throw new CrossoverError("NOT_FOUND", "Room not found");
      const settings =
        typeof settingsValue === "object" && settingsValue !== null && !Array.isArray(settingsValue)
          ? (settingsValue as Record<string, unknown>)
          : {};
      const current = settings.protected_paths;
      if (
        Array.isArray(current) &&
        current.length === patterns.length &&
        current.every((pattern, index) => pattern === patterns[index])
      ) {
        return { response: { patterns, changed: false } };
      }

      await ctx.client.query(
        `UPDATE rooms
            SET settings = jsonb_set(
              CASE WHEN jsonb_typeof(settings) = 'object' THEN settings ELSE '{}'::jsonb END,
              '{protected_paths}', $2::jsonb, true
            )
          WHERE id = $1`,
        [ctx.room_id, JSON.stringify(patterns)],
      );
      return {
        response: { patterns, changed: true },
        events: [{ type: "room.protected_paths_changed", payload: { patterns } }],
      };
    },
  });
}
