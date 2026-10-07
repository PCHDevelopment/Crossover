import { isIP } from "node:net";
import { isPrivateAddress } from "@crossover/security";
import { isAuthorityPower, parseCapability, tierOf } from "@crossover/policy";
import { CrossoverError, newId } from "@crossover/protocol";
import { z } from "zod";
import type { Dispatcher, EmittedEvent } from "../../dispatcher.js";
import { hashToken, issueTokens, type TokenPair } from "../auth/tokens.js";
import { INVITE_TOKEN_PREFIX } from "./invite.js";

export const AGENT_CLIENTS = ["mcp", "cli", "sdk-ts", "sdk-python", "rest", "a2a"] as const;

const text = (max: number) => z.string().trim().min(1).max(max);

/**
 * The rules `postWebhook` enforces when it sends (https, no userinfo, the default port, a public
 * host), applied when the URL is set so a bad one is refused then instead of failing silently
 * for good. (The name is resolved only at send time.)
 */
const httpsUrl = z
  .url()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      const host = url.hostname.replace(/^\[|\]$/g, "");
      return (
        url.protocol === "https:" &&
        url.username === "" &&
        url.password === "" &&
        (url.port === "" || url.port === "443") &&
        host !== "localhost" &&
        !host.endsWith(".localhost") &&
        (isIP(host) === 0 || !isPrivateAddress(host))
      );
    } catch {
      return false;
    }
  }, "wake_webhook_url must be an https URL on the default port, without credentials, at a public host");

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
 * The invite's `capability_grants` become `GRANT` rows (made by the inviter) with a
 * `capability.granted` event each (T210).
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
        capability_grants: string[];
        created_by: string;
      }>(
        `SELECT id, role, capability_grants, created_by FROM invites
         WHERE token_hash = $1 AND room_id = $2
           AND used_at IS NULL AND expires_at > clock_timestamp()
         FOR UPDATE`,
        [hashToken(params.token), ctx.room_id],
      );
      const invite = rows[0];
      if (!invite) throw invalid();

      // Joining adds a participant and an event, so it is a mutation: refused in a frozen or
      // archived room (§5), with the invite left unspent.
      const room = await ctx.client.query<{ status: string }>(
        "SELECT status FROM rooms WHERE id = $1",
        [ctx.room_id],
      );
      const roomStatus = room.rows[0]?.status;
      if (roomStatus !== "ACTIVE") {
        throw new CrossoverError(
          roomStatus === "DELETED" ? "UNAUTHENTICATED" : "ROOM_PAUSED",
          roomStatus === "DELETED"
            ? "Invalid or expired token"
            : `Room is ${roomStatus?.toLowerCase()}`,
          roomStatus === "DELETED" ? {} : { details: { room_status: roomStatus } },
        );
      }

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

      // The invite's capability grants (T204) become real grants, made by the inviter.
      const grantEvents: EmittedEvent[] = [];
      for (const capability of invite.capability_grants) {
        // Checked when the invite was created; this only guards against a hand-edited row.
        if (isAuthorityPower(parseCapability(capability).base)) continue;
        const grantId = newId("grant");
        await ctx.client.query(
          `INSERT INTO capability_grants
             (id, room_id, participant_id, effect, capability, created_by, created_at)
           VALUES ($1, $2, $3, 'GRANT', $4, $5, clock_timestamp())`,
          [grantId, ctx.room_id, participantId, capability, invite.created_by],
        );
        grantEvents.push({
          type: "capability.granted",
          actor_id: participantId,
          payload: {
            grant_id: grantId,
            participant_id: participantId,
            capability,
            tier: tierOf(capability),
            requires_approval: false,
            expires_at: null,
            granted_by: invite.created_by,
            invite_id: invite.id,
          },
        });
      }

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
          ...grantEvents,
        ],
        oneTime: tokens satisfies RoomJoinSecret,
      };
    },
  });
}
