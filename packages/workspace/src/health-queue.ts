export interface HealthCheckQueueOptions {
  /** Runs one health check; its signal cancels execution without persisting a result. */
  run: (roomId: string, revision: number, signal: AbortSignal) => Promise<unknown>;
  onError?: (error: unknown, roomId: string, revision: number) => void;
}

interface RoomQueue {
  activeRevision: number;
  queuedRevision: number | undefined;
  activeController: AbortController | undefined;
  worker: Promise<void>;
}

/** Coalesce health checks per room: one active check and one pending latest revision. */
export class HealthCheckQueue {
  private readonly runCheck: HealthCheckQueueOptions["run"];
  private readonly onError: NonNullable<HealthCheckQueueOptions["onError"]>;
  private readonly rooms = new Map<string, RoomQueue>();
  private readonly lastRequestedRevision = new Map<string, number>();
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

    const previousRevision = this.lastRequestedRevision.get(roomId);
    if (previousRevision !== undefined && revision <= previousRevision) return;
    this.lastRequestedRevision.set(roomId, revision);

    const current = this.rooms.get(roomId);
    if (current) {
      current.queuedRevision = revision;
      return;
    }

    const state = {
      activeRevision: revision,
      queuedRevision: undefined,
      activeController: undefined,
      worker: Promise.resolve(),
    } satisfies RoomQueue;
    this.rooms.set(roomId, state);
    state.worker = this.drain(roomId, state);
  }

  /** Stop accepting work, abort active checks, discard pending runs, and await cleanup. */
  async close(): Promise<void> {
    this.closing = true;
    for (const state of this.rooms.values()) {
      state.queuedRevision = undefined;
      state.activeController?.abort();
    }
    await Promise.all([...this.rooms.values()].map(({ worker }) => worker));
  }

  private async drain(roomId: string, state: RoomQueue): Promise<void> {
    while (true) {
      const revision = state.activeRevision;
      const controller = new AbortController();
      state.activeController = controller;
      try {
        await this.runCheck(roomId, revision, controller.signal);
      } catch (error) {
        if (!controller.signal.aborted) {
          try {
            this.onError(error, roomId, revision);
          } catch (reportError) {
            console.error("reporting health check failure failed", reportError);
          }
        }
      } finally {
        if (state.activeController === controller) state.activeController = undefined;
      }
      if (this.closing || state.queuedRevision === undefined) break;
      state.activeRevision = state.queuedRevision;
      state.queuedRevision = undefined;
    }
    if (this.rooms.get(roomId) === state) this.rooms.delete(roomId);
  }
}
