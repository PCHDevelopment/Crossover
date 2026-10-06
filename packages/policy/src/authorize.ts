import type { Pool, PoolClient } from "@crossover/db";
import { CrossoverError } from "@crossover/protocol";
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
 * - `FORBIDDEN` with `details.missing_capability = action` when the participant's role bundle
 *   and authority don't include it, or the capability is unknown (fail closed);
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
  if (!isCapability(base)) {
    throw forbidden(action, { reason: "unknown_capability" });
  }
  if (!effectiveCapabilities(participant.role, participant.authority).has(base)) {
    throw forbidden(action, { role: participant.role, authority: participant.authority });
  }
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
