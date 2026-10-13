import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { CrossoverError } from "@crossover/protocol";
import { loadPolicy } from "@open-policy-agent/opa-wasm";
import type { Tier } from "./tiers.js";

/**
 * The facts the authorization policy (policy/authz.rego) decides from. `authorize()` loads them
 * in the command's transaction; every one is always present, with a neutral value when it does
 * not apply, because the policy refuses an input that is missing a fact or has one of the wrong
 * type.
 */
export interface AuthzFacts {
  /** The command being authorized; archived rooms allow only retention controls. */
  method: string;
  /** The resource belongs to the principal's room. */
  room_match: boolean;
  /**
   * The participant's row, or null when there is none. The policy knows which roles and
   * authorities exist (bundles.gen.rego) and refuses a participant with any other.
   */
  participant: { status: string; authority: string; role: string } | null;
  room_status: string;
  /** The command changes state. */
  mutating: boolean;
  /** The command was approved by an owner or admin (T905). */
  approved: boolean;
  /** The capability asked for, `<resource>.<action>[:<scope>]` (§21.1). */
  action: string;
  /** The workspace path the check is about, when the resource names one; null otherwise. */
  resource_path: string | null;
  /** Set only on the command-level gate of a command that authorizes each path itself (T218). */
  per_path: boolean;
  /** The participant's live grants (not ended, not expired). */
  grants: { capability: string; requires_approval: boolean }[];
  /** The participant's live revocations. */
  denies: { capability: string }[];
}

export const DENY_CODES = [
  "FORBIDDEN",
  "NOT_FOUND",
  "PARTICIPANT_PAUSED",
  "ROOM_PAUSED",
  "APPROVAL_REQUIRED",
] as const;
export type DenyCode = (typeof DENY_CODES)[number];

export type Decision = { allow: true } | { allow: false; code: DenyCode; reason: string };

export const GRANT_CHECK_REASONS = [
  "expiry_not_in_future",
  "tier3_needs_expiry",
  "tier3_expiry_too_long",
] as const;
export type GrantCheckReason = (typeof GRANT_CHECK_REASONS)[number];
export type GrantCheckResult = { allow: true } | { allow: false; reason: GrantCheckReason };

/** The policy could not be loaded or did not answer with a decision: the command is refused. */
export class PolicyEngineError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PolicyEngineError";
  }
}

export interface PolicyEngine {
  decide(facts: AuthzFacts): Decision;
  /**
   * The risk tier (§21.2) of a capability's base and optional concrete scope, from
   * policy/tiers.rego.
   */
  tier(base: string, scope: string | undefined): Tier;
  /** Whether a capability grant and its lifetime satisfy the policy in policy/grants.rego. */
  grantCheck(base: string, scope: string | undefined, expiresInMs: number | null): GrantCheckResult;
}

const DECISION_ENTRYPOINT = "crossover/authz/decision";
const TIER_ENTRYPOINT = "crossover/tiers/tier";
const GRANT_CHECK_ENTRYPOINT = "crossover/grants/grant_check";

/** Where the compiled policy lives: next to `src/` and `dist/`, so it is found from both. */
const POLICY_WASM = new URL("../policy/policy.wasm", import.meta.url);

/**
 * Instantiate a compiled policy. It is evaluated in-process (no network hop, §21.3), and an
 * evaluation that throws or does not return exactly one well-formed decision is an error
 * (never an allow).
 */
export async function createPolicyEngine(wasm: Uint8Array): Promise<PolicyEngine> {
  let policy;
  try {
    policy = await loadPolicy(wasm);
  } catch (error) {
    throw new PolicyEngineError("The authorization policy could not be loaded", { cause: error });
  }
  return {
    decide(facts) {
      try {
        return parseDecision(policy.evaluate(facts, DECISION_ENTRYPOINT));
      } catch (error) {
        if (error instanceof PolicyEngineError) throw error;
        throw new PolicyEngineError("The authorization policy failed to evaluate", {
          cause: error,
        });
      }
    },
    tier(base, scope) {
      try {
        return parseTier(policy.evaluate({ base, scope: scope ?? null }, TIER_ENTRYPOINT));
      } catch (error) {
        if (error instanceof PolicyEngineError) throw error;
        throw new PolicyEngineError("The tier policy failed to evaluate", { cause: error });
      }
    },
    grantCheck(base, scope, expiresInMs) {
      try {
        return parseGrantCheck(
          policy.evaluate(
            { base, scope: scope ?? null, expires_in_ms: expiresInMs },
            GRANT_CHECK_ENTRYPOINT,
          ),
        );
      } catch (error) {
        if (error instanceof PolicyEngineError) throw error;
        throw new PolicyEngineError("The grant policy failed to evaluate", { cause: error });
      }
    },
  };
}

/** The one well-formed decision in a policy result; anything else is an error, never an allow. */
export function parseDecision(result: unknown): Decision {
  const answer = Array.isArray(result) && result.length === 1 ? (result[0] as unknown) : undefined;
  const value = isRecord(answer) ? answer["result"] : undefined;
  if (isRecord(value) && value["allow"] === true && Object.keys(value).length === 1) {
    return { allow: true };
  }
  if (
    isRecord(value) &&
    value["allow"] === false &&
    typeof value["reason"] === "string" &&
    (DENY_CODES as readonly unknown[]).includes(value["code"])
  ) {
    return { allow: false, code: value["code"] as DenyCode, reason: value["reason"] };
  }
  throw new PolicyEngineError("The authorization policy returned no decision");
}

/** The one tier (0 to 3) in a policy result; anything else is an error, never a lower tier. */
export function parseTier(result: unknown): Tier {
  const answer = Array.isArray(result) && result.length === 1 ? (result[0] as unknown) : undefined;
  const value = isRecord(answer) ? answer["result"] : undefined;
  if (value === 0 || value === 1 || value === 2 || value === 3) return value;
  throw new PolicyEngineError("The tier policy returned no tier");
}

/** The one well-formed grant-policy answer; unknown reasons or extra fields fail closed. */
export function parseGrantCheck(result: unknown): GrantCheckResult {
  const answer = Array.isArray(result) && result.length === 1 ? (result[0] as unknown) : undefined;
  const value = isRecord(answer) ? answer["result"] : undefined;
  if (isRecord(value) && value["allow"] === true && Object.keys(value).length === 1) {
    return { allow: true };
  }
  if (
    isRecord(value) &&
    value["allow"] === false &&
    typeof value["reason"] === "string" &&
    (GRANT_CHECK_REASONS as readonly unknown[]).includes(value["reason"]) &&
    Object.keys(value).length === 2
  ) {
    return { allow: false, reason: value["reason"] as GrantCheckReason };
  }
  throw new PolicyEngineError("The grant policy returned no decision");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface PolicyInfo {
  /** SHA-256 of policy.wasm, logged at startup so a deploy shows which policy it runs. */
  sha256: string;
  bytes: number;
}

let shared: Promise<{ engine: PolicyEngine; info: PolicyInfo }> | undefined;
/** The shipped engine once it has loaded, for the callers that cannot wait for it (`loadedPolicy`). */
let loaded: PolicyEngine | undefined;

/** The shipped policy, loaded once; a failed load is tried again by the next command. */
function shippedPolicy() {
  shared ??= readFile(POLICY_WASM).then(async (wasm) => {
    const engine = await createPolicyEngine(wasm);
    loaded = engine;
    return {
      engine,
      info: { sha256: createHash("sha256").update(wasm).digest("hex"), bytes: wasm.length },
    };
  });
  shared.catch(() => (shared = undefined));
  return shared;
}

/**
 * The shipped policy if `initPolicy()` (or a command) has loaded it; otherwise `UNAVAILABLE`,
 * never a guess: the callers are synchronous (`tierOf` runs inside validation), so they cannot
 * load it themselves, and a server loads it before it listens.
 */
export function loadedPolicy(): PolicyEngine {
  if (loaded) return loaded;
  throw new CrossoverError("UNAVAILABLE", "The authorization policy is not loaded");
}

/** Synchronously check a capability grant using the loaded policy, never a TypeScript fallback. */
export function grantCheck(
  base: string,
  scope: string | undefined,
  expiresInMs: number | null,
): GrantCheckResult {
  return loadedPolicy().grantCheck(base, scope, expiresInMs);
}

/** What `authorize()` asks of the shipped policy: the decision (not the tier). */
export const policyEngine = async (): Promise<Pick<PolicyEngine, "decide">> =>
  (await shippedPolicy()).engine;

/**
 * Load the policy now instead of at the first command, so a server with a missing or broken
 * module does not start, and return its digest to log.
 */
export const initPolicy = async (): Promise<PolicyInfo> => (await shippedPolicy()).info;
