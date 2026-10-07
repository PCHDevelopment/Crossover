import { createHmac, timingSafeEqual } from "node:crypto";

const DOMAIN = "crossover-egress-proxy-v1";
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Create a stable, sandbox-scoped password for HTTP proxy basic authentication. */
export function createSandboxProxyCredential(sandboxId: string, secret: string): string {
  return createHmac("sha256", secret).update(`${DOMAIN}\0${sandboxId}`).digest("base64url");
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
