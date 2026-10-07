import { createHmac, timingSafeEqual } from "node:crypto";

const DOMAIN = "crossover-egress-proxy-v1";
const HEALTH_INSTALL_DOMAIN = "crossover-health-install-egress-proxy-v1";
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Create a stable, sandbox-scoped password for HTTP proxy basic authentication. */
export function createSandboxProxyCredential(sandboxId: string, secret: string): string {
  return createCredential(DOMAIN, sandboxId, secret);
}

/** Create a credential scoped to one temporary health dependency install run. */
export function createHealthInstallProxyCredential(installId: string, secret: string): string {
  return createCredential(HEALTH_INSTALL_DOMAIN, installId, secret);
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

function createCredential(domain: string, id: string, secret: string): string {
  return createHmac("sha256", secret).update(`${domain}\0${id}`).digest("base64url");
}
