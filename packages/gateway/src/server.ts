import type { Pool } from "@crossover/db";
import { createHash, randomBytes } from "node:crypto";
import {
  authenticate,
  authenticateUser,
  createUserSession,
  exchangeRoomSession,
  findOrCreateUser,
  listUserRooms,
  revokeUserSession,
  refresh,
  type Dispatcher,
  type ProviderIdentity,
} from "@crossover/kernel";
import { CrossoverError, newId } from "@crossover/protocol";
import { z } from "zod";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { bearerToken } from "./bearer.js";
import { toHttpError } from "./errors.js";
import { OAUTH_STATE_TTL_MS, type OAuthProvider, type OAuthStateStore } from "./oauth.js";
import { staticSite } from "./static.js";
import { attachWebSocket, type WebSocketOptions } from "./ws.js";
import type { RoomExportLimiter, RoomExportSource } from "./room-export.js";
import { registerRoomExportRoute } from "./room-export-route.js";
import { GITHUB_INSTALL_STATE_TTL_MS, type GitHubInstallStateStore } from "./github-install.js";
import type { GitHubPendingConnectionStore, GitHubPendingRepository } from "@crossover/kernel";

/** Counts hits per key in fixed windows (Redis in production). */
export interface RouteRateLimiter {
  hit(
    key: string,
    limit: number,
    windowMs: number,
  ): Promise<{ allowed: true } | { allowed: false; retry_after_ms: number }>;
}

export interface GatewayOptions {
  dispatcher: Dispatcher;
  pool: Pool;
  /** Called for errors that are bugs (anything that isn't a CrossoverError). */
  onInternalError?: (error: unknown, request: FastifyRequest) => void;
  /** Maximum request body, in bytes. Default 1 MiB. */
  bodyLimit?: number;
  /**
   * Serve `POST /v1/auth/dev-login`, which signs anyone in as any name with no credentials.
   * Off unless set: when off the route does not exist (404). For development only; OAuth
   * logins (later) plug into the same `users` table.
   */
  devLogin?: boolean;
  /** Use Secure and the __Host- session cookie name for browser sessions. */
  secureCookies?: boolean | undefined;
  /** Browser OAuth sign-in. Agent endpoints continue to require bearer tokens. */
  oauth?:
    | {
        publicBaseUrl: string;
        stateStore: OAuthStateStore;
        providers: Readonly<Record<string, OAuthProvider>>;
      }
    | undefined;
  /**
   * Take the client address from `X-Forwarded-For`, trusting only the proxies listed here (addresses
   * or CIDRs, e.g. `["10.0.0.0/8"]`): each hop is checked against the list from the server
   * outwards, so the address is the first entry that is not a listed proxy and nothing the client
   * wrote to the left of it counts. `true` trusts every hop and is for tests only. Default: none.
   */
  trustProxy?: boolean | string[];
  /**
   * Limit `POST /v1/auth/refresh` per client address (a stolen or guessed token can't be ground
   * through at wire speed): `perMinute` attempts (default 30) then `RATE_LIMITED` with
   * `Retry-After`. If the limiter fails, requests go ahead. Off unless given.
   */
  refreshLimit?: { limiter: RouteRateLimiter; perMinute?: number };
  /** Limit valid OAuth sign-in starts per client address. If the limiter fails, requests go ahead. */
  oauthStartLimit?: { limiter: RouteRateLimiter; perMinute?: number };
  /** GitHub App installation flow; absent when the App is not configured. */
  githubAppInstall?: {
    slug: string;
    stateStore: GitHubInstallStateStore;
    pendingConnections: GitHubPendingConnectionStore;
    authorizeInstallation: (input: {
      installation_id: number;
      code: string;
    }) => Promise<readonly GitHubPendingRepository[]>;
  };
  /** Optional streamed archive endpoint for room owners and admins. */
  roomExport?: { source: RoomExportSource; limiter: RoomExportLimiter };
  /**
   * Serve the built web app from this directory (`index.html` and its assets, the app's routes
   * falling back to `index.html`) next to the API. Off unless given; never serves anything under
   * `/v1/`.
   */
  staticRoot?: string;
  /** Serve `GET /v1/rooms/:roomId/ws` (T703). Off unless given. */
  ws?: Omit<WebSocketOptions, "dispatcher" | "pool">;
}

const refreshBody = z.strictObject({ refresh_token: z.string().min(1).max(200) });

const devLoginBody = z.strictObject({
  /** Stable per-person key; the same subject always signs in as the same user. */
  subject: z.string().trim().min(1).max(200),
  display_name: z.string().trim().min(1).max(100),
});

const SESSION_COOKIE = "crossover_session";
const SECURE_SESSION_COOKIE = "__Host-crossover_session";
const STATE_COOKIE_PREFIX = "crossover_oauth_state_";
const SECURE_STATE_COOKIE_PREFIX = "__Host-crossover_oauth_state_";
const OAUTH_STATE = /^[A-Za-z0-9_-]{43}$/;

function cookieValue(request: FastifyRequest, name: string): string | undefined {
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index >= 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

function userToken(
  request: FastifyRequest,
  allowCookie: boolean,
  sessionCookieName: string,
): { token: string; cookie: boolean } {
  if (request.headers.authorization !== undefined)
    return { token: bearerToken(request), cookie: false };
  const token = allowCookie ? cookieValue(request, sessionCookieName) : undefined;
  return token ? { token, cookie: true } : { token: bearerToken(request), cookie: false };
}

function setCookie(name: string, token: string, expiresAt: Date, secure: boolean): string {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  return `${name}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

function clearCookie(name: string, secure: boolean): string {
  return `${name}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

function requireSameOrigin(request: FastifyRequest, expectedOrigin?: string): void {
  const origin = request.headers.origin;
  const expected = expectedOrigin ?? `${request.protocol}://${request.hostname}`;
  const actual =
    typeof origin === "string" && URL.canParse(origin) ? new URL(origin).origin : undefined;
  if (actual !== new URL(expected).origin)
    throw new CrossoverError("FORBIDDEN", "Invalid request origin");
}

function requireSameOriginNavigation(request: FastifyRequest, expectedOrigin?: string): void {
  if (request.headers.origin !== undefined) {
    requireSameOrigin(request, expectedOrigin);
    return;
  }
  if (request.headers["sec-fetch-site"] !== "same-origin")
    throw new CrossoverError("FORBIDDEN", "Invalid request origin");
}

async function githubOwnerForUser(
  pool: Pool,
  roomId: string,
  userId: string,
  expectedParticipantId?: string,
): Promise<string | undefined> {
  const { rows } = await pool.query<{ participant_id: string }>(
    `SELECT p.id AS participant_id
     FROM participants p
     WHERE p.room_id = $1 AND p.user_id = $2 AND p.kind = 'HUMAN'
       AND p.authority = 'OWNER' AND p.status = 'ACTIVE'
       AND ($3::text IS NULL OR p.id = $3)`,
    [roomId, userId, expectedParticipantId ?? null],
  );
  return rows[0]?.participant_id;
}

function expectObject(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new CrossoverError("VALIDATION", "Request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

/**
 * The REST gateway (T701). A thin HTTP shell over the dispatcher: it authenticates the bearer
 * token, checks the room in the path, hands the command to the kernel and maps errors to the
 * §16.3 body and an HTTP status.
 *
 * - `POST /v1/rooms/:roomId/commands`: body is the command envelope; bearer token required.
 * - `POST /v1/rooms/:roomId/join`: body `{ token, manifest }`; the invite token is the
 *   credential, so there is no bearer header.
 *
 * - `GET /v1/rooms/:roomId/events?after&limit&types`: the room's events in order (`room.events.list`;
 *   `types` is comma-separated). `GET /v1/rooms/:roomId/state?view`: `room.get_state`. Both need
 *   the bearer token of a member of that room, and run through the dispatcher like any read.
 * - `POST /v1/commands`: a roomless command (`room.create`); bearer is a user session token
 *   (`us_…`), not a room token. The creating user becomes the new room's owner.
 * - `POST /v1/rooms/:roomId/session`: a user session (`us_…`) for room tokens, if the user is an
 *   active human member of the room.
 * - `POST /v1/auth/refresh`: body `{ refresh_token }`; the refresh token is the credential, so
 *   there is no bearer header. Spends it and returns a new access and refresh token (the same
 *   shape as the join's `tokens`); a spent token presented again revokes its whole family.
 * - `POST /v1/auth/dev-login`: only when `devLogin` is on. Body `{ subject, display_name }`;
 *   returns a user session.
 *
 * Responses carrying secrets (`one_time`, the join tokens) are `Cache-Control: no-store`.
 */
export function buildGateway(options: GatewayOptions): FastifyInstance {
  const { dispatcher, pool } = options;
  const secureCookies = options.secureCookies ?? false;
  const sessionCookieName = secureCookies ? SECURE_SESSION_COOKIE : SESSION_COOKIE;
  const stateCookiePrefix = secureCookies ? SECURE_STATE_COOKIE_PREFIX : STATE_COOKIE_PREFIX;
  // Development sign-in uses the same browser cookie even without configured OAuth providers.
  const cookieAuthEnabled =
    options.oauth !== undefined ||
    options.devLogin === true ||
    options.githubAppInstall !== undefined;
  const app = Fastify({
    logger: false,
    bodyLimit: options.bodyLimit ?? 1024 * 1024,
    trustProxy: options.trustProxy ?? false,
  });

  app.setErrorHandler((error, request, reply) => {
    const mapped = toHttpError(normalize(error));
    if (mapped.status === 500) options.onInternalError?.(error, request);
    if (mapped.status === 401) void reply.header("WWW-Authenticate", "Bearer");
    const retryAfter = mapped.body.error.details?.["retry_after"];
    if (mapped.status === 429 && typeof retryAfter === "number") {
      void reply.header("Retry-After", String(retryAfter));
    }
    return reply.status(mapped.status).header("Cache-Control", "no-store").send(mapped.body);
  });
  async function humanUser(request: FastifyRequest, mutation = false) {
    const auth = userToken(request, cookieAuthEnabled, sessionCookieName);
    if (auth.cookie && mutation) requireSameOrigin(request, options.oauth?.publicBaseUrl);
    return { principal: await authenticateUser(pool, auth.token), ...auth };
  }

  app.get("/v1/auth/providers", async (_request, reply) => {
    void reply.header("Cache-Control", "no-store");
    return { providers: Object.keys(options.oauth?.providers ?? {}) };
  });

  app.get("/v1/auth/session", async (request, reply) => {
    void reply.header("Cache-Control", "no-store");
    const token = cookieAuthEnabled ? cookieValue(request, sessionCookieName) : undefined;
    if (!token) return { authenticated: false };
    try {
      await authenticateUser(pool, token);
      return { authenticated: true };
    } catch (error) {
      if (error instanceof CrossoverError && error.code === "UNAUTHENTICATED")
        return { authenticated: false };
      throw error;
    }
  });

  if (options.oauth) {
    const { publicBaseUrl, providers, stateStore } = options.oauth;
    const providerFor = (name: string) => Object.hasOwn(providers, name) && providers[name];
    for (const [name, provider] of Object.entries(providers)) {
      if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name) || provider.name !== name)
        throw new Error("OAuth providers must use their registered name");
    }
    app.get<{ Params: { provider: string } }>(
      "/v1/auth/oauth/:provider",
      async (request, reply) => {
        const selected = providerFor(request.params.provider);
        if (!selected) throw new CrossoverError("NOT_FOUND", "OAuth provider not found");
        const limit = options.oauthStartLimit;
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
      },
    );
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

  if (options.githubAppInstall) {
    const install = options.githubAppInstall;
    const installStateCookiePrefix = secureCookies
      ? "__Host-crossover_github_install_state_"
      : "crossover_github_install_state_";
    const installCallbackPath = "/v1/auth/github-app/callback";
    const failedLocation = "/?github_install=failed";
    const clearInstallStateCookie = (state: string) =>
      clearCookie(`${installStateCookiePrefix}${state}`, secureCookies);

    app.get<{ Params: { roomId: string } }>(
      "/v1/rooms/:roomId/integrations/github/install",
      async (request, reply) => {
        const auth = userToken(request, cookieAuthEnabled, sessionCookieName);
        if (auth.cookie) requireSameOriginNavigation(request, options.oauth?.publicBaseUrl);
        const principal = await authenticateUser(pool, auth.token);
        const ownerParticipantId = await githubOwnerForUser(
          pool,
          request.params.roomId,
          principal.user_id,
        );
        if (!ownerParticipantId)
          throw new CrossoverError("FORBIDDEN", "Only the room owner can manage integrations", {
            details: { reason: "owner_only" },
          });

        const state = randomBytes(32).toString("base64url");
        await install.stateStore.saveState(state, {
          room_id: request.params.roomId,
          owner_participant_id: ownerParticipantId,
        });
        const destination = new URL(
          `https://github.com/apps/${encodeURIComponent(install.slug)}/installations/new`,
        );
        destination.searchParams.set("state", state);
        const cookie = `${installStateCookiePrefix}${state}=1; Path=/; Max-Age=${GITHUB_INSTALL_STATE_TTL_MS / 1000}; HttpOnly; SameSite=Lax${secureCookies ? "; Secure" : ""}`;
        return reply
          .header("Cache-Control", "no-store")
          .header("Referrer-Policy", "no-referrer")
          .header("Set-Cookie", cookie)
          .redirect(destination.toString());
      },
    );

    app.get<{
      Params: { roomId: string };
      Querystring: { pending_id?: string };
    }>("/v1/rooms/:roomId/integrations/github/pending", async (request, reply) => {
      const auth = userToken(request, cookieAuthEnabled, sessionCookieName);
      if (auth.cookie) requireSameOriginNavigation(request, options.oauth?.publicBaseUrl);
      const principal = await authenticateUser(pool, auth.token);
      const ownerParticipantId = await githubOwnerForUser(
        pool,
        request.params.roomId,
        principal.user_id,
      );
      if (!ownerParticipantId)
        throw new CrossoverError("FORBIDDEN", "Only the room owner can manage integrations", {
          details: { reason: "owner_only" },
        });
      const pendingId = request.query.pending_id;
      if (typeof pendingId !== "string" || !OAUTH_STATE.test(pendingId)) {
        throw new CrossoverError("VALIDATION", "Invalid GitHub pending connection");
      }
      let pending: Awaited<ReturnType<typeof install.pendingConnections.peek>>;
      try {
        pending = await install.pendingConnections.peek(pendingId, {
          room_id: request.params.roomId,
          owner_participant_id: ownerParticipantId,
        });
      } catch {
        throw new CrossoverError("PROVIDER_UNAVAILABLE", "GitHub integration is unavailable");
      }
      if (!pending) throw new CrossoverError("NOT_FOUND", "GitHub pending connection not found");
      return reply
        .header("Cache-Control", "no-store")
        .header("Referrer-Policy", "no-referrer")
        .send({ repositories: pending.repositories.map(({ name }) => ({ name })) });
    });

    app.get<{
      Querystring: { state?: string; code?: string; installation_id?: string; error?: string };
    }>(installCallbackPath, async (request, reply) => {
      const { state, code, installation_id: installationId, error } = request.query;
      const failed = (clearState?: string) => {
        const response = reply
          .status(303)
          .header("Cache-Control", "no-store")
          .header("Referrer-Policy", "no-referrer");
        if (clearState) response.header("Set-Cookie", clearState);
        return response.header("Location", failedLocation).send();
      };
      if (
        typeof state !== "string" ||
        !OAUTH_STATE.test(state) ||
        cookieValue(request, `${installStateCookiePrefix}${state}`) !== "1"
      ) {
        return failed();
      }
      let transaction: { room_id: string; owner_participant_id: string } | undefined;
      try {
        transaction = await install.stateStore.consumeState(state);
      } catch {
        return failed(clearInstallStateCookie(state));
      }
      const clearState = clearInstallStateCookie(state);
      if (
        !transaction ||
        error !== undefined ||
        typeof code !== "string" ||
        !code ||
        code.length > 2048 ||
        typeof installationId !== "string" ||
        !/^[1-9]\d{0,15}$/.test(installationId) ||
        !Number.isSafeInteger(Number(installationId))
      ) {
        return failed(clearState);
      }

      try {
        const { principal } = await humanUser(request);
        const ownerParticipantId = await githubOwnerForUser(
          pool,
          transaction.room_id,
          principal.user_id,
          transaction.owner_participant_id,
        );
        if (!ownerParticipantId) return failed(clearState);
        const repositories = await install.authorizeInstallation({
          installation_id: Number(installationId),
          code,
        });
        if (!repositories.length) return failed(clearState);
        const pendingId = randomBytes(32).toString("base64url");
        await install.pendingConnections.save(pendingId, {
          room_id: transaction.room_id,
          owner_participant_id: ownerParticipantId,
          installation_id: installationId,
          repositories,
          expires_at: new Date(Date.now() + GITHUB_INSTALL_STATE_TTL_MS).toISOString(),
        });
        const destination = `/rooms/${encodeURIComponent(transaction.room_id)}#github_pending=${pendingId}`;
        return reply
          .status(303)
          .header("Cache-Control", "no-store")
          .header("Referrer-Policy", "no-referrer")
          .header("Set-Cookie", clearState)
          .header("Location", destination)
          .send();
      } catch {
        return failed(clearState);
      }
    });
  }
  const web = options.staticRoot ? staticSite(options.staticRoot) : undefined;
  app.setNotFoundHandler(async (request, reply) => {
    const file = request.method === "GET" ? await web?.(request.url) : undefined;
    if (file) {
      return reply
        .status(200)
        .header("Content-Type", file.type)
        .header(
          "Cache-Control",
          file.immutable ? "public, max-age=31536000, immutable" : "no-cache",
        )
        .header("X-Content-Type-Options", "nosniff")
        .header("Referrer-Policy", "no-referrer")
        .header(
          "Content-Security-Policy",
          "default-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
        )
        .send(file.body);
    }
    return reply.status(404).send(new CrossoverError("NOT_FOUND", "No such route").toErrorBody());
  });

  app.get("/health", async (_request, reply) => {
    await pool.query("SELECT 1");
    return reply.status(200).send({ status: "ok" });
  });

  app.post<{ Params: { roomId: string } }>("/v1/rooms/:roomId/commands", async (request, reply) => {
    const principal = await authenticate(pool, bearerToken(request));
    // A token is for one room. Anything else looks the same as a room that doesn't exist.
    if (principal.room_id !== request.params.roomId) {
      throw new CrossoverError("NOT_FOUND", "Room not found");
    }
    const result = await dispatcher.dispatch(principal, expectObject(request.body));
    void reply.header("Cache-Control", "no-store");
    return {
      response: result.response,
      events: result.events,
      replayed: result.replayed,
      ...(result.one_time === undefined ? {} : { one_time: result.one_time }),
    };
  });

  /** Run a read command for the bearer's room, with query-string values turned into params. */
  async function read(
    request: FastifyRequest<{ Params: { roomId: string } }>,
    reply: FastifyReply,
    method: string,
    params: Record<string, unknown>,
  ) {
    const principal = await authenticate(pool, bearerToken(request));
    if (principal.room_id !== request.params.roomId) {
      throw new CrossoverError("NOT_FOUND", "Room not found");
    }
    const result = await dispatcher.dispatch(principal, { id: newId("cmd"), method, params });
    void reply.header("Cache-Control", "no-store");
    return result.response;
  }

  /** A query value as a number if it looks like one; otherwise left for the schema to reject. */
  const num = (v: unknown): unknown => (typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : v);
  const compact = (o: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

  app.get<{ Params: { roomId: string }; Querystring: Record<string, string | string[]> }>(
    "/v1/rooms/:roomId/events",
    (request, reply) => {
      const q = request.query;
      const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
      const types = one(q.types);
      return read(
        request,
        reply,
        "room.events.list",
        compact({
          after: num(one(q.after)),
          limit: num(one(q.limit)),
          types: types === undefined ? undefined : types.split(",").map((t) => t.trim()),
        }),
      );
    },
  );

  if (options.roomExport) {
    registerRoomExportRoute(app, { pool, dispatcher, roomExport: options.roomExport });
  }

  app.get<{ Params: { roomId: string }; Querystring: Record<string, string | string[]> }>(
    "/v1/rooms/:roomId/state",
    (request, reply) => {
      const view = request.query.view;
      return read(
        request,
        reply,
        "room.get_state",
        compact({ view: Array.isArray(view) ? view[0] : view }),
      );
    },
  );

  app.post<{ Params: { roomId: string } }>("/v1/rooms/:roomId/join", async (request, reply) => {
    const result = await dispatcher.dispatchAnonymous(
      "room.join",
      expectObject(request.body),
      request.params.roomId,
    );
    void reply.status(201).header("Cache-Control", "no-store");
    return { ...(result.response as object), tokens: result.one_time };
  });

  app.get("/v1/rooms", async (request, reply) => {
    const { principal } = await humanUser(request);
    void reply.header("Cache-Control", "no-store");
    return { rooms: await listUserRooms(pool, principal) };
  });

  app.post<{ Params: { roomId: string } }>("/v1/rooms/:roomId/session", async (request, reply) => {
    const { principal } = await humanUser(request, true);
    const session = await exchangeRoomSession(pool, principal, request.params.roomId);
    void reply.header("Cache-Control", "no-store");
    return session;
  });

  app.post("/v1/auth/refresh", async (request, reply) => {
    const limit = options.refreshLimit;
    if (limit) {
      const decision = await limit.limiter
        .hit(`refresh:${clientKey(request.ip)}`, limit.perMinute ?? 30, 60_000)
        .catch(() => ({ allowed: true as const }));
      if (!decision.allowed) {
        throw new CrossoverError("RATE_LIMITED", "Too many refresh attempts", {
          details: { retry_after: Math.max(1, Math.ceil(decision.retry_after_ms / 1000)) },
        });
      }
    }
    const parsed = refreshBody.safeParse(expectObject(request.body));
    if (!parsed.success) {
      throw new CrossoverError("VALIDATION", "Invalid refresh request", {
        details: { issues: parsed.error.issues },
      });
    }
    const pair = await refresh(pool, parsed.data.refresh_token);
    void reply.header("Cache-Control", "no-store");
    return pair;
  });

  app.post("/v1/commands", async (request, reply) => {
    const { principal } = await humanUser(request, true);
    const result = await dispatcher.dispatchRoomless(principal, expectObject(request.body));
    void reply.header("Cache-Control", "no-store");
    return {
      response: result.response,
      events: result.events,
      replayed: result.replayed,
    };
  });

  if (cookieAuthEnabled) {
    app.post("/v1/auth/logout", async (request, reply) => {
      requireSameOrigin(request, options.oauth?.publicBaseUrl);
      const token = cookieValue(request, sessionCookieName);
      if (token) await revokeUserSession(pool, token);
      void reply.header("Cache-Control", "no-store");
      void reply.header("Set-Cookie", clearCookie(sessionCookieName, secureCookies));
      return { ok: true };
    });
  }

  if (options.devLogin === true) {
    app.post("/v1/auth/dev-login", async (request, reply) => {
      const parsed = devLoginBody.safeParse(expectObject(request.body));
      if (!parsed.success) {
        throw new CrossoverError("VALIDATION", "Invalid dev login", {
          details: { issues: parsed.error.issues },
        });
      }
      if (cookieAuthEnabled && request.headers.origin)
        requireSameOrigin(request, options.oauth?.publicBaseUrl);
      const user = await findOrCreateUser(pool, {
        provider: "dev",
        subject: parsed.data.subject,
        display_name: parsed.data.display_name,
      });
      const session = await createUserSession(pool, user.id);
      void reply.header("Cache-Control", "no-store");
      if (cookieAuthEnabled) {
        void reply.header(
          "Set-Cookie",
          setCookie(sessionCookieName, session.session_token, session.expires_at, secureCookies),
        );
      }
      return {
        user: { id: user.id, display_name: user.display_name },
        session_token: session.session_token,
        expires_at: session.expires_at.toISOString(),
      };
    });
  }

  if (options.ws) attachWebSocket(app, { ...options.ws, dispatcher, pool });

  return app;
}

/** Turn Fastify's own request errors (bad JSON, wrong content type, oversize body) into ours. */
function normalize(error: unknown): unknown {
  if (error instanceof CrossoverError) return error;
  const e = error as { statusCode?: number; code?: string; message?: string };
  if (typeof e.statusCode === "number" && e.statusCode >= 400 && e.statusCode < 500) {
    return new CrossoverError("VALIDATION", e.message ?? "Malformed request", {
      details: { reason: e.code ?? "bad_request" },
    });
  }
  return error;
}

/**
 * The key a client address is limited under: an IPv6 address by its /64 (one subscriber holds a
 * whole /64, so a per-address limit would be no limit), an IPv4 address as it is.
 */
export function clientKey(ip: string): string {
  const v4mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (v4mapped) return v4mapped[1]!;
  if (!ip.includes(":")) return ip;
  const [head = "", tail = ""] = ip.toLowerCase().split("::");
  const front = head === "" ? [] : head.split(":");
  const back = tail === "" ? [] : tail.split(":");
  const groups = ip.includes("::")
    ? [...front, ...Array<string>(Math.max(0, 8 - front.length - back.length)).fill("0"), ...back]
    : front;
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}
