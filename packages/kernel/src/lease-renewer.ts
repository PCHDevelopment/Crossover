import type { RoomActorRegistry } from "./actor.js";
import type { RoomLeases } from "./leases.js";

export interface LeaseRenewerOptions {
  leases: RoomLeases;
  /** The renewal runs on each room's actor, so it never overlaps a command's own `ensure`. */
  actors: RoomActorRegistry;
  /** Default: a third of the lease TTL, so two renewals can fail before a lease lapses. */
  intervalMs?: number;
  /** A held room's lease was lost (taken over or expired); it has been forgotten and its actor drained. */
  onLost?: (roomId: string) => void;
  /** A renewal failed for a reason other than losing the lease (say, the database is down). */
  onError?: (error: unknown, roomId: string) => void;
}

/**
 * Keeps this node's leases alive while rooms are idle (T713, ARCHITECTURE §4.2), so a room
 * with subscribers but no recent commands keeps its owner. Every `intervalMs` it renews each
 * room in `leases.heldRooms()`.
 *
 * On `STALE_FENCE` the room is forgotten (it drops out of `heldRooms()`) and its actor is
 * drained. Any other error is reported and the room stays held: the next tick, or the next
 * command, may succeed. {@link close} stops the loop and releases every lease, so another
 * node can take the rooms over immediately.
 */
export class LeaseRenewer {
  private readonly leases: RoomLeases;
  private readonly actors: RoomActorRegistry;
  private readonly intervalMs: number;
  private readonly onLost: (roomId: string) => void;
  private readonly onError: (error: unknown, roomId: string) => void;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: { generation: number; promise: Promise<void> } | undefined;
  private generation = 0;

  constructor(options: LeaseRenewerOptions) {
    this.leases = options.leases;
    this.actors = options.actors;
    this.intervalMs = options.intervalMs ?? Math.floor(options.leases.ttlMs / 3);
    if (!Number.isSafeInteger(this.intervalMs) || this.intervalMs < 1) {
      throw new TypeError("LeaseRenewer: intervalMs must be a positive integer");
    }
    this.onLost = options.onLost ?? (() => undefined);
    this.onError =
      options.onError ??
      ((error, roomId) => console.error(`renewing the lease for ${roomId} failed`, error));
  }

  /** Begin renewing every `intervalMs`. Calling it twice is harmless. */
  start(): void {
    if (this.timer) return;
    const generation = this.generation;
    this.timer = setInterval(() => {
      if (generation === this.generation) void this.tick();
    }, this.intervalMs);
    this.timer.unref(); // never keeps the process alive on its own
  }

  /**
   * Renew every held room once, in parallel. A tick that is still running makes the next
   * call wait for it instead of starting another.
   */
  tick(): Promise<void> {
    return this.tickGeneration(this.generation);
  }

  /** Stop scheduling ticks and cancel queued renewals. Leases stay held until close(). */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.generation++;
  }

  /** Shutdown: stop, then release every lease (§19). */
  async close(): Promise<void> {
    await this.stop();
    await this.leases.releaseAll();
  }

  private tickGeneration(generation: number): Promise<void> {
    if (generation !== this.generation) return Promise.resolve();
    if (this.running?.generation === generation) return this.running.promise;
    const promise = this.renewAll(generation).finally(() => {
      if (this.running?.promise === promise) this.running = undefined;
    });
    this.running = { generation, promise };
    return promise;
  }

  private async renewAll(generation: number): Promise<void> {
    await Promise.all(this.leases.heldRooms().map((roomId) => this.renewOne(roomId, generation)));
  }

  private async renewOne(roomId: string, generation: number): Promise<void> {
    if (generation !== this.generation) return;
    try {
      const kept = await this.actors
        .get(roomId)
        .submit(() => (generation === this.generation ? this.leases.renew(roomId) : undefined));
      if (kept === undefined || generation !== this.generation) return;
      if (kept) return;
    } catch (error) {
      if (generation !== this.generation) return;
      this.onError(error, roomId);
      return;
    }
    if (generation !== this.generation) return;
    // Lost, or already released by a command's own STALE_FENCE handling.
    try {
      this.onLost(roomId);
    } finally {
      await this.actors.drain(roomId);
    }
  }
}
