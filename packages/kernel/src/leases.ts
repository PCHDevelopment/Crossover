import type { Pool, PoolClient } from "@crossover/db";
import { acquireLease, DEFAULT_LEASE_TTL_MS, releaseLease, renewLease } from "@crossover/ledger";
import { CrossoverError } from "@crossover/protocol";

/**
 * The room leases this node holds (ARCHITECTURE §4.2). The dispatcher calls {@link ensure}
 * before every write and passes the returned fencing token to `appendEvents`.
 *
 * `ensure` renews a held lease or acquires a free one; if another node owns the room it
 * throws `STALE_FENCE` (the gateway should have routed the command to the owner). A lease is
 * extended by each command; {@link LeaseRenewer} (T713) also renews idle rooms in the
 * background, and a lease that lapses anyway is re-acquired (with a new token) on the next
 * command.
 *
 * Not safe for concurrent calls for the *same room*; the room actor serializes them (the
 * renewer submits its work through the actor too).
 */
export interface RoomLeasesOptions {
  /**
   * Runs after this node acquires a room's lease (first use, failover, or re-acquiring a
   * lapsed one), before the lease is remembered and so before the room's first command
   * (ENGINEERING: reconcile the Git ref, §19.4). If it throws, the lease is released, the
   * room is not activated and the error reaches the caller; the next command tries again.
   * Not called for rooms being created ({@link RoomLeases.acquireFor}), which have no
   * history to recover.
   */
  onAcquire?: (roomId: string) => void | Promise<void>;
}

export class RoomLeases {
  private readonly held = new Map<string, number>();
  private readonly onAcquire: ((roomId: string) => void | Promise<void>) | undefined;

  constructor(
    private readonly pool: Pool,
    readonly nodeId: string,
    readonly ttlMs: number = DEFAULT_LEASE_TTL_MS,
    options: RoomLeasesOptions = {},
  ) {
    if (nodeId === "") throw new TypeError("RoomLeases: nodeId must not be empty");
    this.onAcquire = options.onAcquire;
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
    if (this.onAcquire) {
      try {
        await this.onAcquire(roomId);
      } catch (err) {
        // Don't sit on a room we couldn't activate: let another node (or a retry) have it.
        await releaseLease(this.pool, roomId, this.nodeId, lease.fencing_token).catch(() => false);
        throw err;
      }
    }
    this.held.set(roomId, lease.fencing_token);
    return lease.fencing_token;
  }

  /**
   * Renew a held lease without writing (background renewal, T713). Returns `false`, and
   * forgets the room, if the lease was lost (expired and taken over, or re-acquired by
   * another node); other errors (say, the database being down) propagate and leave the room
   * held, so the next attempt can still succeed. A room that isn't held is left alone.
   */
  async renew(roomId: string): Promise<boolean> {
    const token = this.held.get(roomId);
    if (token === undefined) return false;
    try {
      await renewLease(this.pool, roomId, this.nodeId, token, this.ttlMs);
      return true;
    } catch (err) {
      if (err instanceof CrossoverError && err.code === "STALE_FENCE") {
        // Only forget the token we tried: a command may have re-acquired in the meantime.
        if (this.held.get(roomId) === token) this.held.delete(roomId);
        return false;
      }
      throw err;
    }
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
