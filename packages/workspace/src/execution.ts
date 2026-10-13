import type { Pool } from "@crossover/db";
import type { EditIntent } from "@crossover/kernel";
import { CrossoverError } from "@crossover/protocol";
import type { SandboxFileChanges } from "./sandbox-status.js";
import { ExecutionCore, SANDBOX_VCPU_COUNT } from "./execution/core.js";
import type {
  ExecutionDriver,
  ExecutionServiceOptions,
  PendingSandboxExec,
  SandboxAdvanceEvent,
  SandboxExecProcess,
  SandboxExecTermination,
  SandboxRecord,
  SandboxRow,
  SandboxSnapshotEntry,
  SandboxSnapshotFile,
  SandboxSyncResult,
  SandboxWorkingCopyFile,
  SandboxWorkingCopyStatus,
} from "./execution/core.js";
import {
  close as closeLifecycle,
  destroyParticipant as destroyParticipantLifecycle,
  destroyRoom as destroyRoomLifecycle,
  ensure as ensureLifecycle,
  hibernateOne,
  hibernateRoom as hibernateRoomLifecycle,
  startSweeper as startSweeperLifecycle,
  sweepCleanup as sweepCleanupLifecycle,
  sweepIdle as sweepIdleLifecycle,
  withSandboxLock as withSandboxLockLifecycle,
} from "./execution/lifecycle.js";
import {
  advanceWorkingCopy as advanceWorkingCopyImpl,
  advanceWorkingCopyLocked as advanceWorkingCopyLockedImpl,
  changedWorkspacePaths,
  filterSnapshotDelta,
  filteredIntents as filteredIntentsImpl,
  pathsOverlap,
  readSnapshotFiles as readSnapshotFilesImpl,
  readablePaths as readablePathsImpl,
  rebaseHumanWorkingCopy as rebaseHumanWorkingCopyImpl,
  snapshotChanges as snapshotChangesImpl,
  snapshotDelta,
  snapshotInventory as snapshotInventoryImpl,
  status as statusImpl,
  syncWorkingCopy as syncWorkingCopyImpl,
  readWorkingCopyFile as readWorkingCopyFileImpl,
  writeWorkingCopyFile as writeWorkingCopyFileImpl,
} from "./execution/working-copy.js";

export {
  SANDBOX_VCPU_COUNT,
  type SandboxStatus,
  type DiskEnforcementMode,
  type SandboxLimits,
  type SandboxExecTermination,
  type SandboxExecOutcome,
  type SandboxExecProcess,
  type SandboxCpuUsage,
  type SandboxRecord,
  type SandboxResources,
  type SandboxWorkspaceHead,
  type SandboxWorkingCopyStatus,
  type SandboxSnapshotEntry,
  type SandboxSnapshotFile,
  type SandboxWorkingCopyFile,
  type ExecutionDriver,
  type ExecutionServiceOptions,
  type SandboxAdvanceEvent,
  type SandboxSyncResponse,
  type SandboxSyncResult,
} from "./execution/core.js";

/** Persists per-participant sandbox ownership and manages its container lifecycle. */
export class ExecutionService {
  private readonly core: ExecutionCore;

  constructor(pool: Pool, driver: ExecutionDriver, options: ExecutionServiceOptions = {}) {
    const core: ExecutionCore = new ExecutionCore(pool, driver, options, {
      hibernateOne: (roomId, participantId) => hibernateOne(core, roomId, participantId),
      scheduleLatestCanonical: (roomId) => this.scheduleLatestCanonical(roomId),
      cancelAllExecs: (reason) => this.cancelAllExecs(reason),
    });
    this.core = core;
  }

  /** Create lazily, or resume, the one sandbox owned by this room participant. */
  async ensure(roomId: string, participantId: string): Promise<SandboxRecord> {
    return ensureLifecycle(this.core, roomId, participantId);
  }

  get(roomId: string, participantId: string): Promise<SandboxRecord | null> {
    return this.core.get(roomId, participantId);
  }

  /** Serialize snapshot preparation with lifecycle transitions, while keeping I/O off SQL locks. */
  async withSandboxLock<T>(
    roomId: string,
    participantId: string,
    work: (sandbox: SandboxRecord) => Promise<T>,
  ): Promise<T> {
    return withSandboxLockLifecycle(this.core, roomId, participantId, work);
  }

  supportsSandboxSubmit(): boolean {
    return Boolean(
      this.core.driver.snapshotInventory &&
      this.core.driver.readSnapshotFiles &&
      this.core.driver.updateSnapshot,
    );
  }

  supportsSandboxExec(): boolean {
    return Boolean(this.core.driver.exec && this.core.driver.cpuUsage);
  }

  /** Enqueue the latest canonical revision; one room worker coalesces bursts of commits. */
  scheduleCanonicalAdvance(roomId: string, revision: number, skipParticipantId?: string): void {
    this.core.pendingAdvances.set(
      roomId,
      Math.max(this.core.pendingAdvances.get(roomId) ?? 0, revision),
    );
    if (skipParticipantId) {
      const skipped = this.core.pendingAdvanceSkips.get(roomId) ?? new Map<string, number>();
      skipped.set(skipParticipantId, Math.max(skipped.get(skipParticipantId) ?? 0, revision));
      this.core.pendingAdvanceSkips.set(roomId, skipped);
    }
    if (!this.core.advanceWorkers.has(roomId))
      setImmediate(() => this.startCanonicalAdvanceWorker(roomId));
  }

  setSandboxEventSink(
    sink: (roomId: string, events: readonly SandboxAdvanceEvent[]) => Promise<void>,
  ): void {
    this.core.sandboxEventSink = sink;
  }

  private async drainCanonicalAdvances(roomId: string): Promise<void> {
    while (this.core.pendingAdvances.has(roomId)) {
      const requestedRevision = this.core.pendingAdvances.get(roomId)!;
      this.core.pendingAdvances.delete(roomId);
      const skipped = this.core.pendingAdvanceSkips.get(roomId) ?? new Map<string, number>();
      this.core.pendingAdvanceSkips.delete(roomId);
      try {
        await this.reconcileRoomSandboxes(roomId, requestedRevision, skipped);
      } catch (error) {
        console.error("Failed to reconcile sandboxes after a canonical advance", {
          room_id: roomId,
          revision: requestedRevision,
          error,
        });
      }
    }
  }

  private startCanonicalAdvanceWorker(roomId: string): void {
    if (this.core.advanceWorkers.has(roomId) || !this.core.pendingAdvances.has(roomId)) return;
    const worker = this.drainCanonicalAdvances(roomId).finally(() => {
      this.core.advanceWorkers.delete(roomId);
      if (this.core.pendingAdvances.has(roomId)) this.startCanonicalAdvanceWorker(roomId);
    });
    this.core.advanceWorkers.set(roomId, worker);
  }

  /** Reserve capacity before the command commits its started event. */
  async reserveExec(
    roomId: string,
    participantId: string,
    execId: string,
    requestedTimeoutMs = 600_000,
  ): Promise<{ sandbox_id: string; timeout_ms: number }> {
    return this.withSandboxLock(roomId, participantId, async (sandbox) => {
      if (!this.core.driver.exec || !this.core.driver.cpuUsage)
        throw new CrossoverError(
          "UNAVAILABLE",
          "Sandbox execution requires a cumulative CPU meter",
        );
      if (this.core.pendingExecs.has(execId) || this.core.activeExecs.has(execId))
        throw new CrossoverError("CONFLICT_VERSION", "Sandbox execution id is already reserved");
      this.assertExecCapacityFor(sandbox.id);
      await this.core.computeSweeper.sample(sandbox);
      const timeoutMs = await this.core.computeBudgetMeter.reserve({
        room_id: roomId,
        participant_id: participantId,
        sandbox_id: sandbox.id,
        exec_id: execId,
        requested_timeout_ms: requestedTimeoutMs,
        vcpus: SANDBOX_VCPU_COUNT,
      });
      this.core.pendingExecs.set(execId, {
        room_id: roomId,
        participant_id: participantId,
        sandbox_id: sandbox.id,
      });
      return { sandbox_id: sandbox.id, timeout_ms: timeoutMs };
    });
  }

  /** Check that prepare still owns the slot before committing the started event. */
  assertExecReservation(
    roomId: string,
    participantId: string,
    sandboxId: string,
    execId: string,
  ): void {
    const pending = this.core.pendingExecs.get(execId);
    if (
      !pending ||
      pending.room_id !== roomId ||
      pending.participant_id !== participantId ||
      pending.sandbox_id !== sandboxId
    )
      throw new CrossoverError(
        "UNAVAILABLE",
        "Sandbox execution reservation is no longer available",
      );
  }

  /** Read a pending reservation so cancel can find an exec before its private log exists. */
  pendingExec(execId: string): PendingSandboxExec | undefined {
    const pending = this.core.pendingExecs.get(execId);
    return pending ? { ...pending } : undefined;
  }

  /** Release a slot after commit or rollback; consuming it at start makes this a no-op. */
  async releaseExecReservation(execId: string): Promise<void> {
    const pending = this.core.pendingExecs.get(execId);
    if (!pending) return;
    await this.core.withEnsureLock(pending.room_id, pending.participant_id, async () => {
      if (this.core.pendingExecs.get(execId) === pending) {
        this.core.pendingExecs.delete(execId);
        await this.core.computeBudgetMeter.release(execId);
      }
    });
  }

  private assertExecCapacityFor(sandboxId: string): void {
    if (!this.core.driver.exec)
      throw new CrossoverError("UNAVAILABLE", "Sandbox execution is not supported by this driver");
    if (this.execCount(sandboxId) >= 8)
      throw new CrossoverError("VALIDATION", "A sandbox may run at most 8 commands at once", {
        details: { reason: "too_many_execs", maximum: 8 },
      });
  }

  /** Start one command while serialized with submit's post-commit working-copy advance. */
  async startExec(input: {
    room_id: string;
    participant_id: string;
    exec_id: string;
    command: string;
    cwd: string;
    timeoutMs: number;
    onOutput: (stream: "stdout" | "stderr", chunk: Buffer) => Promise<void>;
  }): Promise<SandboxExecProcess> {
    return this.withSandboxLock(input.room_id, input.participant_id, async (sandbox) => {
      const pending = this.core.pendingExecs.get(input.exec_id);
      if (
        !pending ||
        pending.room_id !== input.room_id ||
        pending.participant_id !== input.participant_id ||
        pending.sandbox_id !== sandbox.id
      )
        throw new CrossoverError(
          "UNAVAILABLE",
          "Sandbox execution reservation is no longer available",
        );

      if (pending.reason !== undefined) {
        this.core.pendingExecs.delete(input.exec_id);
        await this.core.computeBudgetMeter.release(input.exec_id);
        return {
          ...(pending.cancelled_by !== undefined ? { cancelled_by: pending.cancelled_by } : {}),
          finished: Promise.resolve({
            exit_code: null,
            duration_ms: 0,
            reason: pending.reason,
          }),
          cancel: async () => undefined,
        };
      }

      const run = this.core.driver.exec;
      if (!run || !this.core.driver.cpuUsage || !sandbox.volume_ref || !sandbox.container_ref) {
        this.core.pendingExecs.delete(input.exec_id);
        await this.core.computeBudgetMeter.release(input.exec_id);
        throw new CrossoverError(
          "UNAVAILABLE",
          "Sandbox execution requires a cumulative CPU meter",
        );
      }
      let process: SandboxExecProcess;
      try {
        process = await run.call(this.core.driver, {
          sandbox_id: sandbox.id,
          resources: this.core.resources(sandbox),
          exec_id: input.exec_id,
          command: input.command,
          cwd: input.cwd,
          timeoutMs: input.timeoutMs,
          onOutput: input.onOutput,
        });
      } catch (error) {
        this.core.pendingExecs.delete(input.exec_id);
        await this.core.computeBudgetMeter.release(input.exec_id);
        throw error;
      }
      this.core.pendingExecs.delete(input.exec_id);
      this.core.activeExecs.set(input.exec_id, {
        room_id: input.room_id,
        participant_id: input.participant_id,
        sandbox_id: sandbox.id,
        process,
      });
      void process.finished
        .catch(() => undefined)
        .then(async () => {
          try {
            await this.core.computeSweeper.sample(sandbox);
            await this.core.computeBudgetMeter.release(input.exec_id);
          } catch (error) {
            console.error("Failed to reconcile sandbox CPU usage", error);
          }
          return this.core.withEnsureLock(input.room_id, input.participant_id, async () => {
            const active = this.core.activeExecs.get(input.exec_id);
            if (active?.process === process) this.core.activeExecs.delete(input.exec_id);
            const head = await this.core.workspaceHead(input.room_id).catch(() => undefined);
            if (head) this.scheduleCanonicalAdvance(input.room_id, head.revision);
          });
        })
        .catch((error: unknown) => console.error("Failed to clear completed sandbox exec", error));
      return process;
    });
  }

  async cancelExec(
    roomId: string,
    participantId: string,
    execId: string,
    reason: SandboxExecTermination = "cancelled",
    cancelledBy?: string,
  ): Promise<boolean> {
    const pending = this.core.pendingExecs.get(execId);
    const active = this.core.activeExecs.get(execId);
    const known = pending ?? active;
    if (!known || known.room_id !== roomId || known.participant_id !== participantId) return false;
    return this.core.withEnsureLock(roomId, participantId, async () => {
      const stillPending = this.core.pendingExecs.get(execId);
      if (stillPending?.room_id === roomId && stillPending.participant_id === participantId) {
        stillPending.reason = reason;
        if (cancelledBy !== undefined) stillPending.cancelled_by = cancelledBy;
        return true;
      }
      const stillActive = this.core.activeExecs.get(execId);
      if (
        !stillActive ||
        stillActive.room_id !== roomId ||
        stillActive.participant_id !== participantId
      )
        return false;
      await stillActive.process.cancel(reason);
      await stillActive.process.finished.catch(() => undefined);
      return true;
    });
  }

  async cancelParticipantExecs(
    roomId: string,
    participantId: string,
    reason: SandboxExecTermination,
  ): Promise<void> {
    await this.core.withEnsureLock(roomId, participantId, async () => {
      const sandbox = await this.core.get(roomId, participantId);
      const active = [...this.core.activeExecs.values()].filter(
        (run) => run.room_id === roomId && run.participant_id === participantId,
      );
      for (const pending of this.core.pendingExecs.values())
        if (pending.room_id === roomId && pending.participant_id === participantId)
          pending.reason = reason;
      const cancelling = active.map((run) => run.process.cancel(reason).catch(() => undefined));
      if (reason === "revoked" && sandbox?.status === "RUNNING") {
        const resources = this.core.resources(sandbox);
        if (this.core.driver.restart)
          await this.core.driver.restart({ sandbox_id: sandbox.id, resources });
        else
          await this.core.driver
            .stop({ sandbox_id: sandbox.id, resources })
            .then(() => this.core.driver.start({ sandbox_id: sandbox.id, resources }));
      }
      await Promise.all(cancelling);
      await Promise.all(active.map((run) => run.process.finished.catch(() => undefined)));
    });
  }

  async cancelAllExecs(reason: SandboxExecTermination): Promise<void> {
    for (const pending of this.core.pendingExecs.values()) pending.reason = reason;
    const active = [...this.core.activeExecs.values()];
    await Promise.all(active.map((run) => run.process.cancel(reason).catch(() => undefined)));
    await Promise.all(active.map((run) => run.process.finished.catch(() => undefined)));
  }

  private execCount(sandboxId: string): number {
    let count = this.core.activeCount(sandboxId);
    for (const pending of this.core.pendingExecs.values())
      if (pending.sandbox_id === sandboxId) count++;
    return count;
  }
  async snapshotInventory(
    sandbox: SandboxRecord,
    trackedPaths: readonly string[],
    objectFormat: "sha1" | "sha256",
    ignoreRules: { path: string; patterns: string[] }[] = [],
  ): Promise<SandboxSnapshotEntry[]> {
    return snapshotInventoryImpl(this.core, sandbox, trackedPaths, objectFormat, ignoreRules);
  }
  async readSnapshotFiles(
    sandbox: SandboxRecord,
    files: readonly SandboxSnapshotEntry[],
    objectFormat: "sha1" | "sha256",
    maxBytes: number,
  ): Promise<SandboxSnapshotFile[]> {
    return readSnapshotFilesImpl(this.core, sandbox, files, objectFormat, maxBytes);
  } /** Install a server-computed submit rebase, then move the sandbox base only after the write. */
  async advanceWorkingCopy(
    roomId: string,
    participantId: string,
    expectedBaseRevision: number,
    nextBaseRevision: number,
    files: readonly Pick<SandboxSnapshotFile, "path" | "mode" | "content">[],
    deletePaths: readonly string[],
  ): Promise<"advanced" | "process_running"> {
    return advanceWorkingCopyImpl(
      this.core,
      roomId,
      participantId,
      expectedBaseRevision,
      nextBaseRevision,
      files,
      deletePaths,
    );
  } /** Rebase a participant's local changes onto the latest canonical head on explicit sync. */
  async syncWorkingCopy(roomId: string, participantId: string): Promise<SandboxSyncResult> {
    return syncWorkingCopyImpl(this.core, roomId, participantId);
  }
  private async advanceWorkingCopyLocked(
    sandbox: SandboxRecord,
    expectedBaseRevision: number,
    nextBaseRevision: number,
    files: readonly Pick<SandboxSnapshotFile, "path" | "mode" | "content">[],
    deletePaths: readonly string[],
  ): Promise<"advanced" | "process_running"> {
    return advanceWorkingCopyLockedImpl(
      this.core,
      sandbox,
      expectedBaseRevision,
      nextBaseRevision,
      files,
      deletePaths,
    );
  }

  private async reconcileRoomSandboxes(
    roomId: string,
    requestedRevision: number,
    skippedParticipants: ReadonlyMap<string, number>,
  ): Promise<void> {
    const head = await this.core.canonicalHead(roomId);
    if (head.revision < requestedRevision) return;
    const { rows } = await this.core.pool.query<SandboxRow & { kind: "HUMAN" | "AGENT" }>(
      `SELECT s.id, s.room_id, s.participant_id, s.status, s.limits, s.base_revision,
              s.volume_ref, s.container_ref, s.last_active_at, s.updated_at, p.kind
       FROM sandboxes s JOIN participants p ON p.id = s.participant_id AND p.room_id = s.room_id
       WHERE s.room_id = $1 AND s.status = 'RUNNING' AND s.base_revision IS NOT NULL
         AND s.base_revision < $2 AND s.volume_ref IS NOT NULL AND s.container_ref IS NOT NULL
         AND p.status = 'ACTIVE'
       ORDER BY s.participant_id`,
      [roomId, head.revision],
    );
    const events: SandboxAdvanceEvent[] = [];
    for (const row of rows) {
      if ((skippedParticipants.get(row.participant_id) ?? 0) >= head.revision) continue;
      try {
        events.push(...(await this.reconcileSandbox(row, head)));
      } catch (error) {
        console.error("Failed to reconcile one sandbox", {
          room_id: roomId,
          participant_id: row.participant_id,
          revision: head.revision,
          error,
        });
        events.push({
          type: "sandbox.behind",
          actor_id: "system",
          payload: {
            participant_id: row.participant_id,
            behind_by: Math.max(0, head.revision - (row.base_revision ?? head.revision)),
            changed_paths: [],
            overlaps_local_changes: true,
            intents: [],
            reason: "advance_failed",
          },
        });
      }
    }
    if (events.length && this.core.sandboxEventSink)
      await this.core
        .sandboxEventSink(roomId, events)
        .catch((error: unknown) =>
          console.error("Failed to publish sandbox advance events", { room_id: roomId, error }),
        );
  }

  private async reconcileSandbox(
    row: SandboxRow & { kind: "HUMAN" | "AGENT" },
    head: { repo_path: string; revision: number; commit_sha: string },
  ): Promise<SandboxAdvanceEvent[]> {
    return this.core.withEnsureLock(row.room_id, row.participant_id, async () => {
      const sandbox = await this.core.get(row.room_id, row.participant_id);
      if (
        !sandbox ||
        sandbox.status !== "RUNNING" ||
        sandbox.base_revision === null ||
        sandbox.base_revision >= head.revision ||
        !sandbox.volume_ref ||
        !sandbox.container_ref
      )
        return [];
      const base = await this.core.workspaceRevision(row.room_id, sandbox.base_revision);
      const changedPaths = await changedWorkspacePaths(
        head.repo_path,
        base.commit_sha,
        head.commit_sha,
      );
      const visibleChanged = await this.readablePaths(
        row.room_id,
        row.participant_id,
        changedPaths,
      );
      const working = await this.snapshotChanges(sandbox, base.repo_path, base.commit_sha);
      const localPaths = [...working.modified, ...working.added, ...working.deleted];
      const visibleLocal = await this.readablePaths(row.room_id, row.participant_id, localPaths);
      const overlaps = visibleChanged.some((path) =>
        visibleLocal.some((local) => pathsOverlap(path, local)),
      );
      const intents = await this.filteredIntents(row.room_id, row.participant_id);
      const behindPayload = {
        participant_id: row.participant_id,
        behind_by: Math.max(0, head.revision - sandbox.base_revision),
        changed_paths: visibleChanged,
        overlaps_local_changes: overlaps || working.truncated,
        intents,
      };
      const behind = (reason?: string): SandboxAdvanceEvent => ({
        type: "sandbox.behind",
        actor_id: "system",
        payload: { ...behindPayload, ...(reason ? { reason } : {}) },
      });
      if (this.core.activeCount(sandbox.id) > 0) return [behind("process_running")];
      if (working.truncated) return [behind("status_truncated")];
      if (row.kind === "AGENT" && overlaps) return [behind("local_changes")];
      if (!this.core.driver.updateSnapshot || !this.core.driver.snapshotInventory)
        return [behind("unsupported_driver")];

      let delta: { files: SandboxSnapshotFile[]; delete_paths: string[] };
      let conflictedPaths: string[] = [];
      if (row.kind === "HUMAN" && localPaths.length > 0) {
        const rebased = await this.rebaseHumanWorkingCopy(sandbox, base, head, working);
        if (!rebased) return [behind("unsupported_local_change")];
        delta = filterSnapshotDelta(rebased.delta, new Set([...visibleChanged, ...visibleLocal]));
        conflictedPaths = rebased.conflicted_paths;
      } else {
        delta = filterSnapshotDelta(
          await snapshotDelta(head.repo_path, base.commit_sha, head.commit_sha),
          new Set(visibleChanged),
        );
      }
      let advanced: "advanced" | "process_running";
      try {
        advanced = await this.advanceWorkingCopyLocked(
          sandbox,
          sandbox.base_revision,
          head.revision,
          delta.files,
          delta.delete_paths,
        );
      } catch (error) {
        console.error("Failed to advance sandbox working copy", {
          room_id: row.room_id,
          participant_id: row.participant_id,
          revision: head.revision,
          error,
        });
        return [behind("advance_failed")];
      }
      if (advanced === "process_running") return [behind("process_running")];
      return [
        behind(),
        {
          type: "sandbox.synced",
          actor_id: "system",
          payload: {
            participant_id: row.participant_id,
            base_revision: head.revision,
            ...(conflictedPaths.length ? { conflicted_paths: conflictedPaths } : {}),
          },
        },
      ];
    });
  }
  private async rebaseHumanWorkingCopy(
    sandbox: SandboxRecord,
    base: { repo_path: string; commit_sha: string },
    head: { repo_path: string; revision: number; commit_sha: string },
    changes: SandboxFileChanges,
  ): Promise<
    | {
        delta: { files: SandboxSnapshotFile[]; delete_paths: string[] };
        conflicted_paths: string[];
      }
    | undefined
  > {
    return rebaseHumanWorkingCopyImpl(this.core, sandbox, base, head, changes);
  }
  private async readablePaths(
    roomId: string,
    participantId: string,
    paths: readonly string[],
  ): Promise<string[]> {
    return readablePathsImpl(this.core, roomId, participantId, paths);
  }
  private async filteredIntents(roomId: string, participantId: string): Promise<EditIntent[]> {
    return filteredIntentsImpl(this.core, roomId, participantId);
  }

  private scheduleLatestCanonical(roomId: string): void {
    void this.core
      .canonicalHead(roomId)
      .then(({ revision }) => this.scheduleCanonicalAdvance(roomId, revision))
      .catch((error: unknown) =>
        console.error("Failed to check canonical head after sandbox wake", {
          room_id: roomId,
          error,
        }),
      );
  } /** Report local file changes against this sandbox's base and the current canonical head. */
  async status(roomId: string, participantId: string): Promise<SandboxWorkingCopyStatus> {
    return statusImpl(this.core, roomId, participantId);
  } /** Read a single file from the caller's live working copy without following symlinks. */
  async readWorkingCopyFile(
    roomId: string,
    participantId: string,
    path: string,
    maxBytes: number,
  ): Promise<SandboxWorkingCopyFile> {
    return readWorkingCopyFileImpl(this.core, roomId, participantId, path, maxBytes);
  } /** Replace one regular file using the snapshot installer's no-follow path handling. */
  async writeWorkingCopyFile(
    roomId: string,
    participantId: string,
    path: string,
    content: Buffer,
  ): Promise<void> {
    return writeWorkingCopyFileImpl(this.core, roomId, participantId, path, content);
  }
  private async snapshotChanges(
    sandbox: SandboxRecord,
    repoPath: string,
    baseCommit: string,
  ): Promise<SandboxFileChanges> {
    return snapshotChangesImpl(this.core, sandbox, repoPath, baseCommit);
  }

  /** Hibernate idle sandboxes; the container stops while its Docker volume is retained. */
  async sweepIdle(now = new Date()): Promise<number> {
    return sweepIdleLifecycle(this.core, now);
  }

  /** Retry cleanup for interrupted destroys and owners that have left or archived their room. */
  async sweepCleanup(now = new Date()): Promise<number> {
    return sweepCleanupLifecycle(this.core, now);
  }

  /** Stop every sandbox in a room, optionally limiting the operation to agents (§5). */
  async hibernateRoom(roomId: string, agentsOnly = false): Promise<void> {
    return hibernateRoomLifecycle(this.core, roomId, agentsOnly);
  }

  async destroyParticipant(roomId: string, participantId: string): Promise<void> {
    return destroyParticipantLifecycle(this.core, roomId, participantId);
  }

  async destroyRoom(roomId: string): Promise<void> {
    return destroyRoomLifecycle(this.core, roomId);
  }

  startSweeper(): void {
    return startSweeperLifecycle(this.core);
  }

  async close(): Promise<void> {
    return closeLifecycle(this.core);
  }
}
