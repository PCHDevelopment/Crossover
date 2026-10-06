import { CrossoverError, newId } from "@crossover/protocol";
import { z } from "zod";
import type { Dispatcher } from "../../dispatcher.js";
import { hashToken, issueTokens, type TokenPair } from "../auth/tokens.js";
import { INVITE_TOKEN_PREFIX } from "./invite.js";

export const AGENT_CLIENTS = ["mcp", "cli", "sdk-ts", "sdk-python", "rest", "a2a"] as const;

const text = (max: number) => z.string().trim().min(1).max(max);

const httpsUrl = z
  .url()
  .max(2048)
  .refine((value) => {
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  }, "wake_webhook_url must be an https URL");

/** The §15.2 agent manifest. Strict: unknown fields are rejected, not stored. */
export const agentManifestSchema = z.strictObject({
  name: text(80),
  operator: z.strictObject({ name: text(200), contact: text(320) }),
  /** Self-declared; displayed as such and never used for authorization. */
  vendor: text(100),
  model: text(100),
  client: z.enum(AGENT_CLIENTS),
  client_version: text(50),
  wake_webhook_url: httpsUrl.optional(),
  description: text(1000),
});
export type AgentManifest = z.infer<typeof agentManifestSchema>;

export const roomJoinParams = z.strictObject({
  token: z
    .string()
    .max(200)
    .refine((t) => t.startsWith(INVITE_TOKEN_PREFIX), "not an invite token"),
  manifest: agentManifestSchema,
});

export interface RoomJoinResponse {
  participant_id: string;
  room_id: string;
  role: "DEVELOPER" | "REVIEWER" | "OBSERVER";
  display_name: string;
}

/** What the joining agent receives exactly once: its room-scoped credentials. */
export type RoomJoinSecret = TokenPair;

const invalid = () => new CrossoverError("UNAUTHENTICATED", "Invalid or expired token");

/**
 * Register `room.join` (T205) as an anonymous command: the invite token is the credential.
 *
 * Inside one transaction on the room's actor: lock the invite row, require it unused and
 * unexpired, create the `AGENT` participant (role from the invite, authority `MEMBER`,
 * `ACTIVE`), spend the invite, mint tokens (T206) and append `participant.joined`. The
 * single-use token is the dedupe, so a retry after success is `UNAUTHENTICATED`. The tokens
 * travel through `oneTime`; the event carries no manifest contents and no secrets.
 *
 * The invite's `capability_grants` stay on the used invite row until the grants table (T210)
 * exists to receive them.
 */
export function registerJoinCommand(dispatcher: Dispatcher): void {
  dispatcher.registerAnonymousCommand({
    method: "room.join",
    params: roomJoinParams,
    resolveRoom: async (pool, params) => {
      const { rows } = await pool.query<{ room_id: string }>(
        `SELECT room_id FROM invites
         WHERE token_hash = $1 AND used_at IS NULL AND expires_at > clock_timestamp()`,
        [hashToken(params.token)],
      );
      return rows[0]?.room_id;
    },
    execute: async (ctx, params) => {
      const { rows } = await ctx.client.query<{
        id: string;
        role: RoomJoinResponse["role"];
      }>(
        `SELECT id, role FROM invites
         WHERE token_hash = $1 AND room_id = $2
           AND used_at IS NULL AND expires_at > clock_timestamp()
         FOR UPDATE`,
        [hashToken(params.token), ctx.room_id],
      );
      const invite = rows[0];
      if (!invite) throw invalid();

      const { manifest } = params;
      const participantId = newId("part");
      await ctx.client.query(
        `INSERT INTO participants
           (id, room_id, kind, display_name, authority, role, status, agent_manifest, joined_at)
         VALUES ($1, $2, 'AGENT', $3, 'MEMBER', $4, 'ACTIVE', $5::jsonb, clock_timestamp())`,
        [
          participantId,
          ctx.room_id,
          manifest.name,
          invite.role,
          JSON.stringify({ ...manifest, self_declared: ["vendor", "model"] }),
        ],
      );
      await ctx.client.query(
        "UPDATE invites SET used_at = clock_timestamp(), used_by = $2 WHERE id = $1",
        [invite.id, participantId],
      );
      const tokens = await issueTokens(ctx.client, participantId);

      const response: RoomJoinResponse = {
        participant_id: participantId,
        room_id: ctx.room_id,
        role: invite.role,
        display_name: manifest.name,
      };
      return {
        response,
        events: [
          {
            type: "participant.joined" as const,
            actor_id: participantId,
            // Identity and placement only: no manifest contents, no user_id, no tokens.
            payload: {
              participant_id: participantId,
              kind: "AGENT",
              authority: "MEMBER",
              role: invite.role,
              display_name: manifest.name,
              invite_id: invite.id,
            },
          },
        ],
        oneTime: tokens satisfies RoomJoinSecret,
      };
    },
  });
}
