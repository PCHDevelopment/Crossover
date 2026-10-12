import { randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "@crossover/db";
import { CrossoverError, newId } from "@crossover/protocol";
import type { UserPrincipal } from "../../dispatcher.js";
import { hashToken } from "../auth/tokens.js";

type Db = Pool | PoolClient;

export const USER_SESSION_PREFIX = "us_";
export const USER_SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

export interface User {
  id: string;
  display_name: string;
  provider: string;
  provider_subject: string;
}

export interface UserSession {
  /** `us_…`. Shown once; only its hash is stored. */
  session_token: string;
  expires_at: Date;
}

export interface ProviderIdentity {
  /** `dev`, `github`, `google`, … */
  provider: string;
  /** The provider's stable id for the person (never an email or a name). */
  subject: string;
  display_name: string;
}

/**
 * The user for a provider identity, creating it on first sight. The same `(provider,
 * subject)` always resolves to the same user, however many times or how concurrently it is
 * called; a later `display_name` does not rename an existing user.
 */
export async function findOrCreateUser(db: Db, identity: ProviderIdentity): Promise<User> {
  const { rows } = await db.query<User>(
    `INSERT INTO users (id, display_name, provider, provider_subject)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (provider, provider_subject) DO UPDATE SET provider = users.provider
     RETURNING id, display_name, provider, provider_subject`,
    [newId("usr"), identity.display_name, identity.provider, identity.subject],
  );
  return rows[0]!;
}

/** Start a platform session for a user: a fresh opaque token, valid for `ttlMs`. */
export async function createUserSession(
  db: Db,
  userId: string,
  options: { ttlMs?: number } = {},
): Promise<UserSession> {
  const token = USER_SESSION_PREFIX + randomBytes(32).toString("base64url");
  const { rows } = await db.query<{ expires_at: Date }>(
    `INSERT INTO user_sessions (token_hash, user_id, created_at, expires_at)
     SELECT $1, $2, t.now, t.now + make_interval(secs => $3) FROM (SELECT clock_timestamp() AS now) t
     RETURNING expires_at`,
    [hashToken(token), userId, (options.ttlMs ?? USER_SESSION_TTL_MS) / 1000],
  );
  return { session_token: token, expires_at: rows[0]!.expires_at };
}

/**
 * Resolve a session token to the user it belongs to. Unknown, malformed, expired and revoked
 * tokens all fail the same way: `UNAUTHENTICATED` with a generic message.
 */
export async function authenticateUser(db: Db, token: string): Promise<UserPrincipal> {
  const fail = () => new CrossoverError("UNAUTHENTICATED", "Invalid or expired token");
  if (!token.startsWith(USER_SESSION_PREFIX)) throw fail();
  const { rows } = await db.query<{ user_id: string; display_name: string }>(
    `SELECT u.id AS user_id, u.display_name
     FROM user_sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp()`,
    [hashToken(token)],
  );
  const user = rows[0];
  if (!user) throw fail();
  return user;
}

/** Revoke every session of a user (logout everywhere). Returns how many were live. */
export async function revokeUserSessions(db: Db, userId: string): Promise<number> {
  const { rowCount } = await db.query(
    "UPDATE user_sessions SET revoked_at = clock_timestamp() WHERE user_id = $1 AND revoked_at IS NULL",
    [userId],
  );
  return rowCount ?? 0;
}

/** Revoke one opaque platform session token, for signing out the current browser. */
export async function revokeUserSession(db: Db, token: string): Promise<boolean> {
  if (!token.startsWith(USER_SESSION_PREFIX)) return false;
  const { rowCount } = await db.query(
    "UPDATE user_sessions SET revoked_at = clock_timestamp() WHERE token_hash = $1 AND revoked_at IS NULL",
    [hashToken(token)],
  );
  return rowCount === 1;
}
