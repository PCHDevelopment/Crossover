// Moved from server.ts (T1568) without changing cookie behavior.
import type { FastifyRequest } from "fastify";
import { CrossoverError } from "@crossover/protocol";
import { bearerToken } from "./bearer.js";

export const SESSION_COOKIE = "crossover_session";
export const SECURE_SESSION_COOKIE = "__Host-crossover_session";
export const STATE_COOKIE_PREFIX = "crossover_oauth_state_";
export const SECURE_STATE_COOKIE_PREFIX = "__Host-crossover_oauth_state_";
export const GITHUB_INSTALL_STATE_COOKIE_PREFIX = "crossover_github_install_state_";
export const SECURE_GITHUB_INSTALL_STATE_COOKIE_PREFIX = "__Host-crossover_github_install_state_";
export const OAUTH_STATE = /^[A-Za-z0-9_-]{43}$/;

export function cookieValue(request: FastifyRequest, name: string): string | undefined {
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index >= 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

export function userToken(
  request: FastifyRequest,
  allowCookie: boolean,
  sessionCookieName: string,
): { token: string; cookie: boolean } {
  if (request.headers.authorization !== undefined)
    return { token: bearerToken(request), cookie: false };
  const token = allowCookie ? cookieValue(request, sessionCookieName) : undefined;
  return token ? { token, cookie: true } : { token: bearerToken(request), cookie: false };
}

export function setCookie(name: string, token: string, expiresAt: Date, secure: boolean): string {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  return `${name}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export function clearCookie(name: string, secure: boolean): string {
  return `${name}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export function requireSameOrigin(request: FastifyRequest, expectedOrigin?: string): void {
  const origin = request.headers.origin;
  const expected = expectedOrigin ?? `${request.protocol}://${request.hostname}`;
  const actual =
    typeof origin === "string" && URL.canParse(origin) ? new URL(origin).origin : undefined;
  if (actual !== new URL(expected).origin)
    throw new CrossoverError("FORBIDDEN", "Invalid request origin");
}

export function requireSameOriginNavigation(
  request: FastifyRequest,
  expectedOrigin?: string,
): void {
  if (request.headers.origin !== undefined) {
    requireSameOrigin(request, expectedOrigin);
    return;
  }
  if (request.headers["sec-fetch-site"] !== "same-origin")
    throw new CrossoverError("FORBIDDEN", "Invalid request origin");
}
