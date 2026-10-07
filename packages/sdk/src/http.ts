import { CrossoverError, type ErrorBody, type ErrorCode } from "@crossover/protocol";

export interface RetryOptions {
  /** Total tries for a request, the first included. Default 4. */
  attempts?: number;
  /** First wait, doubled each time and capped at `maxMs`. Default 200 ms. */
  baseMs?: number;
  /** Default 5000 ms. */
  maxMs?: number;
}

export type FetchLike = typeof fetch;

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

/** The server couldn't be reached, or answered with something that isn't the protocol. */
export class TransportError extends Error {
  readonly retryable: boolean;
  readonly status: number | undefined;
  constructor(message: string, options: { retryable: boolean; status?: number; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "TransportError";
    this.retryable = options.retryable;
    this.status = options.status;
  }
}

/** The error a §16.3 body describes. */
export function errorFromBody(body: unknown, status: number): CrossoverError | TransportError {
  const error = (body as Partial<ErrorBody> | null)?.error;
  if (error && typeof error.code === "string" && typeof error.message === "string") {
    return new CrossoverError(error.code as ErrorCode, error.message, {
      retryable: error.retryable === true,
      ...(error.details ? { details: error.details } : {}),
    });
  }
  return new TransportError(`Unexpected response (HTTP ${status})`, {
    retryable: status >= 500,
    status,
  });
}

/** Is this a refusal worth trying again? Rate limits and an overloaded or handing-over server are. */
const retryableStatus = (status: number) =>
  status === 429 || status === 502 || status === 503 || status === 504;

/**
 * POST JSON and parse the answer. The same body goes out on every try, so a mutating command's
 * idempotency key makes a retry safe: a lost response, a dropped connection, a 429 with
 * `Retry-After` or a 503 is retried, anything else is final. A §16.3 error body becomes a
 * `CrossoverError` (also on 202, `APPROVAL_REQUIRED`).
 */
export async function postJson(
  fetchImpl: FetchLike,
  url: string,
  token: string | undefined,
  body: unknown,
  retry: RetryOptions = {},
  signal?: AbortSignal,
): Promise<{ status: number; json: unknown }> {
  const attempts = retry.attempts ?? 4;
  const base = retry.baseMs ?? 200;
  const cap = retry.maxMs ?? 5_000;
  const payload = JSON.stringify(body);
  for (let attempt = 1; ; attempt++) {
    let res: Response | undefined;
    let failure: unknown;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: payload,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      failure = error;
    }
    if (res) {
      const text = await res.text();
      let json: unknown;
      try {
        json = text === "" ? null : JSON.parse(text);
      } catch {
        json = null;
      }
      const errored = !res.ok || (json as { error?: unknown } | null)?.error !== undefined;
      if (!errored) return { status: res.status, json };
      if (retryableStatus(res.status) && attempt < attempts) {
        const header = Number(res.headers.get("retry-after"));
        const asked = Number.isFinite(header) && header > 0 ? header * 1000 : undefined;
        // A server that says "come back in an hour" isn't waited for: the caller gets the error
        // (its details carry `retry_after`) and decides.
        if (asked !== undefined && asked > cap) throw errorFromBody(json, res.status);
        await sleep(asked ?? Math.min(cap, base * 2 ** (attempt - 1)), signal);
        continue;
      }
      throw errorFromBody(json, res.status);
    }
    if (attempt >= attempts) {
      throw new TransportError("Couldn't reach the server", { retryable: true, cause: failure });
    }
    await sleep(Math.min(cap, base * 2 ** (attempt - 1)), signal);
  }
}

export async function getJson(
  fetchImpl: FetchLike,
  url: string,
  token: string | undefined,
): Promise<unknown> {
  const res = await fetchImpl(url, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) throw errorFromBody(json, res.status);
  return json;
}
