import type { Pool, PoolClient } from "@crossover/db";
import { canonicalJson, CrossoverError, sha256Hex } from "@crossover/protocol";

/** How long an idempotency key is remembered (§16.2). */
export const IDEMPOTENCY_TTL_HOURS = 24;

const MAX_KEY_LENGTH = 128;

/** Stable hash of a request (e.g. `{ method, params }`) for use as `requestHash`. */
export function hashRequest(request: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(request))}`;
}

/**
 * Run `fn` at most once per `(participantId, key)` (§16.2). `fn` receives `client`; do its
 * writes through it so they share the transaction (and the savepoint below). Must run inside the caller's
 * transaction (`client`): the key is claimed with an upsert, so concurrent duplicates wait
 * on the first request's commit and then get its stored response instead of running `fn`.
 *
 * - First call: runs `fn`, stores its response with the key, returns it.
 * - Duplicate (same key and `requestHash`) within 24 h: returns the stored response and
 *   does not run `fn`.
 * - Same key with a different `requestHash`: throws `VALIDATION`.
 * - If `fn` throws (or its result isn't JSON), `fn`'s writes and the key claim are rolled
 *   back to a savepoint, the error propagates, and a retry runs `fn` again.
 *
 * The response is stored as canonical JSON (plain data only: `Date`, `undefined`, functions and the like are
 * rejected) and the value returned is the stored form on every call. If the caller's
 * transaction rolls back, nothing is remembered.
 */
export async function withIdempotency<T>(
  client: PoolClient,
  participantId: string,
  key: string,
  requestHash: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (participantId === "" || requestHash === "") {
    throw new CrossoverError("VALIDATION", "participantId and requestHash must not be empty");
  }
  if (key.length < 1 || key.length > MAX_KEY_LENGTH) {
    throw new CrossoverError(
      "VALIDATION",
      `idempotency_key must be 1–${MAX_KEY_LENGTH} characters`,
    );
  }

  await client.query("SAVEPOINT idempotency");
  try {
    // Claim the key. A returned row means we own it: it was free, or its previous owner's
    // 24 h window had passed. No row means a live entry exists (the INSERT waited for any
    // uncommitted owner to commit or roll back first).
    const claim = await client.query(
      `INSERT INTO idempotency_keys (participant_id, idempotency_key, request_hash, created_at)
       VALUES ($1, $2, $3, clock_timestamp())
       ON CONFLICT (participant_id, idempotency_key) DO UPDATE
         SET request_hash = EXCLUDED.request_hash, response = NULL, created_at = EXCLUDED.created_at
         WHERE idempotency_keys.created_at < clock_timestamp() - make_interval(hours => $4)
       RETURNING 1`,
      [participantId, key, requestHash, IDEMPOTENCY_TTL_HOURS],
    );

    if (claim.rowCount === 0) {
      // `pending` is SQL NULL (claimed, no response yet); a stored JSON `null` is a real response.
      const { rows } = await client.query<{
        request_hash: string;
        response: unknown;
        pending: boolean;
      }>(
        `SELECT request_hash, response, response IS NULL AS pending
           FROM idempotency_keys WHERE participant_id = $1 AND idempotency_key = $2`,
        [participantId, key],
      );
      const existing = rows[0];
      if (!existing) {
        // Deleted between the upsert and the select (a purge); safest is to ask for a retry.
        throw new CrossoverError("CONFLICT_VERSION", "Idempotency key changed concurrently; retry");
      }
      if (existing.request_hash !== requestHash) {
        throw new CrossoverError(
          "VALIDATION",
          "Idempotency key was already used with a different request",
          { details: { idempotency_key: key } },
        );
      }
      if (existing.pending) {
        // A committed row always has a response, and other transactions can't see our
        // uncommitted claim (their INSERT waits on it instead). So this is only reachable
        // when this same transaction already claimed the key, i.e. a nested call.
        throw new CrossoverError(
          "VALIDATION",
          "A request with this idempotency key is already in progress",
          {
            details: { idempotency_key: key },
          },
        );
      }
      await client.query("RELEASE SAVEPOINT idempotency");
      return existing.response as T;
    }

    const result = await fn(client);
    const response = canonicalJson(result); // throws for undefined, functions, non-finite numbers, ...
    await client.query(
      "UPDATE idempotency_keys SET response = $3::jsonb WHERE participant_id = $1 AND idempotency_key = $2",
      [participantId, key, response],
    );
    await client.query("RELEASE SAVEPOINT idempotency");
    return JSON.parse(response) as T;
  } catch (err) {
    try {
      await client.query("ROLLBACK TO SAVEPOINT idempotency");
      await client.query("RELEASE SAVEPOINT idempotency");
    } catch {
      // The connection is unusable (withTransaction will discard it); the caller needs the
      // original error, not this one.
    }
    throw err;
  }
}

/**
 * Delete idempotency keys older than 24 hours (§16.2). Returns the number removed.
 * Expired keys are also ignored by {@link withIdempotency}, so purging is housekeeping.
 */
export async function purgeIdempotencyKeys(db: Pool | PoolClient): Promise<number> {
  const { rowCount } = await db.query(
    "DELETE FROM idempotency_keys WHERE created_at < clock_timestamp() - make_interval(hours => $1)",
    [IDEMPOTENCY_TTL_HOURS],
  );
  return rowCount ?? 0;
}
