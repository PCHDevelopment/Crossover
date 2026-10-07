import type { Pool } from "@crossover/db";
import {
  authenticate,
  authenticateUser,
  createUserSession,
  exchangeRoomSession,
  findOrCreateUser,
  refresh,
  type Dispatcher,
} from "@crossover/kernel";
import { CrossoverError, newId } from "@crossover/protocol";
import { z } from "zod";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { toHttpError } from "./errors.js";
import { attachWebSocket, type WebSocketOptions } from "./ws.js";

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
  /** Serve `GET /v1/rooms/:roomId/ws` (T703). Off unless given. */
  ws?: Omit<WebSocketOptions, "dispatcher" | "pool">;
}

const refreshBody = z.strictObject({ refresh_token: z.string().min(1).max(200) });

const devLoginBody = z.strictObject({
  /** Stable per-person key; the same subject always signs in as the same user. */
  subject: z.string().trim().min(1).max(200),
  display_name: z.string().trim().min(1).max(100),
});

const BEARER = /^Bearer ([^\s]+)$/i;

/** The bearer token from the `Authorization` header, or `UNAUTHENTICATED`. */
function bearerToken(request: FastifyRequest): string {
  const header = request.headers.authorization;
  const match = header === undefined ? null : BEARER.exec(header);
  if (!match?.[1]) throw new CrossoverError("UNAUTHENTICATED", "Missing or invalid bearer token");
  return match[1];
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
  const app = Fastify({
    logger: false,
    bodyLimit: options.bodyLimit ?? 1024 * 1024,
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
  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).send(new CrossoverError("NOT_FOUND", "No such route").toErrorBody()),
  );

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

  app.post<{ Params: { roomId: string } }>("/v1/rooms/:roomId/session", async (request, reply) => {
    const user = await authenticateUser(pool, bearerToken(request));
    const session = await exchangeRoomSession(pool, user, request.params.roomId);
    void reply.header("Cache-Control", "no-store");
    return session;
  });

  app.post("/v1/auth/refresh", async (request, reply) => {
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
    const user = await authenticateUser(pool, bearerToken(request));
    const result = await dispatcher.dispatchRoomless(user, expectObject(request.body));
    void reply.header("Cache-Control", "no-store");
    return {
      response: result.response,
      events: result.events,
      replayed: result.replayed,
    };
  });

  if (options.devLogin === true) {
    app.post("/v1/auth/dev-login", async (request, reply) => {
      const parsed = devLoginBody.safeParse(expectObject(request.body));
      if (!parsed.success) {
        throw new CrossoverError("VALIDATION", "Invalid dev login", {
          details: { issues: parsed.error.issues },
        });
      }
      const user = await findOrCreateUser(pool, {
        provider: "dev",
        subject: parsed.data.subject,
        display_name: parsed.data.display_name,
      });
      const session = await createUserSession(pool, user.id);
      void reply.header("Cache-Control", "no-store");
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
