/**
 * Runs a room's jobs strictly one at a time, in submission order (ARCHITECTURE §4.2:
 * "each active room is owned by exactly one app node", and within the node by one actor).
 * This serializes the work inside a process; the lease and fencing token (T111/T112) are
 * what keep other nodes out.
 *
 * A job must not `await` another job submitted to the same actor: it would wait behind
 * itself forever.
 */
export class RoomActor {
  readonly roomId: string;
  private tail: Promise<void> = Promise.resolve();
  private count = 0;

  constructor(roomId: string) {
    if (typeof roomId !== "string" || roomId === "") {
      throw new TypeError("RoomActor: roomId must be a non-empty string");
    }
    this.roomId = roomId;
  }

  /** Jobs submitted and not yet finished (queued plus the one running). */
  get pending(): number {
    return this.count;
  }

  /**
   * Queue `job` behind every job submitted earlier. The returned promise settles with the
   * job's own result or error; a failing job never stops the queue.
   */
  submit<T>(job: () => Promise<T> | T): Promise<T> {
    if (typeof job !== "function") {
      throw new TypeError("RoomActor.submit: job must be a function");
    }
    this.count++;
    const result = this.tail.then(() => job());
    // The queue only waits for the job to settle; its outcome belongs to the caller.
    this.tail = result.then(
      () => this.finished(),
      () => this.finished(),
    );
    return result;
  }

  /** Resolves once every job submitted so far has settled. */
  async idle(): Promise<void> {
    await this.tail;
  }

  private finished(): void {
    this.count--;
  }
}

/** Creates one {@link RoomActor} per room ID, lazily, and returns the same one thereafter. */
export class RoomActorRegistry {
  private readonly actors = new Map<string, RoomActor>();

  /** The room's actor, created on first use. */
  get(roomId: string): RoomActor {
    let actor = this.actors.get(roomId);
    if (!actor) {
      actor = new RoomActor(roomId);
      this.actors.set(roomId, actor);
    }
    return actor;
  }

  has(roomId: string): boolean {
    return this.actors.has(roomId);
  }

  /** Number of actors created so far. */
  get size(): number {
    return this.actors.size;
  }
}
