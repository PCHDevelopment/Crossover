import { CrossoverError, type ErrorBody, type ErrorCode } from "@crossover/protocol";

/**
 * HTTP status for each error code (ARCHITECTURE §16.3, BACKLOG T701). The spec fixes most of
 * them; the ones it leaves open are marked.
 */
export const HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION: 400,
  CONFLICT_VERSION: 409,
  CONFLICT_MERGE: 409,
  /** Accepted for later: the action is queued for a human (§22.2). */
  APPROVAL_REQUIRED: 202,
  /** Not in the spec: a frozen participant or room is denied, like a policy denial. */
  PARTICIPANT_PAUSED: 403,
  ROOM_PAUSED: 403,
  RATE_LIMITED: 429,
  BUDGET_EXCEEDED: 429,
  /** Not in the spec: the ChangeSet is held, which is a conflict with the current state. */
  CIRCUIT_BREAKER: 409,
  /** A transient service or workspace helper failure; the client may retry. */
  UNAVAILABLE: 503,
  /** Not in the spec: a plugin's provider is down; the caller may retry. */
  PROVIDER_UNAVAILABLE: 503,
  /** Internal; never sent as-is (see {@link toHttpError}). The caller may retry. */
  STALE_FENCE: 503,
};

export interface HttpError {
  status: number;
  body: ErrorBody;
}

/**
 * Map any thrown value to an HTTP status and the exact §16.3 error body. Unknown errors become
 * a generic 500 whose message never reveals the cause; `STALE_FENCE` (a writer lost its room
 * lease mid-request) becomes a retryable 503 for the same reason.
 */
export function toHttpError(error: unknown): HttpError {
  if (error instanceof CrossoverError) {
    if (error.code === "STALE_FENCE") {
      return {
        status: 503,
        body: {
          error: {
            code: error.code,
            message: "The room is changing hands; retry the request",
            retryable: true,
          },
        },
      };
    }
    return { status: HTTP_STATUS[error.code], body: error.toErrorBody() };
  }
  return {
    status: 500,
    body: {
      error: {
        // Not one of the public codes: nothing client-actionable to say about a bug.
        code: "INTERNAL" as ErrorCode,
        message: "Internal error",
        retryable: false,
      },
    },
  };
}
