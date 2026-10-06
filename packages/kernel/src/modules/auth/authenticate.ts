import type { Pool, PoolClient } from "@crossover/db";
import { CrossoverError } from "@crossover/protocol";
import type { Principal } from "../../principal.js";
import { ACCESS_TOKEN_PREFIX, hashToken } from "./tokens.js";

interface PrincipalRow {
  participant_id: string;
  room_id: string;
  kind: Principal["kind"];
  authority: Principal["authority"];
  role: Principal["role"];
}

/**
 * Resolve an access token to the participant behind it (§15.3).
 *
 * Throws `UNAUTHENTICATED`, with one generic message so a caller can't tell the cases apart,
 * for a token that is malformed, unknown, not an access token, expired, revoked, or belongs
 * to a participant who has been `REMOVED`. Paused and invited participants authenticate: what
 * they may then do is the policy's decision (T208).
 *
 * Expiry is judged by the database clock. The check hits PostgreSQL on every call; a Redis
 * cache in front of it (§15.3) can be added without changing this contract, as long as
 * revocation invalidates it.
 */
export async function authenticate(db: Pool | PoolClient, accessToken: string): Promise<Principal> {
  if (typeof accessToken !== "string" || !accessToken.startsWith(ACCESS_TOKEN_PREFIX)) {
    throw unauthenticated();
  }
  const { rows } = await db.query<PrincipalRow>(
    `SELECT p.id AS participant_id, p.room_id, p.kind, p.authority, p.role
       FROM auth_tokens t
       JOIN participants p ON p.id = t.participant_id AND p.room_id = t.room_id
      WHERE t.token_hash = $1
        AND t.kind = 'ACCESS'
        AND t.revoked_at IS NULL
        AND t.expires_at > clock_timestamp()
        AND p.status <> 'REMOVED'`,
    [hashToken(accessToken)],
  );
  const row = rows[0];
  if (!row) throw unauthenticated();
  return {
    participant_id: row.participant_id,
    room_id: row.room_id,
    kind: row.kind,
    authority: row.authority,
    role: row.role,
  };
}

function unauthenticated(): CrossoverError {
  return new CrossoverError("UNAUTHENTICATED", "Invalid or expired token");
}
