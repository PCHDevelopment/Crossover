import { createHmac, timingSafeEqual } from "node:crypto";

const DOMAIN = "crossover-sandbox-workspace-read-v1";
const TOKEN_PATTERN = /^([A-Za-z0-9_-]{1,2048})\.([A-Za-z0-9_-]{43})$/;
export const SANDBOX_READ_TOKEN_MAX_TTL_MS = 5 * 60 * 1000;

export interface SandboxReadTokenClaims {
  room_id: string;
  participant_id: string;
  sandbox_id: string;
  expires_at: number;
}

/** Mint a signed credential restricted to one participant sandbox and its room. */
export function createSandboxReadToken(
  claims: SandboxReadTokenClaims,
  secret: string,
  now = Date.now(),
): string {
  assertSecret(secret);
  assertClaims(claims, now);
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(`${DOMAIN}\0${payload}`)
    .digest("base64url");
  return `${payload}.${signature}`;
}

/** Verify a sandbox read credential without a timing-sensitive signature comparison. */
export function verifySandboxReadToken(
  token: string,
  secret: string,
  now = Date.now(),
): SandboxReadTokenClaims | null {
  if (Buffer.byteLength(secret) < 32 || typeof token !== "string") return null;
  const match = TOKEN_PATTERN.exec(token);
  if (!match) return null;
  const payload = match[1];
  const suppliedSignature = match[2];
  if (!payload || !suppliedSignature) return null;
  const expected = Buffer.from(
    createHmac("sha256", secret).update(`${DOMAIN}\0${payload}`).digest("base64url"),
    "base64url",
  );
  const actual = Buffer.from(suppliedSignature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
  } catch {
    return null;
  }
  if (!isClaims(decoded) || decoded.expires_at <= now) return null;
  return decoded;
}

function assertSecret(secret: string): void {
  if (typeof secret !== "string" || Buffer.byteLength(secret) < 32)
    throw new Error("Sandbox read token secret must be at least 32 bytes");
}

function assertClaims(value: SandboxReadTokenClaims, now: number): void {
  if (
    !isClaims(value) ||
    value.expires_at <= now ||
    value.expires_at > now + SANDBOX_READ_TOKEN_MAX_TTL_MS
  ) {
    throw new TypeError("Invalid sandbox read token claims");
  }
}

function isClaims(value: unknown): value is SandboxReadTokenClaims {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const claims = value as Record<string, unknown>;
  return (
    Object.keys(claims).length === 4 &&
    typeof claims.room_id === "string" &&
    claims.room_id.length > 0 &&
    claims.room_id.length <= 200 &&
    typeof claims.participant_id === "string" &&
    claims.participant_id.length > 0 &&
    claims.participant_id.length <= 200 &&
    typeof claims.sandbox_id === "string" &&
    claims.sandbox_id.length > 0 &&
    claims.sandbox_id.length <= 200 &&
    typeof claims.expires_at === "number" &&
    Number.isSafeInteger(claims.expires_at) &&
    claims.expires_at > 0
  );
}
