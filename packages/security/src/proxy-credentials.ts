import { createHmac, timingSafeEqual } from "node:crypto";
import { normalizeRoomEgressAllowlist } from "./egress-allowlist.js";

const DOMAIN = "crossover-egress-proxy-v1";
const HEALTH_INSTALL_DOMAIN = "crossover-health-install-egress-proxy-v1";
const PLUGIN_DOMAIN = "crossover-plugin-egress-proxy-v1";
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PLUGIN_TOKEN_MAX_BYTES = 8 * 1024;
const PLUGIN_TOKEN_MAX_TTL_MS = 5 * 60_000;

export interface PluginProxyClaims {
  invocationId: string;
  roomId: string;
  participantId: string;
  hosts: readonly string[];
  expiresAt: number;
}

/** Create a stable, sandbox-scoped password for HTTP proxy basic authentication. */
export function createSandboxProxyCredential(sandboxId: string, secret: string): string {
  return createCredential(DOMAIN, sandboxId, secret);
}

/** Create a credential scoped to one temporary health dependency install run. */
export function createHealthInstallProxyCredential(installId: string, secret: string): string {
  return createCredential(HEALTH_INSTALL_DOMAIN, installId, secret);
}

/** Create a short-lived proxy credential limited to one plugin invocation and its declared hosts. */
export function createPluginProxyCredential(claims: PluginProxyClaims, secret: string): string {
  if (!validPluginClaims(claims, Date.now(), true))
    throw new Error("Plugin proxy claims are invalid");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  if (Buffer.byteLength(payload) + 44 > PLUGIN_TOKEN_MAX_BYTES)
    throw new Error("Plugin proxy claims exceed the size limit");
  const signature = createHmac("sha256", secret)
    .update(`${PLUGIN_DOMAIN}\0${payload}`)
    .digest("base64url");
  return `${payload}.${signature}`;
}

/** Verify a credential without leaking signature comparisons through timing. */
export function verifySandboxProxyCredential(
  sandboxId: string,
  credential: string,
  secret: string,
): boolean {
  if (!SIGNATURE_PATTERN.test(credential)) return false;
  const expected = Buffer.from(createSandboxProxyCredential(sandboxId, secret), "base64url");
  const actual = Buffer.from(credential, "base64url");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Verify a temporary health install credential without a timing-sensitive comparison. */
export function verifyHealthInstallProxyCredential(
  installId: string,
  credential: string,
  secret: string,
): boolean {
  if (!SIGNATURE_PATTERN.test(credential)) return false;
  const expected = Buffer.from(createHealthInstallProxyCredential(installId, secret), "base64url");
  const actual = Buffer.from(credential, "base64url");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Verify a plugin token, including its expiry and bounded claims, without leaking comparisons. */
export function verifyPluginProxyCredential(
  credential: string,
  secret: string,
  nowMs = Date.now(),
): PluginProxyClaims | null {
  if (typeof credential !== "string" || credential.length > PLUGIN_TOKEN_MAX_BYTES) return null;
  const separator = credential.lastIndexOf(".");
  if (separator <= 0) return null;
  const payload = credential.slice(0, separator);
  const signature = credential.slice(separator + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(payload) || !SIGNATURE_PATTERN.test(signature)) return null;
  const expected = Buffer.from(
    createHmac("sha256", secret).update(`${PLUGIN_DOMAIN}\0${payload}`).digest("base64url"),
    "base64url",
  );
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  let decoded: unknown;
  try {
    const bytes = Buffer.from(payload, "base64url");
    if (bytes.toString("base64url") !== payload) return null;
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return null;
  }
  return validPluginClaims(decoded, nowMs, true) ? (decoded as PluginProxyClaims) : null;
}

function validPluginClaims(
  value: unknown,
  nowMs: number,
  checkExpiry: boolean,
): value is PluginProxyClaims {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (
    keys.length !== 5 ||
    keys.some(
      (key) =>
        key !== "invocationId" &&
        key !== "roomId" &&
        key !== "participantId" &&
        key !== "hosts" &&
        key !== "expiresAt",
    )
  ) {
    return false;
  }
  const claims = value as Partial<PluginProxyClaims>;
  if (!Array.isArray(claims.hosts)) return false;
  let canonicalHosts: string[];
  try {
    canonicalHosts = normalizeRoomEgressAllowlist(claims.hosts);
  } catch {
    return false;
  }
  if (
    canonicalHosts.length === 0 ||
    canonicalHosts.length !== claims.hosts.length ||
    canonicalHosts.some((host, index) => host !== claims.hosts![index])
  ) {
    return false;
  }
  const safeId = (id: unknown) =>
    typeof id === "string" && id.length > 0 && id.length <= 200 && /^[A-Za-z0-9_-]+$/.test(id);
  if (
    !safeId(claims.invocationId) ||
    !safeId(claims.roomId) ||
    !safeId(claims.participantId) ||
    !Number.isSafeInteger(claims.expiresAt)
  ) {
    return false;
  }
  return (
    !checkExpiry ||
    (claims.expiresAt! > nowMs && claims.expiresAt! <= nowMs + PLUGIN_TOKEN_MAX_TTL_MS)
  );
}

function createCredential(domain: string, id: string, secret: string): string {
  return createHmac("sha256", secret).update(`${domain}\0${id}`).digest("base64url");
}
