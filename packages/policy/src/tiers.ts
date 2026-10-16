import { CAPABILITIES, isCapability } from "./bundles.js";

/** Risk tiers (ARCHITECTURE §21.2, D14). */
export type Tier = 0 | 1 | 2 | 3;

/**
 * Tiers of the external capabilities §21.2 names. Plugin capabilities that aren't listed
 * here are Tier 3 until someone classifies them (see {@link capabilityTier}).
 */
export const EXTERNAL_TIERS: Readonly<Record<string, Tier>> = {
  // 0: read
  "github.read_repository": 0,
  "aws.read_logs": 0,
  // 2: external, reversible side effects. Granted by owner/admin, no expiry.
  "github.create_pull_request": 2,
  "slack.post_message": 2,
  "browser.navigate": 2,
  // 3: external, irreversible or production. Owner only, expires within 24 h, never in bundles.
  "aws.deploy_lambda": 3,
};

/**
 * A capability whose risk tier depends on its concrete scope: a scope that starts with `prefix`
 * is `tier`, any other scope, and no scope at all, is `otherwise` (a missing scope stays strict).
 * This is data, not a function, so `gen:wasm` can write it into the policy (tiers.gen.rego).
 */
export interface ScopedTierRule {
  prefix: string;
  tier: Tier;
  otherwise: Tier;
}

export const SCOPED_TIER_RULES: Readonly<Record<string, ScopedTierRule>> = {
  "aws.deploy_lambda": { prefix: "staging-", tier: 2, otherwise: 3 },
};

/** Catalog capabilities that are Tier 3 whatever their `mutating` flag says. */
export const CATALOG_TIER_3: ReadonlySet<string> = new Set(["capabilities.grant_tier3"]);

/**
 * The risk tier of a capability's base and optional concrete scope:
 * - 0: reads, including the room's own read capabilities;
 * - 1: room-internal writes (messages, tasks, memory, workspace, sandbox, and the authority
 *   powers, which are governed by authority rather than grants);
 * - 2 and 3: the external capabilities in {@link EXTERNAL_TIERS};
 * - **3 for anything unknown**, so a capability nobody classified can't be handed out as if it
 *   were harmless (fail closed).
 * `capabilities.grant_tier3` is itself Tier 3.
 *
 * This is the reference implementation. The decision is made by the policy (policy/tiers.rego,
 * through `tierOf`); `tiers-oracle.test.ts` keeps the two equal.
 */
export function capabilityTier(base: string, scope?: string): Tier {
  const scoped = Object.hasOwn(SCOPED_TIER_RULES, base) ? SCOPED_TIER_RULES[base] : undefined;
  if (scoped) return scope?.startsWith(scoped.prefix) ? scoped.tier : scoped.otherwise;
  if (Object.hasOwn(EXTERNAL_TIERS, base)) return EXTERNAL_TIERS[base]!;
  if (isCapability(base)) {
    if (CATALOG_TIER_3.has(base)) return 3;
    return CAPABILITIES[base].mutating ? 1 : 0;
  }
  return 3;
}
