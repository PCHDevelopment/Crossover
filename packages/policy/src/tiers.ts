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

/** Capabilities whose risk tier depends on their concrete scope. Missing scope stays strict. */
export const SCOPED_TIERS: Readonly<Record<string, (scope: string | undefined) => Tier>> = {
  "aws.deploy_lambda": (scope) => (scope?.startsWith("staging-") ? 2 : 3),
};

/**
 * The risk tier of a capability's base and optional concrete scope:
 * - 0: reads, including the room's own read capabilities;
 * - 1: room-internal writes (messages, tasks, memory, workspace, sandbox, and the authority
 *   powers, which are governed by authority rather than grants);
 * - 2 and 3: the external capabilities in {@link EXTERNAL_TIERS};
 * - **3 for anything unknown**, so a capability nobody classified can't be handed out as if it
 *   were harmless (fail closed).
 * `capabilities.grant_tier3` is itself Tier 3.
 */
export function capabilityTier(base: string, scope?: string): Tier {
  const scoped = SCOPED_TIERS[base];
  if (scoped) return scoped(scope);
  if (Object.hasOwn(EXTERNAL_TIERS, base)) return EXTERNAL_TIERS[base]!;
  if (isCapability(base)) {
    if (base === "capabilities.grant_tier3") return 3;
    return CAPABILITIES[base].mutating ? 1 : 0;
  }
  return 3;
}
