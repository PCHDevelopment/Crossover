import type { Pool } from "@crossover/db";
import { authenticate, type Dispatcher } from "@crossover/kernel";
import { CrossoverError } from "@crossover/protocol";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { toHttpError } from "./errors.js";

export interface GatewayOptions {
  dispatcher: Dispatcher;
  pool: Pool;
  /** Called for errors that are bugs (anything that isn't a CrossoverError). */
  onInternalError?: (error: unknown, request: FastifyRequest) => void;
  /** Maximum request body, in bytes. Default 1 MiB. */
  bodyLimit?: number;
}

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
 * Responses carrying secrets (`one_time`, the join tokens) are `Cache-Control: no-store`.
 */
export function buildGateway(options: GatewayOptions): FastifyInstance {
  const { dispatcher, pool } = options;
  const app = Fastify({ logger: false, bodyLimit: options.bodyLimit ?? 1024 * 1024 });

  app.setErrorHandler((error, request, reply) => {
    const mapped = toHttpError(normalize(error));
    if (mapped.status === 500) options.onInternalError?.(error, request);
    if (mapped.status === 401) void reply.header("WWW-Authenticate", "Bearer");
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

  app.post<{ Params: { roomId: string } }>("/v1/rooms/:roomId/join", async (request, reply) => {
    const result = await dispatcher.dispatchAnonymous(
      "room.join",
      expectObject(request.body),
      request.params.roomId,
    );
    void reply.status(201).header("Cache-Control", "no-store");
    return { ...(result.response as object), tokens: result.one_time };
  });

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
