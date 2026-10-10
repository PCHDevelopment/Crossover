import { matchesHostPattern, normalizeEgressHost } from "@crossover/security";

export { normalizeEgressHost, normalizeRoomEgressAllowlist } from "@crossover/security";

/** Registry and source-download domains needed by default sandbox workflows. */
export const DEFAULT_EGRESS_ALLOWLIST = [
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
  "crates.io",
  "index.crates.io",
  "static.crates.io",
  "proxy.golang.org",
  "sum.golang.org",
  "repo.maven.apache.org",
  "repo1.maven.org",
  "github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
] as const;

/** Match exact hosts or `*.suffix` room additions; wildcard entries exclude the suffix apex. */
export function isAllowedEgressHost(host: string, roomAllowlist: readonly string[] = []): boolean {
  const canonical = normalizeEgressHost(host);
  return (
    DEFAULT_EGRESS_ALLOWLIST.includes(canonical as (typeof DEFAULT_EGRESS_ALLOWLIST)[number]) ||
    matchesHostPattern(canonical, roomAllowlist)
  );
}

/** Match only a plugin's signed host scope; built-in sandbox hosts do not apply to plugins. */
export function isAllowedPluginEgressHost(host: string, pluginHosts: readonly string[]): boolean {
  return matchesHostPattern(normalizeEgressHost(host), pluginHosts);
}
