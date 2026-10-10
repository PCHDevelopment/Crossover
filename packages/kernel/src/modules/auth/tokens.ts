import { randomBytes, createHash } from "node:crypto";
import { withTransaction, type Pool, type PoolClient } from "@crossover/db";
import { CrossoverError } from "@crossover/protocol";

export const ACCESS_TOKEN_PREFIX = "at_";
export const REFRESH_TOKEN_PREFIX = "rt_";
export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface TokenPair {
  /** `at_…`, valid for 1 hour. Shown once; only its hash is stored. */
  access_token: string;
  /** `rt_…`, valid for 30 days, single use. Shown once; only its hash is stored. */
  refresh_token: string;
  access_expires_at: Date;
  refresh_expires_at: Date;
  /** All tokens from one login (and its refreshes) share a family. */
  family_id: string;
}

export interface TokenOptions {
  /** Override the lifetimes (tests, or shorter-lived deployments). */
  accessTtlMs?: number;
  refreshTtlMs?: number;
  /** How long after a rotation its spent token may still be presented once more (a lost response). Default 30 s. */
  reuseGraceSeconds?: number;
}

/** See {@link refresh}: the window in which a spent refresh token is a retry, not a theft. */
export const REUSE_GRACE_SECONDS = 30;

type Db = Pool | PoolClient;

/** sha256 of a token, hex. This, never the token, is what the database holds. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** 32 random bytes, base64url (43 characters), with a prefix. */
function newToken(prefix: string): string {
  return prefix + randomBytes(32).toString("base64url");
}

function newFamilyId(): string {
  return `fam_${randomBytes(16).toString("base64url")}`;
}

function unauthenticated(message = "Invalid or expired token"): CrossoverError {
  return new CrossoverError("UNAUTHENTICATED", message);
}

/**
 * Start a new login for a participant: a fresh family with one access and one refresh
 * token. The participant must exist and not be `REMOVED`.
 */
export async function issueTokens(
  db: Db,
  participantId: string,
  options: TokenOptions = {},
): Promise<TokenPair> {
  const { rows } = await db.query<{ room_id: string; status: string }>(
    "SELECT room_id, status FROM participants WHERE id = $1",
    [participantId],
  );
  const participant = rows[0];
  if (!participant) {
    throw new CrossoverError("NOT_FOUND", `Participant ${participantId} not found`);
  }
  if (participant.status === "REMOVED") {
    throw new CrossoverError("FORBIDDEN", `Participant ${participantId} has been removed`);
  }
  return insertPair(db, participantId, participant.room_id, newFamilyId(), options);
}

/**
 * Exchange a refresh token for a new pair in the same family (rotation). The old refresh
 * token is spent. If a spent refresh token is presented again, someone else may hold a copy,
 * so **every token in its family is revoked** and the call fails; the revocation is
 * committed even though the call throws. Old access tokens stay valid until they expire (or
 * until the family is revoked), so requests in flight aren't cut off by a refresh.
 *
 * Throws `UNAUTHENTICATED` for unknown, malformed, expired or revoked tokens, for a token
 * that isn't a refresh token, and for a participant who has been removed.
 */
export async function refresh(
  pool: Pool,
  refreshToken: string,
  options: TokenOptions = {},
): Promise<TokenPair> {
  if (typeof refreshToken !== "string" || !refreshToken.startsWith(REFRESH_TOKEN_PREFIX)) {
    throw unauthenticated();
  }
  const hash = hashToken(refreshToken);

  // Resolve to either a new pair or a rejection, but never throw inside the transaction for
  // a reuse: that would roll back the family revocation we need to keep.
  const outcome = await withTransaction(pool, async (client) => {
    // One rotation of a login at a time: take the login's lock before looking at any of its
    // tokens, so a grace refresh and a normal rotation can't each judge the other's successor
    // unused and fork the family.
    const { rows: login } = await client.query<{ family_id: string }>(
      "SELECT family_id FROM auth_tokens WHERE token_hash = $1 AND kind = 'REFRESH'",
      [hash],
    );
    if (login[0]) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [login[0].family_id]);
    }
    const { rows } = await client.query<{
      participant_id: string;
      room_id: string;
      family_id: string;
      expired: boolean;
      used: boolean;
      revoked: boolean;
      by_grace: boolean;
      graced: boolean;
      status: string;
    }>(
      `SELECT t.participant_id, t.room_id, t.family_id,
              t.expires_at <= clock_timestamp() AS expired,
              t.used_at IS NOT NULL AS used,
              t.revoked_at IS NOT NULL AS revoked,
              t.revoked_by_grace AS by_grace,
              t.graced_at IS NOT NULL AS graced,
              p.status
         FROM auth_tokens t
         JOIN participants p ON p.id = t.participant_id
        WHERE t.token_hash = $1 AND t.kind = 'REFRESH'
        FOR UPDATE OF t`,
      [hash],
    );
    const token = rows[0];
    if (token?.revoked && token.by_grace) {
      // The successor a grace refresh revoked, presented by someone: its holder is not the client
      // that retried, so the login has two holders. Revoke it.
      await client.query(
        "UPDATE auth_tokens SET revoked_at = clock_timestamp() WHERE family_id = $1 AND revoked_at IS NULL",
        [token.family_id],
      );
      return { ok: false as const };
    }
    if (!token || token.revoked || token.expired || token.status === "REMOVED") {
      return { ok: false as const };
    }
    if (token.used) {
      // A response can be lost on the way back: the client then presents the token it already
      // spent. If that was the latest rotation of the login, no more than REUSE_GRACE_SECONDS ago,
      // and its successor was never used, hand out a new pair and kill the unused successor (whose
      // secret nobody has seen) instead of revoking the login. Anything else is reuse.
      const { rows: graced } = await client.query<{ used_at: Date }>(
        `SELECT t.used_at FROM auth_tokens t
          WHERE t.token_hash = $1 AND t.graced_at IS NULL
            AND t.used_at > clock_timestamp() - make_interval(secs => $2)
            AND NOT EXISTS (SELECT 1 FROM auth_tokens later
                             WHERE later.family_id = t.family_id AND later.kind = 'REFRESH'
                               AND later.used_at > t.used_at)
            AND NOT EXISTS (SELECT 1 FROM auth_tokens succ
                             WHERE succ.family_id = t.family_id AND succ.kind = 'REFRESH'
                               AND succ.created_at >= t.used_at AND succ.used_at IS NOT NULL)
            AND EXISTS (SELECT 1 FROM auth_tokens succ
                         WHERE succ.family_id = t.family_id AND succ.kind = 'REFRESH'
                           AND succ.created_at >= t.used_at AND succ.used_at IS NULL
                           AND succ.revoked_at IS NULL)`,
        [hash, options.reuseGraceSeconds ?? REUSE_GRACE_SECONDS],
      );
      if (graced[0]) {
        // Revoke the successor pair nobody has seen, marked as revoked by grace; and this spent
        // token has had its one grace.
        await client.query(
          `UPDATE auth_tokens SET revoked_at = clock_timestamp(), revoked_by_grace = true
            WHERE family_id = $1 AND revoked_at IS NULL AND created_at >= $2`,
          [token.family_id, graced[0].used_at],
        );
        await client.query("UPDATE auth_tokens SET graced_at = now() WHERE token_hash = $1", [
          hash,
        ]);
        const pair = await insertPair(
          client,
          token.participant_id,
          token.room_id,
          token.family_id,
          options,
        );
        return { ok: true as const, pair };
      }
      await client.query(
        "UPDATE auth_tokens SET revoked_at = clock_timestamp() WHERE family_id = $1 AND revoked_at IS NULL",
        [token.family_id],
      );
      return { ok: false as const };
    }
    // now(), the transaction's time, is also the new pair's created_at: that is how a spent
    // token finds its successor.
    await client.query("UPDATE auth_tokens SET used_at = now() WHERE token_hash = $1", [hash]);
    const pair = await insertPair(
      client,
      token.participant_id,
      token.room_id,
      token.family_id,
      options,
    );
    return { ok: true as const, pair };
  });

  if (!outcome.ok) throw unauthenticated();
  return outcome.pair;
}

/** Revoke every token of one login (family). Returns how many were newly revoked. */
export async function revokeFamily(db: Db, familyId: string): Promise<number> {
  const { rowCount } = await db.query(
    "UPDATE auth_tokens SET revoked_at = clock_timestamp() WHERE family_id = $1 AND revoked_at IS NULL",
    [familyId],
  );
  return rowCount ?? 0;
}

/**
 * Revoke every token a participant holds, for when they are removed (§15.3). Pausing does
 * not revoke tokens: a paused participant keeps authenticating and its commands are refused
 * with `PARTICIPANT_PAUSED`. Returns how many were newly revoked.
 */
export async function revokeParticipantTokens(db: Db, participantId: string): Promise<number> {
  const { rowCount } = await db.query(
    "UPDATE auth_tokens SET revoked_at = clock_timestamp() WHERE participant_id = $1 AND revoked_at IS NULL",
    [participantId],
  );
  return rowCount ?? 0;
}

async function insertPair(
  db: Db,
  participantId: string,
  roomId: string,
  familyId: string,
  options: TokenOptions,
): Promise<TokenPair> {
  const accessTtl = options.accessTtlMs ?? ACCESS_TOKEN_TTL_MS;
  const refreshTtl = options.refreshTtlMs ?? REFRESH_TOKEN_TTL_MS;
  const access = newToken(ACCESS_TOKEN_PREFIX);
  const refreshToken = newToken(REFRESH_TOKEN_PREFIX);

  const { rows } = await db.query<{ access_expires_at: Date; refresh_expires_at: Date }>(
    `WITH access AS (
       INSERT INTO auth_tokens (token_hash, kind, participant_id, room_id, family_id, expires_at)
       VALUES ($1, 'ACCESS', $3, $4, $5, clock_timestamp() + $6 * interval '1 millisecond')
       RETURNING expires_at
     ), refresh AS (
       INSERT INTO auth_tokens (token_hash, kind, participant_id, room_id, family_id, expires_at)
       VALUES ($2, 'REFRESH', $3, $4, $5, clock_timestamp() + $7 * interval '1 millisecond')
       RETURNING expires_at
     )
     SELECT access.expires_at AS access_expires_at, refresh.expires_at AS refresh_expires_at
       FROM access, refresh`,
    [
      hashToken(access),
      hashToken(refreshToken),
      participantId,
      roomId,
      familyId,
      accessTtl,
      refreshTtl,
    ],
  );
  const row = rows[0]!;
  return {
    access_token: access,
    refresh_token: refreshToken,
    access_expires_at: row.access_expires_at,
    refresh_expires_at: row.refresh_expires_at,
    family_id: familyId,
  };
}
