import type { Pool, PoolClient } from "@crossover/db";
import { acquireLease, DEFAULT_LEASE_TTL_MS, releaseLease, renewLease } from "@crossover/ledger";
import { CrossoverError } from "@crossover/protocol";

/**
 * The room leases this node holds (ARCHITECTURE §4.2). The dispatcher calls {@link ensure}
 * before every write and passes the returned fencing token to `appendEvents`.
 *
 * `ensure` renews a held lease or acquires a free one; if another node owns the room it
 * throws `STALE_FENCE` (the gateway should have routed the command to the owner). There is
 * no background renewal: a lease is extended by each command, and an idle room's lease
 * simply expires and is re-acquired (with a new token) on the next command.
 *
 * Not safe for concurrent calls for the *same room*; the room actor serializes them.
 */
export class RoomLeases {
  private readonly held = new Map<string, number>();

  constructor(
    private readonly pool: Pool,
    readonly nodeId: string,
    private readonly ttlMs: number = DEFAULT_LEASE_TTL_MS,
  ) {
    if (nodeId === "") throw new TypeError("RoomLeases: nodeId must not be empty");
  }

  /** The fencing token to write with, extending or acquiring the room's lease. */
  async ensure(roomId: string): Promise<number> {
    const token = this.held.get(roomId);
    if (token !== undefined) {
      try {
        return (await renewLease(this.pool, roomId, this.nodeId, token, this.ttlMs)).fencing_token;
      } catch (err) {
        if (!(err instanceof CrossoverError) || err.code !== "STALE_FENCE") throw err;
        this.held.delete(roomId); // expired or taken over: fall through and try to re-acquire
      }
    }
    const lease = await acquireLease(this.pool, roomId, this.nodeId, this.ttlMs);
    if (!lease) {
      throw new CrossoverError("STALE_FENCE", `Room ${roomId} is owned by another node`, {
        details: { room_id: roomId, node_id: this.nodeId },
      });
    }
    this.held.set(roomId, lease.fencing_token);
    return lease.fencing_token;
  }

  /**
   * Acquire the lease for a room that is being created, on `db` (the creating transaction),
   * without remembering it: the row only exists if that transaction commits, so call
   * {@link adopt} afterwards. Throws `STALE_FENCE` if another node somehow owns the room.
   */
  async acquireFor(db: Pool | PoolClient, roomId: string): Promise<number> {
    const lease = await acquireLease(db, roomId, this.nodeId, this.ttlMs);
    if (!lease) {
      throw new CrossoverError("STALE_FENCE", `Room ${roomId} is owned by another node`, {
        details: { room_id: roomId, node_id: this.nodeId },
      });
    }
    return lease.fencing_token;
  }

  /** Remember a lease acquired with {@link acquireFor} once its transaction has committed. */
  adopt(roomId: string, token: number): void {
    this.held.set(roomId, token);
  }

  /** Forget a room's token (after a `STALE_FENCE`), so the next `ensure` re-acquires. */
  forget(roomId: string): void {
    this.held.delete(roomId);
  }

  /** Rooms this node currently believes it owns. */
  heldRooms(): string[] {
    return [...this.held.keys()];
  }

  /** Give up every held lease (shutdown), so other nodes can take over immediately. */
  async releaseAll(): Promise<void> {
    const entries = [...this.held.entries()];
    this.held.clear();
    await Promise.all(
      entries.map(([roomId, token]) => releaseLease(this.pool, roomId, this.nodeId, token)),
    );
  }
}
