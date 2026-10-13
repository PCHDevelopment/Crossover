import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { loadPolicy } from "@open-policy-agent/opa-wasm";

/**
 * The facts the authorization policy (policy/authz.rego) decides from. `authorize()` loads them
 * in the command's transaction; every one is always present, with a neutral value when it does
 * not apply, because the policy refuses an input that is missing a fact or has one of the wrong
 * type.
 */
export interface AuthzFacts {
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

/** The policy could not be loaded or did not answer with a decision: the command is refused. */
export class PolicyEngineError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PolicyEngineError";
  }
}

export interface PolicyEngine {
  decide(facts: AuthzFacts): Decision;
}

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
        return parseDecision(policy.evaluate(facts));
      } catch (error) {
        if (error instanceof PolicyEngineError) throw error;
        throw new PolicyEngineError("The authorization policy failed to evaluate", {
          cause: error,
        });
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface PolicyInfo {
  /** SHA-256 of policy.wasm, logged at startup so a deploy shows which policy it runs. */
  sha256: string;
  bytes: number;
}

let shared: Promise<{ engine: PolicyEngine; info: PolicyInfo }> | undefined;

/** The shipped policy, loaded once; a failed load is tried again by the next command. */
function shippedPolicy() {
  shared ??= readFile(POLICY_WASM).then(async (wasm) => ({
    engine: await createPolicyEngine(wasm),
    info: { sha256: createHash("sha256").update(wasm).digest("hex"), bytes: wasm.length },
  }));
  shared.catch(() => (shared = undefined));
  return shared;
}

export const policyEngine = async (): Promise<PolicyEngine> => (await shippedPolicy()).engine;

/**
 * Load the policy now instead of at the first command, so a server with a missing or broken
 * module does not start, and return its digest to log.
 */
export const initPolicy = async (): Promise<PolicyInfo> => (await shippedPolicy()).info;
