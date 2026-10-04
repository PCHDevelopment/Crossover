/** Error codes from ARCHITECTURE §16.3, plus internal-only codes (T114). */
export const PUBLIC_ERROR_CODES = [
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "VALIDATION",
  "CONFLICT_VERSION",
  "CONFLICT_MERGE",
  "APPROVAL_REQUIRED",
  "PARTICIPANT_PAUSED",
  "ROOM_PAUSED",
  "RATE_LIMITED",
  "BUDGET_EXCEEDED",
  "CIRCUIT_BREAKER",
] as const;

/** Codes that never cross the API boundary as-is; the gateway maps them. */
export const INTERNAL_ERROR_CODES = [
  /** A writer's fencing token no longer matches the room lease (§19). */
  "STALE_FENCE",
] as const;

export const ERROR_CODES = [...PUBLIC_ERROR_CODES, ...INTERNAL_ERROR_CODES] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Whether a client may retry the same request unchanged and expect a different outcome. */
export const DEFAULT_RETRYABLE: Readonly<Record<ErrorCode, boolean>> = {
  UNAUTHENTICATED: false,
  FORBIDDEN: false,
  NOT_FOUND: false,
  VALIDATION: false,
  CONFLICT_VERSION: true,
  CONFLICT_MERGE: false,
  APPROVAL_REQUIRED: false,
  PARTICIPANT_PAUSED: false,
  ROOM_PAUSED: false,
  RATE_LIMITED: true,
  BUDGET_EXCEEDED: true,
  CIRCUIT_BREAKER: false,
  STALE_FENCE: false,
};

/** JSON error body (ARCHITECTURE §16.3). */
export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
}

export interface CrossoverErrorOptions {
  retryable?: boolean;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class CrossoverError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, options: CrossoverErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CrossoverError";
    this.code = code;
    this.retryable = options.retryable ?? DEFAULT_RETRYABLE[code];
    this.details = options.details;
  }

  /** Serialize to the §16.3 shape; `details` is omitted when absent. */
  toErrorBody(): ErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

export function toErrorBody(error: CrossoverError): ErrorBody {
  return error.toErrorBody();
}

export function isCrossoverError(value: unknown): value is CrossoverError {
  return value instanceof CrossoverError;
}
