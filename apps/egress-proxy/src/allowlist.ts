import { isIP } from "node:net";

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

/** Validate room-provided `settings.egress_allowlist` entries. Invalid entries deny the request. */
export function normalizeRoomEgressAllowlist(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 100)
    throw new Error("room egress_allowlist must be an array of at most 100 host patterns");
  return value.map((entry) => {
    if (typeof entry !== "string") throw new Error("room egress_allowlist entries must be strings");
    return normalizeHostPattern(entry);
  });
}

/** Normalize a CONNECT destination hostname before matching or logging it. */
export function normalizeEgressHost(host: string): string {
  const canonical = normalizeHostPattern(host);
  if (canonical.startsWith("*.")) throw new Error("destination host must be a DNS hostname");
  return canonical;
}

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

function matchesHostPattern(host: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) =>
    pattern.startsWith("*.") ? host.endsWith(`.${pattern.slice(2)}`) : host === pattern,
  );
}

function normalizeHostPattern(input: string): string {
  const trimmed = input.trim().toLowerCase();
  const wildcard = trimmed.startsWith("*.");
  const source = (wildcard ? trimmed.slice(2) : trimmed).replace(/\.$/, "");
  if (!source || source.length > 253 || /[/:?#@\s\\]/.test(source) || isIP(source)) {
    throw new Error("egress allowlist entries must be DNS hostnames, optionally prefixed with *.");
  }
  let hostname: string;
  try {
    const url = new URL(`https://${source}`);
    if (url.port || url.username || url.password || url.pathname !== "/")
      throw new Error("invalid hostname");
    hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    throw new Error("egress allowlist entries must be valid DNS hostnames");
  }
  const labels = hostname.split(".");
  if (
    labels.length < 2 ||
    labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    throw new Error("egress allowlist entries must be fully qualified DNS hostnames");
  }
  return wildcard ? `*.${hostname}` : hostname;
}
