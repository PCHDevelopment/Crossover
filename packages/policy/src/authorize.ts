import type { Pool, PoolClient } from "@crossover/db";
import { CrossoverError, isMethodName, METHODS } from "@crossover/protocol";
import {
  capabilityMatches,
  capabilityMatchesPath,
  isSafeRequestPath,
  parseCapability,
  PATH_SCOPED_RESOURCES,
} from "./capability.js";
import { loadLiveGrants } from "./grants.js";
import {
  AUTHORITIES,
  CAPABILITIES,
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
  /**
   * Set only on the command-level gate of a command that declared `perPathAuthorize` (T218):
   * one that authorizes every path it touches itself. For such a gate, a live ungated scoped
   * grant of the capability is enough to get in; the per-path checks then decide. Per-path
   * checks never carry it.
   */
  perPath?: boolean;
  /**
   * Set only while a command that an owner or admin approved (T905) runs as its requester: the
   * approval gate on a grant (§22.2) is what was approved, so it no longer stops the command.
   * Everything else (revocations, pauses, a frozen room, missing capabilities) still applies.
   */
  approved?: boolean;
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
 * - `PARTICIPANT_PAUSED` for any action by a paused participant;
 * - `ROOM_PAUSED` (`details.room_status`) for a mutation in a frozen room by anyone but the
 *   owner, and for any mutation in an archived room (T214, §5); `NOT_FOUND` in a deleted one.
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

  const { rows } = await context.client.query<{
    authority: string;
    role: string;
    status: string;
    room_status: string;
  }>(
    `SELECT p.authority, p.role, p.status, r.status AS room_status
     FROM participants p JOIN rooms r ON r.id = p.room_id
     WHERE p.id = $1 AND p.room_id = $2`,
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

  // The room's own state (§5): a frozen room accepts mutations from its owner only; an
  // archived room accepts none, from anyone. Reads always pass this gate.
  if (participant.room_status !== "ACTIVE") {
    if (participant.room_status === "DELETED") {
      throw new CrossoverError("NOT_FOUND", "Room not found");
    }
    const ownerMayAct = participant.room_status === "PAUSED" && participant.authority === "OWNER";
    if (isMutating(context.method, base) && !ownerMayAct) {
      throw new CrossoverError(
        "ROOM_PAUSED",
        participant.room_status === "ARCHIVED" ? "Room is archived" : "Room is paused",
        { details: { room_status: participant.room_status } },
      );
    }
  }

  const inBundle =
    isCapability(base) && effectiveCapabilities(participant.role, participant.authority).has(base);

  // Effective = role bundle + live grants - live denies (§21.1), read now so a revocation
  // applies to the very next command.
  //
  // Commands that act on a path call `authorize("workspace.write", { path })` with the path in
  // the resource, not in the action. Scoped grants and denies are matched against that path,
  // so `workspace.write:secrets/**` applies to it just as to `workspace.write:secrets/k`.
  const path = pathOf(action, base, resource);
  // "" names the workspace root (listing it): not a path to test against scopes, but fine.
  if (path !== undefined && path !== "" && !isSafeRequestPath(path)) {
    throw forbidden(action, { reason: "invalid_path" });
  }
  const covers = (capability: string): boolean =>
    path === undefined
      ? capabilityMatches(capability, action)
      : capabilityMatchesPath(capability, base, path);
  const { grants, denies } = await loadLiveGrants(
    context.client,
    principal.room_id,
    principal.participant_id,
  );
  if (denies.some((d) => covers(d.capability))) {
    throw forbidden(action, { reason: "revoked" });
  }
  const covering = grants.filter((g) => covers(g.capability));
  if (covering.length > 0) {
    if (context.approved || covering.some((g) => !g.requires_approval)) return;
    // An approval gate (§22.2) makes the action wait for a human, even when the role bundle
    // would allow it: the dispatcher queues the command (T905) and answers with the approval's id.
    throw new CrossoverError("APPROVAL_REQUIRED", `Approval required for ${action}`, {
      details: { capability: action },
    });
  }
  if (inBundle) return;
  // A per-path command's gate (T218): holding an ungated scoped grant of the capability is
  // enough to reach the handler, which authorizes each path itself. A DENY covering the whole
  // capability already refused above.
  if (
    context.perPath === true &&
    path === undefined &&
    action === base &&
    grants.some((g) => !g.requires_approval && hasScopeOf(g.capability, base))
  ) {
    return;
  }
  if (!isCapability(base)) throw forbidden(action, { reason: "unknown_capability" });
  throw forbidden(action, { role: participant.role, authority: participant.authority });
}

/**
 * The workspace path a check is about, when it is named in the resource rather than the
 * action: only for an unscoped action on a path-scoped resource (`workspace.*`).
 */
function pathOf(action: string, base: string, resource: PolicyResource): string | undefined {
  if (action !== base || typeof resource.path !== "string") return undefined;
  const root = base.split(".", 1)[0] ?? "";
  return PATH_SCOPED_RESOURCES.has(root) ? resource.path : undefined;
}

/**
 * Does the command change state? The catalog says for a known method; for anything else the
 * capability's own flag, and an unknown capability counts as a mutation (fail closed).
 */
function isMutating(method: string, base: string): boolean {
  if (isMethodName(method)) return METHODS[method].mutating;
  return isCapability(base) ? CAPABILITIES[base].mutating : true;
}

/** Is `capability` a scoped grant (has a `:scope`) of `base`? */
function hasScopeOf(capability: string, base: string): boolean {
  try {
    const parsed = parseCapability(capability);
    return parsed.base === base && parsed.scope !== undefined;
  } catch {
    return false;
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
