import type { Pool, PoolClient } from "@crossover/db";
import { CrossoverError, isMethodName, METHODS } from "@crossover/protocol";
import { loadLiveGrants } from "./grants.js";
import { policyEngine, type AuthzFacts, type Decision } from "./engine.js";
import { CAPABILITIES, isCapability } from "./bundles.js";

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
  const { facts, row } = await loadFacts(principal, action, resource, context);
  const decision = await decide(facts);
  if (decision.allow) return;
  throw refusal(decision, { principal, action, row });
}

/** Ask the policy (policy/authz.rego); a policy that cannot answer refuses the command. */
async function decide(facts: AuthzFacts): Promise<Decision> {
  try {
    return (await policyEngine()).decide(facts);
  } catch (error) {
    console.error("[policy] authorization failed closed", error);
    throw new CrossoverError("UNAVAILABLE", "The authorization policy is unavailable");
  }
}

interface ParticipantRow {
  authority: string;
  role: string;
  status: string;
  room_status: string;
}

/**
 * Read what the policy decides from, in the command's transaction, so a revocation or a pause
 * applies to the very next command. The principal is only a snapshot from when the token was
 * checked: the participant's role, authority and status are re-read here, and those win.
 *
 * Commands that act on a path call `authorize("workspace.write", { path })` with the path in the
 * resource, not in the action. The policy matches scoped grants and denies against that path, so
 * `workspace.write:secrets/**` applies to it just as to `workspace.write:secrets/k`.
 */
async function loadFacts(
  principal: PolicyPrincipal,
  action: string,
  resource: PolicyResource,
  context: PolicyContext,
): Promise<{ facts: AuthzFacts; row: ParticipantRow | undefined }> {
  const base = typeof action === "string" ? (action.split(":", 1)[0] ?? "") : "";
  const facts: AuthzFacts = {
    method: context.method,
    room_match: resource.room_id === principal.room_id,
    participant: null,
    room_status: "",
    mutating: isMutating(context.method, base),
    approved: context.approved === true,
    // Not a string (a bug in the caller): the empty capability, which no catalog entry matches.
    action: typeof action === "string" ? action : "",
    resource_path: typeof resource.path === "string" ? resource.path : null,
    per_path: context.perPath === true,
    grants: [],
    denies: [],
  };
  if (!facts.room_match) return { facts, row: undefined };

  const { rows } = await context.client.query<ParticipantRow>(
    `SELECT p.authority, p.role, p.status, r.status AS room_status
     FROM participants p JOIN rooms r ON r.id = p.room_id
     WHERE p.id = $1 AND p.room_id = $2`,
    [principal.participant_id, principal.room_id],
  );
  const row = rows[0];
  if (!row) return { facts, row };
  facts.participant = { status: row.status, authority: row.authority, role: row.role };
  facts.room_status = row.room_status;

  const { grants, denies } = await loadLiveGrants(
    context.client,
    principal.room_id,
    principal.participant_id,
  );
  // Only grants and revocations of this capability can cover it (the policy checks that again), so
  // the rest are not sent: a participant with grants of a dozen capabilities pays for one.
  const ofThisCapability = ({ capability }: { capability: string }): boolean =>
    capability.split(":", 1)[0] === base;
  facts.grants = grants
    .filter(ofThisCapability)
    .map((g) => ({ capability: g.capability, requires_approval: g.requires_approval }));
  facts.denies = denies.filter(ofThisCapability).map((d) => ({ capability: d.capability }));
  return { facts, row };
}

/** The §16.3 error for a refusal, with the details the clients and the ledger rely on. */
function refusal(
  decision: Extract<Decision, { allow: false }>,
  input: { principal: PolicyPrincipal; action: string; row: ParticipantRow | undefined },
): CrossoverError {
  const { principal, action, row } = input;
  switch (decision.code) {
    case "PARTICIPANT_PAUSED":
      return new CrossoverError("PARTICIPANT_PAUSED", "Participant is paused", {
        details: { participant_id: principal.participant_id },
      });
    case "NOT_FOUND":
      return new CrossoverError("NOT_FOUND", "Room not found");
    case "ROOM_PAUSED":
      return new CrossoverError(
        "ROOM_PAUSED",
        row?.room_status === "ARCHIVED" ? "Room is archived" : "Room is paused",
        { details: { room_status: row?.room_status } },
      );
    case "APPROVAL_REQUIRED":
      return new CrossoverError("APPROVAL_REQUIRED", `Approval required for ${action}`, {
        details: { capability: action },
      });
    case "FORBIDDEN":
      if (decision.reason === "missing_capability" && row) {
        return forbidden(action, { role: row.role, authority: row.authority });
      }
      if (FORBIDDEN_REASONS.has(decision.reason) || decision.reason.startsWith("participant_")) {
        return forbidden(action, { reason: decision.reason });
      }
  }
  // A reason this code does not know (or `invalid_input`) is a bug here or in the policy: refuse
  // loudly instead of dressing it up as a missing capability.
  console.error("[policy] unexpected refusal", decision);
  return new CrossoverError("UNAVAILABLE", "The authorization policy is unavailable");
}

const FORBIDDEN_REASONS = new Set([
  "room_mismatch",
  "not_a_participant",
  "invalid_participant",
  "invalid_path",
  "revoked",
  "unknown_capability",
]);

/**
 * Does the command change state? The catalog says for a known method; for anything else the
 * capability's own flag, and an unknown capability counts as a mutation (fail closed).
 */
function isMutating(method: string, base: string): boolean {
  if (isMethodName(method)) return METHODS[method].mutating;
  return isCapability(base) ? CAPABILITIES[base].mutating : true;
}

function forbidden(action: string, extra: Record<string, unknown>): CrossoverError {
  return new CrossoverError("FORBIDDEN", `Missing capability ${String(action)}`, {
    details: { missing_capability: action, ...extra },
  });
}
