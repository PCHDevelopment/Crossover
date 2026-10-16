import { CrossoverError } from "@crossover/protocol";
import { pathGlobMatch, plainGlobMatch } from "./glob.js";
import { loadedPolicy } from "./engine.js";
import type { Tier } from "./tiers.js";

/** Resources whose scope is a workspace path (matched with path globs). */
export const PATH_SCOPED_RESOURCES: ReadonlySet<string> = new Set(["workspace"]);

export const MAX_CAPABILITY_LENGTH = 512;

export interface ParsedCapability {
  resource: string;
  action: string;
  /** `<resource>.<action>`, without the scope. */
  base: string;
  /** What follows the first `:`, if anything. May itself contain colons (ARNs). */
  scope?: string;
}

const BASE = /^([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)$/;

function malformed(capability: unknown, reason: string): CrossoverError {
  return new CrossoverError("VALIDATION", `Malformed capability: ${reason}`, {
    details: { capability: typeof capability === "string" ? capability : null, reason },
  });
}

/**
 * Parse `<resource>.<action>[:<scope>]` (ARCHITECTURE §21.1). Resource and action are
 * lowercase snake_case; the scope is everything after the first `:`, printable, without
 * whitespace. Throws `VALIDATION` for anything else, including wildcards in the resource or
 * action (`tasks.*`) and, for path-scoped resources, path scopes that could escape their
 * root.
 */
export function parseCapability(capability: string): ParsedCapability {
  if (typeof capability !== "string" || capability === "") throw malformed(capability, "empty");
  if (capability.length > MAX_CAPABILITY_LENGTH) throw malformed(capability, "too long");

  const colon = capability.indexOf(":");
  const base = colon === -1 ? capability : capability.slice(0, colon);
  const match = BASE.exec(base);
  if (!match) throw malformed(capability, "expected <resource>.<action>");
  const [, resource, action] = match as unknown as [string, string, string];

  if (colon === -1) return { resource, action, base };

  const scope = capability.slice(colon + 1);
  if (scope === "") throw malformed(capability, "empty scope");
  // Control characters (NUL included) and whitespace have no business in a scope.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f]/.test(scope)) throw malformed(capability, "invalid character in scope");
  if (PATH_SCOPED_RESOURCES.has(resource)) assertSafePath(capability, scope);
  return { resource, action, base, scope };
}

/**
 * A path scope (a glob in a grant, a literal path in a request) must be relative, have no
 * empty, `.` or `..` segments, and no trailing slash, so it can't name anything outside the
 * workspace root.
 */
function assertSafePath(capability: string, scope: string): void {
  if (scope.startsWith("/")) throw malformed(capability, "path scope must be relative");
  if (scope.includes("\\")) throw malformed(capability, "path scope must use / separators");
  for (const segment of scope.split("/")) {
    if (segment === "") throw malformed(capability, "path scope has an empty segment");
    if (segment === "." || segment === "..") {
      throw malformed(capability, "path scope has a . or .. segment");
    }
  }
}

/**
 * Does the grant `granted` cover the request `requested`?
 *
 * - Same resource and action are required.
 * - An **unscoped grant covers every scope** (and the unscoped capability).
 * - A **scoped grant never covers the unscoped capability**, which means "all scopes".
 * - Otherwise the request's scope, a concrete value, must match the grant's glob: path globs
 *   for workspace paths (see `glob.ts`), IAM-style globs for everything else. The request's
 *   scope is literal: `*` in it is just a character.
 *
 * Fails closed: if either string is malformed (including a request path that tries `..`), the
 * answer is `false`. It never throws.
 */
export function capabilityMatches(granted: string, requested: string): boolean {
  let g: ParsedCapability;
  let r: ParsedCapability;
  try {
    g = parseCapability(granted);
    r = parseCapability(requested);
  } catch {
    return false;
  }
  if (g.base !== r.base) return false;
  if (g.scope === undefined) return true;
  if (r.scope === undefined) return false;
  return PATH_SCOPED_RESOURCES.has(g.resource)
    ? pathGlobMatch(g.scope, r.scope)
    : plainGlobMatch(g.scope, r.scope);
}

/**
 * The risk tier (§21.2) of a capability string; throws `VALIDATION` if it is malformed. The tier
 * is the policy's (policy/tiers.rego), so the policy must be loaded (`initPolicy()`): if it is
 * not, or fails, this throws `UNAVAILABLE`. It never falls back to a lower tier.
 */
export function tierOf(capability: string): Tier {
  const parsed = parseCapability(capability);
  try {
    return loadedPolicy().tier(parsed.base, parsed.scope);
  } catch (error) {
    if (error instanceof CrossoverError) throw error;
    throw new CrossoverError("UNAVAILABLE", "The authorization policy is unavailable");
  }
}

/**
 * Is `path` a workspace path a request may name: relative, `/`-separated, no empty, `.` or
 * `..` segments, no control characters? (Spaces and other printable characters are fine in a
 * file name, unlike in a capability scope.)
 */
export function isSafeRequestPath(path: string): boolean {
  if (typeof path !== "string" || path === "" || path.length > MAX_CAPABILITY_LENGTH * 8)
    return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(path) || path.startsWith("/")) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * Does the grant `granted` cover `base` (`<resource>.<action>`) applied to the workspace path
 * `path`? Like {@link capabilityMatches} with a request of `base:path`, but the path is taken
 * as is, so file names with spaces work (`""` is the workspace root). Fails closed (`false`) for a malformed grant or an
 * unsafe path; it never throws.
 */
export function capabilityMatchesPath(granted: string, base: string, path: string): boolean {
  // "" is the workspace root: only an unscoped grant covers it; no scope is "the root".
  if (path !== "" && !isSafeRequestPath(path)) return false;
  let g: ParsedCapability;
  try {
    g = parseCapability(granted);
  } catch {
    return false;
  }
  if (g.base !== base) return false;
  if (g.scope === undefined) return true;
  return path !== "" && PATH_SCOPED_RESOURCES.has(g.resource) && pathGlobMatch(g.scope, path);
}
