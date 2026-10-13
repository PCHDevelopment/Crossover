import { CrossoverError } from "@crossover/protocol";
import type { FastifyRequest } from "fastify";

const BEARER = /^Bearer ([^\s]+)$/i;

/** The bearer token from the `Authorization` header, or `UNAUTHENTICATED`. */
export function bearerToken(request: FastifyRequest): string {
  const header = request.headers.authorization;
  const match = header === undefined ? null : BEARER.exec(header);
  if (!match?.[1]) throw new CrossoverError("UNAUTHENTICATED", "Missing or invalid bearer token");
  return match[1];
}
