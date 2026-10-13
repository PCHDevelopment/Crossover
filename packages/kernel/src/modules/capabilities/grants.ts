import type { Pool, PoolClient } from "@crossover/db";
import {
  effectiveCapabilities,
  capabilityMatches,
  isAuthorityPower,
  isCapability,
  loadLiveGrants,
  parseCapability,
  ROLE_BUNDLES,
  tierOf,
  type Authority,
  type Role,
} from "@crossover/policy";
import { CrossoverError, newId } from "@crossover/protocol";
import { z } from "zod";
import type { Dispatcher } from "../../dispatcher.js";

/** A Tier 3 grant (§21.2) lives at most this long. */
export const TIER3_MAX_TTL_MS = 24 * 60 * 60 * 1000;

const capabilityString = z.string().superRefine((value, ctx) => {
  try {
    parseCapability(value);
  } catch (err) {
    ctx.addIssue({ code: "custom", message: (err as Error).message });
  }
});

const participantId = z.string().min(1).max(100);

/** Whether a participant has any live base or scoped DENY for a capability. */
export async function hasLiveDeny(
  client: Pool | PoolClient,
  roomId: string,
  participantId: string,
  capability: string,
): Promise<boolean> {
  const { rows } = await client.query<{ denied: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM capability_grants
       WHERE room_id = $1 AND participant_id = $2 AND effect = 'DENY'
         AND ended_at IS NULL AND (expires_at IS NULL OR expires_at > clock_timestamp())
         AND (capability = $3 OR left(capability, length($3) + 1) = $3 || ':')
     ) AS denied`,
    [roomId, participantId, capability],
  );
  return rows[0]?.denied ?? false;
}

export const capabilitiesGrantParams = z
  .strictObject({
    participant_id: participantId,
    capability: capabilityString,
    /** ISO 8601 with an offset. Required for Tier 3, at most 24 h ahead. */
    expires_at: z.iso.datetime({ offset: true }).optional(),
    /** Invocations wait for a human's approval (§22.2). */
    requires_approval: z.boolean().default(false),
  })
  .superRefine((params, ctx) => {
    // Tier 3 needs an expiry whoever asks, so that is a VALIDATION error, ahead of the
    // owner-only check (which needs the database).
    let tier: number;
    try {
      tier = tierOf(params.capability);
    } catch (error) {
      // A malformed capability is reported by the capability field; a policy that is not there
      // (UNAVAILABLE) must not be mistaken for it.
      if (error instanceof CrossoverError && error.code === "VALIDATION") return;
      throw error;
    }
    if (tier === 3 && params.expires_at === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["expires_at"],
        message: "Tier 3 capabilities need an expires_at, at most 24 hours ahead",
      });
    }
  });

export const capabilitiesRevokeParams = z.strictObject({
  participant_id: participantId,
  capability: capabilityString,
});

export const capabilitiesListParams = z.strictObject({
  /** Default: the caller. */
  participant_id: participantId.optional(),
});

interface TargetRow {
  role: Role;
  authority: Authority;
  status: string;
}

function validation(message: string, details?: Record<string, unknown>): CrossoverError {
  return new CrossoverError("VALIDATION", message, details ? { details } : {});
}

/**
 * Register `capabilities.grant`, `capabilities.revoke` and `capabilities.list` (T210).
 *
 * Effective capabilities = role bundle + live grants - live denies (§21.1). `revoke` ends the
 * grants its capability string covers (the exact one and narrower scoped ones) and, if the
 * role bundle or a broader grant still covers the capability, records a DENY (so
 * `sandbox.exec` can be taken from a developer). `grant` of a capability ends the DENY with
 * the same string. `authorize()` reads both on every command, so a change
 * applies to the next command.
 */
export function registerCapabilityCommands(dispatcher: Dispatcher): void {
  dispatcher.registerCommand({
    method: "capabilities.grant",
    mutating: true,
    params: capabilitiesGrantParams,
    execute: async (ctx, params) => {
      const { base } = parseCapability(params.capability);
      const tier = tierOf(params.capability);
      if (isAuthorityPower(base)) {
        throw validation(
          `${base} is an authority power: it comes with owner or admin authority, not a grant`,
          { capability: params.capability },
        );
      }

      let expiresAt: Date | undefined;
      if (params.expires_at !== undefined) {
        expiresAt = new Date(params.expires_at);
        const now = Date.now();
        if (expiresAt.getTime() <= now) {
          throw validation("expires_at must be in the future", { expires_at: params.expires_at });
        }
        if (tier === 3 && expiresAt.getTime() > now + TIER3_MAX_TTL_MS) {
          throw validation("Tier 3 capabilities expire within 24 hours", {
            expires_at: params.expires_at,
          });
        }
      }
      if (tier === 3) await ctx.authorize("capabilities.grant_tier3");

      await loadTarget(ctx.client, ctx.room_id, params.participant_id);
      const me = ctx.principal.participant_id;

      // Granting a capability lifts a revocation of the same capability.
      await ctx.client.query(
        `UPDATE capability_grants SET ended_at = clock_timestamp(), ended_by = $4
         WHERE room_id = $1 AND participant_id = $2 AND capability = $3
           AND effect = 'DENY' AND ended_at IS NULL`,
        [ctx.room_id, params.participant_id, params.capability, me],
      );
      const { rows } = await ctx.client.query<{ id: string; expires_at: Date | null }>(
        `INSERT INTO capability_grants
           (id, room_id, participant_id, effect, capability, requires_approval, created_by, created_at, expires_at)
         VALUES ($1, $2, $3, 'GRANT', $4, $5, $6, clock_timestamp(), $7)
         ON CONFLICT (participant_id, effect, capability) WHERE ended_at IS NULL
         DO UPDATE SET requires_approval = EXCLUDED.requires_approval,
                       expires_at = EXCLUDED.expires_at,
                       created_by = EXCLUDED.created_by,
                       created_at = EXCLUDED.created_at
         RETURNING id, expires_at`,
        [
          newId("grant"),
          ctx.room_id,
          params.participant_id,
          params.capability,
          params.requires_approval,
          me,
          expiresAt ?? null,
        ],
      );
      const row = rows[0]!;
      const response = {
        grant_id: row.id,
        participant_id: params.participant_id,
        capability: params.capability,
        tier,
        requires_approval: params.requires_approval,
        expires_at: row.expires_at ? row.expires_at.toISOString() : null,
      };
      return {
        response,
        events: [
          {
            type: "capability.granted" as const,
            // The capability and its terms only; never anything the requester wrote.
            payload: { ...response, granted_by: me },
          },
        ],
      };
    },
  });

  dispatcher.registerCommand({
    method: "capabilities.revoke",
    mutating: true,
    params: capabilitiesRevokeParams,
    execute: async (ctx, params) => {
      const { base } = parseCapability(params.capability);
      if (isAuthorityPower(base)) {
        throw validation(
          `${base} is an authority power: it comes with owner or admin authority and can't be revoked`,
          { capability: params.capability },
        );
      }
      const target = await loadTarget(ctx.client, ctx.room_id, params.participant_id);
      const me = ctx.principal.participant_id;

      // End the grants the revocation covers: the one with this exact string and any narrower
      // one (revoking `workspace.write` also ends `workspace.write:src/**`), so none is left
      // shadowed by the DENY below.
      const { rows: held } = await ctx.client.query<{ id: string; capability: string }>(
        `SELECT id, capability FROM capability_grants
         WHERE room_id = $1 AND participant_id = $2 AND effect = 'GRANT' AND ended_at IS NULL`,
        [ctx.room_id, params.participant_id],
      );
      const covered = held.filter(
        (g) =>
          g.capability === params.capability || capabilityMatches(params.capability, g.capability),
      );
      if (covered.length > 0) {
        await ctx.client.query(
          `UPDATE capability_grants SET ended_at = clock_timestamp(), ended_by = $2
           WHERE room_id = $3 AND id = ANY($1::text[])`,
          [covered.map((g) => g.id), me, ctx.room_id],
        );
      }
      const grantsEnded = covered.length;

      // A capability the role bundle gives, or a broader grant still gives (an unscoped grant
      // and a scoped revoke), can only be taken away with a DENY.
      const { grants: remaining } = await loadLiveGrants(
        ctx.client,
        ctx.room_id,
        params.participant_id,
      );
      const denied =
        (isCapability(base) && ROLE_BUNDLES[target.role].has(base)) ||
        remaining.some((g) => capabilityMatches(g.capability, params.capability));
      if (denied) {
        await ctx.client.query(
          `INSERT INTO capability_grants
             (id, room_id, participant_id, effect, capability, created_by, created_at)
           VALUES ($1, $2, $3, 'DENY', $4, $5, clock_timestamp())
           ON CONFLICT (participant_id, effect, capability) WHERE ended_at IS NULL DO NOTHING`,
          [newId("grant"), ctx.room_id, params.participant_id, params.capability, me],
        );
      }
      if (grantsEnded === 0 && !denied) {
        throw new CrossoverError(
          "NOT_FOUND",
          `${params.participant_id} has no grant of ${params.capability} to revoke`,
          { details: { participant_id: params.participant_id, capability: params.capability } },
        );
      }

      const response = {
        participant_id: params.participant_id,
        capability: params.capability,
        grants_ended: grantsEnded,
        denied,
      };
      return {
        response,
        events: [
          {
            type: "capability.revoked" as const,
            payload: { ...response, revoked_by: me },
          },
        ],
      };
    },
  });

  dispatcher.registerCommand({
    method: "capabilities.list",
    action: "capabilities.read",
    mutating: false,
    view: "none",
    view_reason:
      "grants are the room's visible permission model (§21); scopes are patterns, never denial records",
    params: capabilitiesListParams,
    execute: async (ctx, params) => {
      const id = params.participant_id ?? ctx.principal.participant_id;
      const target = await loadTarget(ctx.client, ctx.room_id, id);
      const { rows } = await ctx.client.query<{
        id: string;
        effect: "GRANT" | "DENY";
        capability: string;
        requires_approval: boolean;
        expires_at: Date | null;
        created_by: string;
        created_at: Date;
      }>(
        `SELECT id, effect, capability, requires_approval, expires_at, created_by, created_at
         FROM capability_grants
         WHERE room_id = $1 AND participant_id = $2 AND ended_at IS NULL
           AND (expires_at IS NULL OR expires_at > clock_timestamp())
         ORDER BY created_at, id`,
        [ctx.room_id, id],
      );
      const view = (r: (typeof rows)[number]) => ({
        id: r.id,
        capability: r.capability,
        created_by: r.created_by,
        created_at: r.created_at.toISOString(),
      });
      return {
        response: {
          participant_id: id,
          role: target.role,
          authority: target.authority,
          bundle: [...effectiveCapabilities(target.role, target.authority)].sort(),
          grants: rows
            .filter((r) => r.effect === "GRANT")
            .map((r) => ({
              ...view(r),
              tier: tierOf(r.capability),
              requires_approval: r.requires_approval,
              expires_at: r.expires_at ? r.expires_at.toISOString() : null,
            })),
          revocations: rows.filter((r) => r.effect === "DENY").map(view),
        },
      };
    },
  });
}

async function loadTarget(
  client: { query: (sql: string, values: unknown[]) => Promise<{ rows: TargetRow[] }> },
  roomId: string,
  participantId: string,
): Promise<TargetRow> {
  const { rows } = await client.query(
    "SELECT role, authority, status FROM participants WHERE id = $1 AND room_id = $2",
    [participantId, roomId],
  );
  const target = rows[0];
  if (!target) throw new CrossoverError("NOT_FOUND", `Participant ${participantId} not found`);
  if (target.status === "REMOVED") {
    throw validation(`Participant ${participantId} has been removed`);
  }
  return target;
}
