import { randomBytes } from "node:crypto";
import { isAuthorityPower, parseCapability, tierOf } from "@crossover/policy";
import { CrossoverError, newId } from "@crossover/protocol";
import { z } from "zod";
import type { Dispatcher } from "../../dispatcher.js";
import { hashToken } from "../auth/tokens.js";

export const INVITE_TOKEN_PREFIX = "inv_";
/** Invites live at most 24 hours (also a CHECK constraint on the table). */
export const INVITE_MAX_TTL_SECONDS = 24 * 60 * 60;
export const INVITE_MIN_TTL_SECONDS = 60;
export const INVITE_MAX_GRANTS = 50;

/** `inv_` + 32 random bytes as base64url (43 characters). */
export function newInviteToken(): string {
  return INVITE_TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

const grantSchema = z.string().superRefine((value, ctx) => {
  let base: string;
  try {
    base = parseCapability(value).base;
  } catch (err) {
    ctx.addIssue({ code: "custom", message: (err as Error).message });
    return;
  }
  // Tier 3 (production, irreversible) is owner-only and expires within 24 h (§21.2); that is
  // the grant command's job (T210), not something an invite can carry.
  if (isAuthorityPower(base)) {
    ctx.addIssue({
      code: "custom",
      message: `${base} is an authority power and can't be granted by an invite`,
    });
  }
  if (tierOf(base) === 3) {
    ctx.addIssue({
      code: "custom",
      message: `${value} is a Tier 3 capability and can't be granted by an invite`,
    });
  }
});

export const roomInviteParams = z.object({
  /** Not LEAD: there is exactly one lead, appointed with `room.set_lead` (T213). */
  role: z.enum(["DEVELOPER", "REVIEWER", "OBSERVER"]),
  capability_grants: z.array(grantSchema).max(INVITE_MAX_GRANTS).default([]),
  /** Seconds until the invite expires. Default and maximum: 24 hours. */
  expires_in: z
    .number()
    .int()
    .min(INVITE_MIN_TTL_SECONDS)
    .max(INVITE_MAX_TTL_SECONDS)
    .default(INVITE_MAX_TTL_SECONDS),
});

export interface RoomInviteResponse {
  invite_id: string;
  role: "DEVELOPER" | "REVIEWER" | "OBSERVER";
  capability_grants: string[];
  expires_at: string;
}

/** What the inviter receives exactly once, outside the stored response. */
export interface RoomInviteSecret {
  token: string;
}

/**
 * Register `room.invite` (T204). Authorization is the dispatcher's: the command declares
 * the `room.invite` capability, which the policy gives to owners and admins only.
 *
 * The token is returned through `oneTime`, so it is never stored with the idempotency key,
 * in the ledger, in the published events or in logs. A retried request therefore gets the
 * invite's details but not its token; the inviter creates another invite.
 */
export function registerInviteCommands(dispatcher: Dispatcher): void {
  dispatcher.registerCommand({
    method: "room.invite",
    action: "room.invite",
    mutating: true,
    params: roomInviteParams,
    execute: async (ctx, params) => {
      const inviteId = newId("inv");
      const token = newInviteToken();
      // Duplicate grants add nothing; keep the order the caller gave.
      const grants = [...new Set(params.capability_grants)];

      const { rows } = await ctx.client.query<{ expires_at: Date }>(
        `WITH t AS (SELECT clock_timestamp() AS now)
         INSERT INTO invites (id, room_id, token_hash, role, capability_grants, created_by, created_at, expires_at)
         SELECT $1, $2, $3, $4, $5::jsonb, $6, t.now, t.now + make_interval(secs => $7) FROM t
         RETURNING expires_at`,
        [
          inviteId,
          ctx.room_id,
          hashToken(token),
          params.role,
          JSON.stringify(grants),
          ctx.principal.participant_id,
          params.expires_in,
        ],
      );
      const expiresAt = rows[0]?.expires_at;
      if (!expiresAt) throw new CrossoverError("VALIDATION", "invite was not created");

      const response: RoomInviteResponse = {
        invite_id: inviteId,
        role: params.role,
        capability_grants: grants,
        expires_at: expiresAt.toISOString(),
      };
      return {
        response,
        events: [
          {
            type: "participant.invited" as const,
            // No token, ever: only what a room member may see about the invite.
            payload: { ...response },
          },
        ],
        oneTime: { token } satisfies RoomInviteSecret,
      };
    },
  });
}
