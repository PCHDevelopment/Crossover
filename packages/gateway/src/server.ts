import type { Pool } from "@crossover/db";
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
} from "@crossover/kernel";
import { CrossoverError, newId } from "@crossover/protocol";
import { z } from "zod";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { bearerToken } from "./bearer.js";
import {
  SESSION_COOKIE,
  SECURE_SESSION_COOKIE,
  STATE_COOKIE_PREFIX,
  SECURE_STATE_COOKIE_PREFIX,
  cookieValue,
  userToken,
  setCookie,
  clearCookie,
  requireSameOrigin,
} from "./cookies.js";
import { registerOAuthRoutes } from "./oauth-routes.js";
import { registerGitHubInstallRoutes } from "./github-install-routes.js";
import { toHttpError } from "./errors.js";
import type { OAuthProvider, OAuthStateStore } from "./oauth.js";
import { staticSite } from "./static.js";
import { attachWebSocket, type WebSocketOptions } from "./ws.js";
import type { RoomExportLimiter, RoomExportSource } from "./room-export.js";
import { registerRoomExportRoute } from "./room-export-route.js";
import type { GitHubInstallStateStore } from "./github-install.js";
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
  if (options.githubAppInstall && !options.oauth && options.devLogin !== true) {
    throw new Error("The GitHub App install flow needs browser sign-in (OAuth or dev-login)");
  }
  const { dispatcher, pool } = options;
  const secureCookies = options.secureCookies ?? false;
  const sessionCookieName = secureCookies ? SECURE_SESSION_COOKIE : SESSION_COOKIE;
  const stateCookiePrefix = secureCookies ? SECURE_STATE_COOKIE_PREFIX : STATE_COOKIE_PREFIX;
  // Development sign-in uses the same browser cookie even without configured OAuth providers.
  const cookieAuthEnabled = options.oauth !== undefined || options.devLogin === true;
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
    registerOAuthRoutes(app, {
      pool,
      oauth: options.oauth,
      oauthStartLimit: options.oauthStartLimit,
      secureCookies,
      sessionCookieName,
      stateCookiePrefix,
      clientKey,
    });
  }
  if (options.githubAppInstall) {
    registerGitHubInstallRoutes(app, {
      pool,
      githubAppInstall: options.githubAppInstall,
      secureCookies,
      sessionCookieName,
      cookieAuthEnabled,
      publicBaseUrl: options.oauth?.publicBaseUrl,
      humanUser,
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
      // A browser sends `Origin` and keeps its session in the cookie. Clients that send none (the
      // SDKs, scripts) authenticate with the token in the body.
      const browserSignIn = cookieAuthEnabled && Boolean(request.headers.origin);
      if (browserSignIn) requireSameOrigin(request, options.oauth?.publicBaseUrl);
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
        ...(browserSignIn ? {} : { session_token: session.session_token }),
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
