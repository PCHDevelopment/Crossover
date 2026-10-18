// Moved from server.ts (T1568) without changing route behavior.
import type { Pool } from "@crossover/db";
import { createHash, randomBytes } from "node:crypto";
import { createUserSession, findOrCreateUser, type ProviderIdentity } from "@crossover/kernel";
import { CrossoverError } from "@crossover/protocol";
import type { FastifyInstance } from "fastify";
import type { GatewayOptions } from "./server.js";
import { OAUTH_STATE_TTL_MS } from "./oauth.js";
import { OAUTH_STATE, cookieValue, clearCookie, setCookie } from "./cookies.js";

export function registerOAuthRoutes(
  app: FastifyInstance,
  deps: {
    pool: Pool;
    oauth: NonNullable<GatewayOptions["oauth"]>;
    oauthStartLimit: GatewayOptions["oauthStartLimit"];
    secureCookies: boolean;
    sessionCookieName: string;
    stateCookiePrefix: string;
    clientKey: (ip: string) => string;
  },
): void {
  const {
    pool,
    oauth,
    oauthStartLimit,
    secureCookies,
    sessionCookieName,
    stateCookiePrefix,
    clientKey,
  } = deps;
  const { publicBaseUrl, providers, stateStore } = oauth;
  const providerFor = (name: string) => Object.hasOwn(providers, name) && providers[name];
  for (const [name, provider] of Object.entries(providers)) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name) || provider.name !== name)
      throw new Error("OAuth providers must use their registered name");
  }
  app.get<{ Params: { provider: string } }>("/v1/auth/oauth/:provider", async (request, reply) => {
    const selected = providerFor(request.params.provider);
    if (!selected) throw new CrossoverError("NOT_FOUND", "OAuth provider not found");
    const limit = oauthStartLimit;
    if (limit) {
      const decision = await limit.limiter
        .hit(`oauth-start:${clientKey(request.ip)}`, limit.perMinute ?? 30, 60_000)
        .catch(() => ({ allowed: true as const }));
      if (!decision.allowed) {
        throw new CrossoverError("RATE_LIMITED", "Too many OAuth sign-in attempts", {
          details: { retry_after: Math.max(1, Math.ceil(decision.retry_after_ms / 1000)) },
        });
      }
    }
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    await stateStore.save(state, { provider: selected.name, verifier, nonce });
    const cookie = `${stateCookiePrefix}${state}=1; Path=/; Max-Age=${OAUTH_STATE_TTL_MS / 1000}; HttpOnly; SameSite=Lax${secureCookies ? "; Secure" : ""}`;
    const redirectUri = `${publicBaseUrl}/v1/auth/oauth/${selected.name}/callback`;
    return reply
      .header("Cache-Control", "no-store")
      .header("Referrer-Policy", "no-referrer")
      .header("Set-Cookie", cookie)
      .redirect(selected.authorizationUrl({ state, challenge, redirectUri, nonce }));
  });
  app.get<{
    Params: { provider: string };
    Querystring: { state?: string; code?: string; error?: string };
  }>("/v1/auth/oauth/:provider/callback", async (request, reply) => {
    const selected = providerFor(request.params.provider);
    const { state, code, error } = request.query;
    const failed = (clearState?: string) => {
      const destination = new URL("/", publicBaseUrl);
      destination.searchParams.set("auth", "failed");
      const response = reply
        .status(303)
        .header("Cache-Control", "no-store")
        .header("Referrer-Policy", "no-referrer");
      if (clearState) response.header("Set-Cookie", clearState);
      return response.header("Location", destination.toString()).send();
    };
    if (!selected || typeof state !== "string" || !OAUTH_STATE.test(state)) return failed();
    const stateCookie = `${stateCookiePrefix}${state}`;
    if (cookieValue(request, stateCookie) !== "1") return failed();
    const transaction = await stateStore.consume(state);
    const clearState = clearCookie(stateCookie, secureCookies);
    if (
      !transaction ||
      transaction.provider !== selected.name ||
      error ||
      typeof code !== "string" ||
      !code ||
      code.length > 2048
    ) {
      return failed(clearState);
    }
    let identity: ProviderIdentity;
    try {
      identity = await selected.identity({
        redirectUri: `${publicBaseUrl}/v1/auth/oauth/${selected.name}/callback`,
        code,
        verifier: transaction.verifier,
        ...(transaction.nonce === undefined ? {} : { nonce: transaction.nonce }),
      });
    } catch {
      return failed(clearState);
    }
    if (
      identity.provider !== selected.name ||
      !identity.subject ||
      identity.subject.length > 255 ||
      typeof identity.display_name !== "string" ||
      !identity.display_name.trim()
    ) {
      return failed(clearState);
    }
    const user = await findOrCreateUser(pool, identity);
    const session = await createUserSession(pool, user.id);
    const destination = new URL("/", publicBaseUrl);
    return reply
      .status(303)
      .header("Cache-Control", "no-store")
      .header("Referrer-Policy", "no-referrer")
      .header("Set-Cookie", [
        setCookie(sessionCookieName, session.session_token, session.expires_at, secureCookies),
        clearState,
      ])
      .header("Location", destination.toString())
      .send();
  });
}
