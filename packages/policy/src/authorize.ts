import type { Pool, PoolClient } from "@crossover/db";
import { CrossoverError } from "@crossover/protocol";
import { capabilityMatches } from "./capability.js";
import { loadLiveGrants } from "./grants.js";
import {
  AUTHORITIES,
  effectiveCapabilities,
  isCapability,
  ROLES,
  type Authority,
  type Role,
} from "./bundles.js";

/** The fields of an authenticated principal the policy looks at. */
export interface PolicyPrincipal {
  participant_id: string;
  room_id: string;
}

export interface PolicyResource {
  room_id: string;
  [key: string]: unknown;
}

export interface PolicyContext {
  method: string;
  params: unknown;
  /** The command's transaction (or any connection). */
  client: Pool | PoolClient;
}

/**
 * Allow the command, or throw. Resolves when `principal` may perform `action` on `resource`.
 *
 * `action` is a capability, `<resource>.<action>[:<scope>]` (§21.1). Scopes only narrow
 * *grants*; a role bundle covers every scope of a capability, so `workspace.write:src/x.ts`
 * is allowed whenever `workspace.write` is (path-scoped grants arrive with T209/T210).
 *
 * The principal is a snapshot from when the token was checked, so the participant's role,
 * authority and status are re-read here, in the command's transaction, and those win.
 * Denials:
 * - `FORBIDDEN` with `details.missing_capability = action` when the participant's role bundle,
 *   authority and live grants don't include it, a live revocation (`DENY`) covers it
 *   (`reason: "revoked"`), or the capability is unknown and no grant covers it (fail closed);
 * - `APPROVAL_REQUIRED` when the only grants covering it carry an approval gate (T210, §22.2);
 * - `FORBIDDEN` when the principal isn't an active participant of the resource's room;
 * - `PARTICIPANT_PAUSED` for any action by a paused participant.
 */
export async function authorize(
  principal: PolicyPrincipal,
  action: string,
  resource: PolicyResource,
  context: PolicyContext,
): Promise<void> {
  if (resource.room_id !== principal.room_id) {
    throw forbidden(action, { reason: "room_mismatch" });
  }

  const { rows } = await context.client.query<{ authority: string; role: string; status: string }>(
    "SELECT authority, role, status FROM participants WHERE id = $1 AND room_id = $2",
    [principal.participant_id, principal.room_id],
  );
  const participant = rows[0];
  if (!participant) throw forbidden(action, { reason: "not_a_participant" });
  if (participant.status === "PAUSED") {
    throw new CrossoverError("PARTICIPANT_PAUSED", "Participant is paused", {
      details: { participant_id: principal.participant_id },
    });
  }
  if (participant.status !== "ACTIVE") {
    throw forbidden(action, { reason: `participant_${participant.status.toLowerCase()}` });
  }
  if (!isRole(participant.role) || !isAuthority(participant.authority)) {
    // The database CHECKs make this unreachable; refuse rather than guess.
    throw forbidden(action, { reason: "invalid_participant" });
  }

  const base = typeof action === "string" ? (action.split(":", 1)[0] ?? "") : "";
  const inBundle =
    isCapability(base) && effectiveCapabilities(participant.role, participant.authority).has(base);

  // Effective = role bundle + live grants - live denies (§21.1), read now so a revocation
  // applies to the very next command.
  const { grants, denies } = await loadLiveGrants(
    context.client,
    principal.room_id,
    principal.participant_id,
  );
  if (denies.some((d) => capabilityMatches(d.capability, action))) {
    throw forbidden(action, { reason: "revoked" });
  }
  const covering = grants.filter((g) => capabilityMatches(g.capability, action));
  if (covering.length > 0) {
    if (covering.some((g) => !g.requires_approval)) return;
    // An approval gate (§22.2) makes the action wait for a human, even when the role bundle
    // would allow it. The approval queue arrives with T905; until then the gate fails closed.
    throw new CrossoverError("APPROVAL_REQUIRED", `Approval required for ${action}`, {
      details: { capability: action },
    });
  }
  if (inBundle) return;
  if (!isCapability(base)) throw forbidden(action, { reason: "unknown_capability" });
  throw forbidden(action, { role: participant.role, authority: participant.authority });
}

function forbidden(action: string, extra: Record<string, unknown>): CrossoverError {
  return new CrossoverError("FORBIDDEN", `Missing capability ${String(action)}`, {
    details: { missing_capability: action, ...extra },
  });
}

function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

function isAuthority(value: string): value is Authority {
  return (AUTHORITIES as readonly string[]).includes(value);
}
