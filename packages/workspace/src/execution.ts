import type { Pool } from "@crossover/db";
import { withTransaction } from "@crossover/db";
import type { EditIntent } from "@crossover/kernel";
import { CrossoverError } from "@crossover/protocol";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { ignoredWorkspacePaths } from "./ignore.js";
import { git } from "./git.js";
import { materialize } from "./materialize.js";
import { merge } from "./merge.js";
import { normalizePath } from "./path.js";
import { createSandboxFileChangesAccumulator } from "./sandbox-status.js";
import type { Operation } from "./operations.js";
import type { SandboxFileChanges } from "./sandbox-status.js";
import { ExecutionCore, MAX_AUTO_SYNC_BYTES, SANDBOX_VCPU_COUNT } from "./execution/core.js";
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
  SandboxSyncResponse,
  SandboxSyncResult,
  SandboxWorkingCopyFile,
  SandboxWorkingCopyStatus,
  SandboxWorkspaceHead,
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
    if (!this.core.driver.snapshotInventory || !sandbox.volume_ref || !sandbox.container_ref)
      throw new CrossoverError(
        "UNAVAILABLE",
        "Sandbox snapshot is not supported by this execution driver",
      );
    return this.core.driver.snapshotInventory({
      sandbox_id: sandbox.id,
      resources: { volume_ref: sandbox.volume_ref, container_ref: sandbox.container_ref },
      tracked_paths: trackedPaths,
      object_format: objectFormat,
      ignore_rules: ignoreRules,
    });
  }

  async readSnapshotFiles(
    sandbox: SandboxRecord,
    files: readonly SandboxSnapshotEntry[],
    objectFormat: "sha1" | "sha256",
    maxBytes: number,
  ): Promise<SandboxSnapshotFile[]> {
    if (!this.core.driver.readSnapshotFiles || !sandbox.volume_ref || !sandbox.container_ref)
      throw new CrossoverError(
        "UNAVAILABLE",
        "Sandbox snapshot is not supported by this execution driver",
      );
    return this.core.driver.readSnapshotFiles({
      sandbox_id: sandbox.id,
      resources: { volume_ref: sandbox.volume_ref, container_ref: sandbox.container_ref },
      files,
      object_format: objectFormat,
      max_bytes: maxBytes,
    });
  }

  /** Install a server-computed submit rebase, then move the sandbox base only after the write. */
  async advanceWorkingCopy(
    roomId: string,
    participantId: string,
    expectedBaseRevision: number,
    nextBaseRevision: number,
    files: readonly Pick<SandboxSnapshotFile, "path" | "mode" | "content">[],
    deletePaths: readonly string[],
  ): Promise<"advanced" | "process_running"> {
    return this.withSandboxLock(roomId, participantId, async (sandbox) => {
      return this.advanceWorkingCopyLocked(
        sandbox,
        expectedBaseRevision,
        nextBaseRevision,
        files,
        deletePaths,
      );
    });
  }

  /** Rebase a participant's local changes onto the latest canonical head on explicit sync. */
  async syncWorkingCopy(roomId: string, participantId: string): Promise<SandboxSyncResult> {
    return this.withSandboxLock(roomId, participantId, async (sandbox) => {
      if (sandbox.base_revision === null || !sandbox.volume_ref || !sandbox.container_ref)
        throw new CrossoverError("CONFLICT_VERSION", "Sandbox workspace is not ready");
      const head = await this.core.canonicalHead(roomId);
      if (sandbox.base_revision > head.revision)
        throw new CrossoverError("CONFLICT_VERSION", "Sandbox base is ahead of the workspace");
      if (sandbox.base_revision === head.revision)
        return { response: { synced_to: head.revision } };

      const base = await this.core.workspaceRevision(roomId, sandbox.base_revision);
      const changedPaths = await changedWorkspacePaths(
        base.repo_path,
        base.commit_sha,
        head.commit_sha,
      );
      const visibleChanged = await this.readablePaths(roomId, participantId, changedPaths);
      const working = await this.snapshotChanges(sandbox, base.repo_path, base.commit_sha);
      const localPaths = [...working.modified, ...working.added, ...working.deleted];
      const visibleLocal = await this.readablePaths(roomId, participantId, localPaths);
      const overlaps = visibleChanged.some((path) =>
        visibleLocal.some((local) => pathsOverlap(path, local)),
      );
      const intents = await this.filteredIntents(roomId, participantId);
      const behindPayload = {
        participant_id: participantId,
        behind_by: Math.max(0, head.revision - sandbox.base_revision),
        changed_paths: visibleChanged,
        overlaps_local_changes: overlaps || working.truncated,
        intents,
      };
      const behind = (reason: string): SandboxAdvanceEvent => ({
        type: "sandbox.behind",
        actor_id: "system",
        payload: { ...behindPayload, reason },
      });
      const blocked = (
        reason: Extract<SandboxSyncResponse, { reason: string }>["reason"],
      ): SandboxSyncResult => ({
        response: {
          base_revision: sandbox.base_revision!,
          head_revision: head.revision,
          reason,
        },
        event: behind(reason),
      });

      if (this.core.activeCount(sandbox.id) > 0) return blocked("process_running");
      if (working.truncated) return blocked("status_truncated");
      if (
        !this.core.driver.updateSnapshot ||
        !this.core.driver.snapshotInventory ||
        !this.core.driver.readSnapshotFiles
      )
        return blocked("unsupported_local_change");

      const rebased = await this.rebaseHumanWorkingCopy(sandbox, base, head, working);
      if (!rebased) return blocked("unsupported_local_change");
      const conflictedPaths = await this.readablePaths(
        roomId,
        participantId,
        rebased.conflicted_paths,
      );
      const delta = filterSnapshotDelta(
        rebased.delta,
        new Set([...visibleChanged, ...visibleLocal]),
      );
      const advanced = await this.advanceWorkingCopyLocked(
        sandbox,
        sandbox.base_revision,
        head.revision,
        delta.files,
        delta.delete_paths,
      );
      if (advanced === "process_running") return blocked("process_running");

      return {
        response: {
          synced_to: head.revision,
          ...(conflictedPaths.length ? { conflicted_paths: conflictedPaths } : {}),
        },
        event: {
          type: "sandbox.synced",
          actor_id: "system",
          payload: {
            participant_id: participantId,
            base_revision: head.revision,
            ...(conflictedPaths.length ? { conflicted_paths: conflictedPaths } : {}),
          },
        },
      };
    });
  }

  private async advanceWorkingCopyLocked(
    sandbox: SandboxRecord,
    expectedBaseRevision: number,
    nextBaseRevision: number,
    files: readonly Pick<SandboxSnapshotFile, "path" | "mode" | "content">[],
    deletePaths: readonly string[],
  ): Promise<"advanced" | "process_running"> {
    if (sandbox.base_revision !== expectedBaseRevision)
      throw new CrossoverError("CONFLICT_VERSION", "Sandbox base changed; sync before submitting");
    if (!sandbox.volume_ref || !sandbox.container_ref || !this.core.driver.updateSnapshot)
      throw new CrossoverError("UNAVAILABLE", "Sandbox working copy cannot be advanced");
    if (this.core.activeCount(sandbox.id) > 0) return "process_running";
    await this.core.driver.updateSnapshot({
      sandbox_id: sandbox.id,
      resources: { volume_ref: sandbox.volume_ref, container_ref: sandbox.container_ref },
      files,
      delete_paths: deletePaths,
    });
    const { rowCount } = await withTransaction(this.core.pool, (client) =>
      client.query(
        `UPDATE sandboxes SET base_revision = $4, updated_at = clock_timestamp()
         WHERE id = $1 AND room_id = $2 AND participant_id = $3 AND base_revision = $5`,
        [
          sandbox.id,
          sandbox.room_id,
          sandbox.participant_id,
          nextBaseRevision,
          expectedBaseRevision,
        ],
      ),
    );
    if (rowCount !== 1)
      throw new CrossoverError(
        "CONFLICT_VERSION",
        "Sandbox base changed while it was being advanced",
      );
    return "advanced";
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
    if (!this.core.driver.readSnapshotFiles) return undefined;
    const baseEntries = await readWorkspaceTree(base.repo_path, base.commit_sha);
    const visiblePaths = await this.readablePaths(sandbox.room_id, sandbox.participant_id, [
      ...baseEntries.keys(),
    ]);
    const visible = new Set(visiblePaths);
    const entries = new Map([...baseEntries].filter(([path]) => visible.has(path)));
    const objectFormat = await workspaceObjectFormat(base.repo_path);
    const ignoreRules = await readWorkspaceIgnoreRules(base.repo_path, baseEntries);
    let inventory = await this.snapshotInventory(
      sandbox,
      [...entries.keys()],
      objectFormat,
      ignoreRules,
    );
    const newPaths = inventory.filter(({ path }) => !entries.has(path)).map(({ path }) => path);
    if (newPaths.length) {
      inventory = await this.snapshotInventory(
        sandbox,
        [...entries.keys(), ...newPaths],
        objectFormat,
        ignoreRules,
      );
    }
    const ignored = await ignoredWorkspacePaths(base.repo_path, baseEntries, newPaths);
    const changePaths = new Set([...changes.modified, ...changes.added, ...changes.deleted]);
    const changedEntries = inventory.filter(
      ({ path, sha }) => changePaths.has(path) && sha !== null,
    );
    const files = await this.readSnapshotFiles(
      sandbox,
      changedEntries,
      objectFormat,
      MAX_AUTO_SYNC_BYTES,
    );
    const byPath = new Map(files.map((file) => [file.path, file]));
    const operations: Operation[] = [];
    for (const path of [...changePaths].sort(comparePath)) {
      const entry = inventory.find((candidate) => candidate.path === path);
      if (!entry) {
        operations.push({ type: "delete", path });
        continue;
      }
      if (ignored.has(path)) continue;
      if (entry.mode === "120000") return undefined;
      const file = byPath.get(path);
      if (!file) return undefined;
      operations.push({
        type: entries.has(path) ? "modify" : "create",
        path,
        content: file.content,
      });
    }
    const objectRepo = await createSandboxObjectRepo(base.repo_path, objectFormat);
    try {
      const localCommit = await materialize(objectRepo, base.commit_sha, operations);
      const result = await merge(objectRepo, base.commit_sha, head.commit_sha, localCommit);
      return {
        delta: await snapshotDelta(objectRepo, base.commit_sha, result.tree),
        conflicted_paths: result.clean
          ? []
          : result.conflicts.files.map(({ path }) => path).sort(comparePath),
      };
    } finally {
      await rm(objectRepo, { recursive: true, force: true });
    }
  }

  private async readablePaths(
    roomId: string,
    participantId: string,
    paths: readonly string[],
  ): Promise<string[]> {
    return this.core.options.readablePaths
      ? this.core.options.readablePaths(roomId, participantId, paths)
      : [...paths];
  }

  private async filteredIntents(roomId: string, participantId: string): Promise<EditIntent[]> {
    const stored = (await this.core.options.listIntents?.(roomId)) ?? [];
    const visible = new Set(
      await this.readablePaths(
        roomId,
        participantId,
        stored.flatMap(({ paths }) => paths),
      ),
    );
    return stored.flatMap((intent) => {
      const paths = intent.paths.filter((path) => visible.has(path));
      if (!paths.length) return [];
      const keep = new Set(paths);
      return [{ ...intent, paths, ranges: intent.ranges.filter(({ path }) => keep.has(path)) }];
    });
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
  }

  /** Report local file changes against this sandbox's base and the current canonical head. */
  async status(roomId: string, participantId: string): Promise<SandboxWorkingCopyStatus> {
    const sandbox = await this.ensure(roomId, participantId);
    if (sandbox.base_revision === null)
      throw new CrossoverError("CONFLICT_VERSION", "Sandbox workspace is not ready");
    if (!sandbox.volume_ref || !sandbox.container_ref)
      throw new CrossoverError("NOT_FOUND", "Sandbox workspace resources are unavailable");

    let workspace: SandboxWorkspaceHead;
    let changes: SandboxFileChanges;
    try {
      const base = await this.core.workspaceRevision(roomId, sandbox.base_revision);
      [workspace, changes] = await Promise.all([
        this.core.workspaceHead(roomId),
        this.snapshotChanges(sandbox, base.repo_path, base.commit_sha),
      ]);
    } catch (cause) {
      if (cause instanceof CrossoverError) throw cause;
      throw new CrossoverError(
        "UNAVAILABLE",
        "Sandbox status could not be read; retry the request",
        {
          cause,
        },
      );
    }
    return {
      base_revision: sandbox.base_revision,
      head_revision: workspace.revision,
      behind_by: Math.max(0, workspace.revision - sandbox.base_revision),
      ...changes,
    };
  }

  /** Read a single file from the caller's live working copy without following symlinks. */
  async readWorkingCopyFile(
    roomId: string,
    participantId: string,
    path: string,
    maxBytes: number,
  ): Promise<SandboxWorkingCopyFile> {
    return this.withSandboxLock(roomId, participantId, async (sandbox) => {
      if (!sandbox.volume_ref || !sandbox.container_ref)
        throw new CrossoverError("NOT_FOUND", "Sandbox workspace resources are unavailable");
      if (!this.core.driver.readFile)
        throw new CrossoverError(
          "UNAVAILABLE",
          "Sandbox file reads are not supported by this driver",
        );
      try {
        const file = await this.core.driver.readFile({
          sandbox_id: sandbox.id,
          resources: { volume_ref: sandbox.volume_ref, container_ref: sandbox.container_ref },
          path,
          max_bytes: maxBytes,
        });
        if (file.content.length > maxBytes)
          throw new CrossoverError("VALIDATION", "Sandbox file exceeds the read limit", {
            details: { reason: "file_too_large", size: file.content.length, limit: maxBytes },
          });
        return file;
      } catch (cause) {
        if (cause instanceof CrossoverError) throw cause;
        throw new CrossoverError(
          "UNAVAILABLE",
          "Sandbox file could not be read; retry the request",
          { cause },
        );
      }
    });
  }

  /** Replace one regular file using the snapshot installer's no-follow path handling. */
  async writeWorkingCopyFile(
    roomId: string,
    participantId: string,
    path: string,
    content: Buffer,
  ): Promise<void> {
    await this.withSandboxLock(roomId, participantId, async (sandbox) => {
      if (!sandbox.volume_ref || !sandbox.container_ref)
        throw new CrossoverError("NOT_FOUND", "Sandbox workspace resources are unavailable");
      if (!this.core.driver.updateSnapshot)
        throw new CrossoverError(
          "UNAVAILABLE",
          "Sandbox file writes are not supported by this driver",
        );
      try {
        await this.core.driver.updateSnapshot({
          sandbox_id: sandbox.id,
          resources: { volume_ref: sandbox.volume_ref, container_ref: sandbox.container_ref },
          files: [{ path, mode: "100644", content, preserve_mode: true }],
          delete_paths: [],
        });
      } catch (cause) {
        if (cause instanceof CrossoverError) throw cause;
        throw new CrossoverError(
          "UNAVAILABLE",
          "Sandbox file could not be written; retry the request",
          { cause },
        );
      }
    });
  }

  private async snapshotChanges(
    sandbox: SandboxRecord,
    repoPath: string,
    baseCommit: string,
  ): Promise<SandboxFileChanges> {
    if (!this.core.driver.snapshotInventory)
      throw new CrossoverError("UNAVAILABLE", "Sandbox snapshot is not supported by this driver");
    const fullBase = await readWorkspaceTree(repoPath, baseCommit);
    const visiblePaths = this.core.options.readablePaths
      ? await this.core.options.readablePaths(sandbox.room_id, sandbox.participant_id, [
          ...fullBase.keys(),
        ])
      : [...fullBase.keys()];
    const visible = new Set(visiblePaths);
    const base = new Map([...fullBase].filter(([path]) => visible.has(path)));
    const ignoreRules = await readWorkspaceIgnoreRules(repoPath, fullBase);
    const objectFormat = await workspaceObjectFormat(repoPath);
    const inventory = await this.snapshotInventory(
      sandbox,
      [...base.keys()],
      objectFormat,
      ignoreRules,
    );
    const inventoryPaths = await this.readablePaths(
      sandbox.room_id,
      sandbox.participant_id,
      inventory.map(({ path }) => path),
    );
    const visibleInventory = new Set(inventoryPaths);
    const currentInventory = inventory.filter(({ path }) => visibleInventory.has(path));
    const addedPaths = currentInventory
      .filter((entry) => !base.has(entry.path))
      .map(({ path }) => path);
    const ignored = await ignoredWorkspacePaths(repoPath, fullBase, addedPaths);
    const current = new Map(currentInventory.map((entry) => [entry.path, entry]));
    const changes = createSandboxFileChangesAccumulator();
    let stopped = false;
    for (const [path, previous] of base) {
      if (previous.mode === "160000") continue;
      const entry = current.get(path);
      if (!entry) stopped = !changes.add("deleted", path);
      else if (entry.sha !== previous.sha || entry.mode !== previous.mode)
        stopped = !changes.add("modified", path);
      if (stopped) break;
    }
    if (!stopped) {
      for (const { path } of currentInventory) {
        if (base.has(path) || ignored.has(path)) continue;
        if (!changes.add("added", path)) break;
      }
    }
    return changes.finish();
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

type WorkspaceTreeEntry = { mode: string; sha: string };

async function readWorkspaceTree(
  repoPath: string,
  commit: string,
): Promise<Map<string, WorkspaceTreeEntry>> {
  const { stdout } = await git(["ls-tree", "-r", "-z", "--full-tree", commit], {
    gitDir: repoPath,
    timeoutMs: 60_000,
    maxBuffer: 128 * 1024 * 1024,
  });
  const entries = new Map<string, WorkspaceTreeEntry>();
  for (const record of stdout.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    const [mode, type, sha] = record.slice(0, tab).split(" ");
    const rawPath = record.slice(tab + 1);
    if (!mode || (type !== "blob" && type !== "commit") || !sha || !rawPath)
      throw new CrossoverError("UNAVAILABLE", "Workspace tree is malformed");
    const path = normalizePath(rawPath);
    if (path !== rawPath)
      throw new CrossoverError("VALIDATION", "Workspace contains a non-canonical path");
    entries.set(path, { mode, sha });
  }
  return entries;
}

async function readWorkspaceIgnoreRules(
  repoPath: string,
  entries: ReadonlyMap<string, WorkspaceTreeEntry>,
): Promise<{ path: string; patterns: string[] }[]> {
  const rules: { path: string; patterns: string[] }[] = [];
  for (const [path, entry] of entries) {
    if (
      (entry.mode !== "100644" && entry.mode !== "100755") ||
      (path !== ".roomignore" && path !== ".gitignore" && !path.endsWith("/.gitignore"))
    )
      continue;
    const { stdout } = await git(["cat-file", "blob", entry.sha], {
      gitDir: repoPath,
      timeoutMs: 10_000,
      encoding: "buffer",
    });
    rules.push({ path, patterns: stdout.toString("utf8").split(/\r?\n/) });
  }
  return rules;
}

async function workspaceObjectFormat(repoPath: string): Promise<"sha1" | "sha256"> {
  const value = (
    await git(["rev-parse", "--show-object-format"], { gitDir: repoPath, timeoutMs: 10_000 })
  ).stdout.trim();
  if (value !== "sha1" && value !== "sha256")
    throw new CrossoverError("UNAVAILABLE", "Workspace Git object format is unsupported");
  return value;
}

async function changedWorkspacePaths(
  repoPath: string,
  base: string,
  head: string,
): Promise<string[]> {
  const [before, after] = await Promise.all([
    readWorkspaceTree(repoPath, base),
    readWorkspaceTree(repoPath, head),
  ]);
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => {
      const old = before.get(path);
      const next = after.get(path);
      return !old || !next || old.mode !== next.mode || old.sha !== next.sha;
    })
    .sort(comparePath);
}

async function snapshotDelta(
  repoPath: string,
  oldCommit: string,
  newTree: string,
): Promise<{ files: SandboxSnapshotFile[]; delete_paths: string[] }> {
  const [before, after] = await Promise.all([
    readWorkspaceTree(repoPath, oldCommit),
    readWorkspaceTree(repoPath, newTree),
  ]);
  const paths = [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => {
      const old = before.get(path);
      const next = after.get(path);
      return !old || !next || old.mode !== next.mode || old.sha !== next.sha;
    })
    .sort(comparePath);
  const files: SandboxSnapshotFile[] = [];
  const delete_paths: string[] = [];
  let bytes = 0;
  for (const path of paths) {
    const entry = after.get(path);
    if (!entry) {
      delete_paths.push(path);
      continue;
    }
    const { stdout } = await git(["cat-file", "blob", entry.sha], {
      gitDir: repoPath,
      timeoutMs: 10_000,
      encoding: "buffer",
      maxBuffer: MAX_AUTO_SYNC_BYTES + 1024,
    });
    bytes += stdout.length;
    if (stdout.length > 25 * 1024 * 1024 || bytes > MAX_AUTO_SYNC_BYTES)
      throw new CrossoverError("VALIDATION", "Sandbox auto-sync exceeds its size limit", {
        details: { reason: "auto_sync_too_large" },
      });
    files.push({ path, mode: entry.mode, sha: entry.sha, size: stdout.length, content: stdout });
  }
  return { files, delete_paths };
}

function filterSnapshotDelta(
  delta: { files: SandboxSnapshotFile[]; delete_paths: string[] },
  allowedPaths: ReadonlySet<string>,
): { files: SandboxSnapshotFile[]; delete_paths: string[] } {
  return {
    files: delta.files.filter(({ path }) => allowedPaths.has(path)),
    delete_paths: delta.delete_paths.filter((path) => allowedPaths.has(path)),
  };
}

async function createSandboxObjectRepo(
  canonicalRepo: string,
  objectFormat: "sha1" | "sha256",
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "crossover-sandbox-advance-"));
  try {
    await git(
      [
        "init",
        "--quiet",
        "--bare",
        "--template=",
        ...(objectFormat === "sha256" ? ["--object-format=sha256"] : []),
        dir,
      ],
      { timeoutMs: 10_000, env: { GIT_CONFIG_GLOBAL: "/dev/null" } },
    );
    const objectPath = (
      await git(["rev-parse", "--git-path", "objects"], {
        gitDir: canonicalRepo,
        timeoutMs: 10_000,
      })
    ).stdout.trim();
    const canonicalObjects = isAbsolute(objectPath)
      ? objectPath
      : resolve(canonicalRepo, objectPath);
    await mkdir(join(dir, "objects", "info"), { recursive: true });
    await writeFile(join(dir, "objects", "info", "alternates"), `${canonicalObjects}\n`, {
      mode: 0o600,
    });
    return dir;
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function comparePath(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
