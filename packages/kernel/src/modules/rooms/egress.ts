import { CrossoverError } from "@crossover/protocol";
import { normalizeRoomEgressAllowlist } from "@crossover/security";
import { z } from "zod";
import type { Dispatcher } from "../../dispatcher.js";

const params = z.strictObject({ hosts: z.array(z.string().max(255)).max(100) });

/** Register the owner/admin room egress setting writer (T1205a, ARCHITECTURE §6.2). */
export function registerRoomEgressAllowlistCommand(dispatcher: Dispatcher): void {
  dispatcher.registerCommand({
    method: "room.set_egress_allowlist",
    action: "egress.set",
    mutating: true,
    params,
    execute: async (ctx, p) => {
      let hosts: string[];
      try {
        hosts = normalizeRoomEgressAllowlist(p.hosts);
      } catch (error) {
        throw new CrossoverError(
          "VALIDATION",
          error instanceof Error ? error.message : "Invalid egress allowlist",
        );
      }

      const { rows } = await ctx.client.query<{ settings: unknown }>(
        "SELECT settings FROM rooms WHERE id = $1 FOR UPDATE",
        [ctx.room_id],
      );
      const row = rows[0];
      if (!row) throw new CrossoverError("NOT_FOUND", "Room not found");

      const settings = isSettingsRecord(row.settings) ? row.settings : {};
      const current = settings.egress_allowlist;
      const unchanged =
        ((current === undefined || current === null) && hosts.length === 0) ||
        (Array.isArray(current) &&
          current.length === hosts.length &&
          current.every((host, index) => host === hosts[index]));
      if (unchanged) return { response: { hosts, changed: false } };

      await ctx.client.query(
        `UPDATE rooms
            SET settings = jsonb_set(
              CASE WHEN jsonb_typeof(settings) = 'object' THEN settings ELSE '{}'::jsonb END,
              '{egress_allowlist}', $2::jsonb, true
            )
          WHERE id = $1`,
        [ctx.room_id, JSON.stringify(hosts)],
      );
      return {
        response: { hosts, changed: true },
        events: [{ type: "room.egress_allowlist_changed", payload: { hosts } }],
      };
    },
  });
}

function isSettingsRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
