import { CrossoverError, type ErrorBody } from "@crossover/protocol";

export function errorFromBody(error: ErrorBody["error"]): CrossoverError {
  return new CrossoverError(error.code, error.message, {
    retryable: error.retryable,
    ...(error.details === undefined ? {} : { details: error.details }),
  });
}

export function validation(message: string, issues: unknown): CrossoverError {
  return new CrossoverError("VALIDATION", message, { details: { issues } });
}
