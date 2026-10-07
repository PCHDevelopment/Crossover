export interface HealthCheckQueueOptions {
  /** Runs the persisted health check for one room revision. */
  run: (roomId: string, revision: number) => Promise<unknown>;
  onError?: (error: unknown, roomId: string, revision: number) => void;
}

interface RoomQueue {
  lastRequestedRevision: number;
  activeRevision: number;
  queuedRevision: number | undefined;
  worker: Promise<void>;
}

/** Coalesce health checks per room: one active check and one pending latest revision. */
export class HealthCheckQueue {
  private readonly runCheck: HealthCheckQueueOptions["run"];
  private readonly onError: NonNullable<HealthCheckQueueOptions["onError"]>;
  private readonly rooms = new Map<string, RoomQueue>();
  private closing = false;

  constructor(options: HealthCheckQueueOptions) {
    this.runCheck = options.run;
    this.onError =
      options.onError ??
      ((error, roomId, revision) =>
        console.error(`health check failed for ${roomId} revision ${revision}`, error));
  }

  /** Add a committed revision; while busy, only the highest queued revision is retained. */
  enqueue(roomId: string, revision: number): void {
    if (this.closing) return;
    if (!roomId.trim()) throw new TypeError("Health check room ID must not be empty");
    if (!Number.isSafeInteger(revision) || revision < 0)
      throw new RangeError("Health check revision must be a nonnegative safe integer");

    const current = this.rooms.get(roomId);
    if (current) {
      if (revision <= current.lastRequestedRevision) return;
      current.lastRequestedRevision = revision;
      current.queuedRevision = revision;
      return;
    }

    const state = {
      lastRequestedRevision: revision,
      activeRevision: revision,
      queuedRevision: undefined,
      worker: Promise.resolve(),
    } satisfies RoomQueue;
    this.rooms.set(roomId, state);
    state.worker = this.drain(roomId, state);
  }

  /** Stop accepting work, discard queued revisions, and wait for active checks to finish. */
  async close(): Promise<void> {
    this.closing = true;
    for (const state of this.rooms.values()) state.queuedRevision = undefined;
    await Promise.all([...this.rooms.values()].map(({ worker }) => worker));
  }

  private async drain(roomId: string, state: RoomQueue): Promise<void> {
    while (true) {
      const revision = state.activeRevision;
      try {
        await this.runCheck(roomId, revision);
      } catch (error) {
        try {
          this.onError(error, roomId, revision);
        } catch (reportError) {
          console.error("reporting health check failure failed", reportError);
        }
      }
      if (this.closing || state.queuedRevision === undefined) break;
      state.activeRevision = state.queuedRevision;
      state.queuedRevision = undefined;
    }
    if (this.rooms.get(roomId) === state) this.rooms.delete(roomId);
  }
}
