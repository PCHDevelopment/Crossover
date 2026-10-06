import type { Pool, PoolClient } from "@crossover/db";
import { CrossoverError } from "@crossover/protocol";

export const DEFAULT_LEASE_TTL_MS = 15_000;

/** A room ownership lease (ARCHITECTURE §4.2). */
export interface Lease {
  room_id: string;
  node_id: string;
  /** Strictly increases every time the lease changes owner. */
  fencing_token: number;
  expires_at: Date;
}

interface LeaseRow {
  room_id: string;
  node_id: string;
  fencing_token: string; // bigint comes back from pg as a string
  expires_at: Date;
}

type Db = Pool | PoolClient;

/**
 * Try to become the room's owner. Returns the new lease, or `null` if another holder's
 * lease (or this node's own) hasn't expired yet; a current holder extends with
 * {@link renewLease}. A fresh room starts at fencing token 1; taking over an expired lease
 * increments the token. A single `INSERT … ON CONFLICT DO UPDATE … WHERE expired`
 * statement, so concurrent callers can't both win.
 *
 * Expiry is judged by the database clock, so nodes with skewed clocks agree. `nodeId`
 * must be unique per process: a restarted process should not reuse its predecessor's id.
 */
export async function acquireLease(
  db: Db,
  roomId: string,
  nodeId: string,
  ttlMs: number = DEFAULT_LEASE_TTL_MS,
): Promise<Lease | null> {
  assertArgs(nodeId, ttlMs);
  try {
    const { rows } = await db.query<LeaseRow>(
      `INSERT INTO room_leases (room_id, node_id, fencing_token, expires_at)
       VALUES ($1, $2, 1, clock_timestamp() + $3 * interval '1 millisecond')
       ON CONFLICT (room_id) DO UPDATE
         SET node_id = EXCLUDED.node_id,
             fencing_token = room_leases.fencing_token + 1,
             expires_at = EXCLUDED.expires_at
         WHERE room_leases.expires_at <= clock_timestamp()
       RETURNING *`,
      [roomId, nodeId, ttlMs],
    );
    return rows[0] ? toLease(rows[0]) : null;
  } catch (err) {
    throw roomNotFoundOr(err, roomId);
  }
}

/**
 * Extend a lease you hold. Throws `STALE_FENCE` unless `nodeId` and `fencingToken` match
 * the current lease and it hasn't expired; an expired lease must be re-acquired (which
 * issues a new token), because someone else may already have taken it.
 */
export async function renewLease(
  db: Db,
  roomId: string,
  nodeId: string,
  fencingToken: number,
  ttlMs: number = DEFAULT_LEASE_TTL_MS,
): Promise<Lease> {
  assertArgs(nodeId, ttlMs);
  const { rows } = await db.query<LeaseRow>(
    `UPDATE room_leases
        SET expires_at = clock_timestamp() + $4 * interval '1 millisecond'
      WHERE room_id = $1 AND node_id = $2 AND fencing_token = $3
        AND expires_at > clock_timestamp()
      RETURNING *`,
    [roomId, nodeId, fencingToken, ttlMs],
  );
  if (!rows[0]) {
    throw new CrossoverError(
      "STALE_FENCE",
      `Node ${nodeId} does not hold the lease for ${roomId}`,
      {
        details: { room_id: roomId, node_id: nodeId, fencing_token: fencingToken },
      },
    );
  }
  return toLease(rows[0]);
}

/**
 * Give up a lease you hold, so another node can take over immediately. The row is kept
 * (expired, not deleted) so the next owner's token is still strictly larger. Returns
 * false, and changes nothing, if you no longer hold it.
 */
export async function releaseLease(
  db: Db,
  roomId: string,
  nodeId: string,
  fencingToken: number,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE room_leases SET expires_at = clock_timestamp()
      WHERE room_id = $1 AND node_id = $2 AND fencing_token = $3
        AND expires_at > clock_timestamp()`,
    [roomId, nodeId, fencingToken],
  );
  return rowCount === 1;
}

/** The room's current lease row (possibly expired), or null if it was never leased. */
export async function getLease(db: Db, roomId: string): Promise<Lease | null> {
  const { rows } = await db.query<LeaseRow>("SELECT * FROM room_leases WHERE room_id = $1", [
    roomId,
  ]);
  return rows[0] ? toLease(rows[0]) : null;
}

function toLease(row: LeaseRow): Lease {
  return {
    room_id: row.room_id,
    node_id: row.node_id,
    fencing_token: Number(row.fencing_token),
    expires_at: row.expires_at,
  };
}

function assertArgs(nodeId: string, ttlMs: number): void {
  if (nodeId === "") {
    throw new CrossoverError("VALIDATION", "nodeId must not be empty");
  }
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
    throw new CrossoverError("VALIDATION", "ttlMs must be a positive integer", {
      details: { ttlMs },
    });
  }
}

function roomNotFoundOr(err: unknown, roomId: string): unknown {
  // 23503 = foreign_key_violation: room_leases.room_id → rooms.id
  if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23503") {
    return new CrossoverError("NOT_FOUND", `Room ${roomId} not found`, {
      details: { room_id: roomId },
      cause: err,
    });
  }
  return err;
}
