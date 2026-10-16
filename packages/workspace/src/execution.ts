import type { Pool } from "@crossover/db";
import { ExecutionCore } from "./execution/core.js";
import type {
  ExecutionDriver,
  ExecutionServiceOptions,
  PendingSandboxExec,
  SandboxAdvanceEvent,
  SandboxExecProcess,
  SandboxExecTermination,
  SandboxRecord,
  SandboxSnapshotEntry,
  SandboxSnapshotFile,
  SandboxSyncResult,
  SandboxWorkingCopyFile,
  SandboxWorkingCopyStatus,
} from "./execution/core.js";
import {
  assertExecReservation as assertExecReservationImpl,
  cancelAllExecs as cancelAllExecsImpl,
  cancelExec as cancelExecImpl,
  cancelParticipantExecs as cancelParticipantExecsImpl,
  pendingExec as pendingExecImpl,
  releaseExecReservation as releaseExecReservationImpl,
  reserveExec as reserveExecImpl,
  startExec as startExecImpl,
} from "./execution/exec.js";
import {
  scheduleCanonicalAdvance as scheduleCanonicalAdvanceImpl,
  scheduleLatestCanonical as scheduleLatestCanonicalImpl,
} from "./execution/canonical-advance.js";
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
  readSnapshotFiles as readSnapshotFilesImpl,
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
      scheduleLatestCanonical: (roomId) => scheduleLatestCanonicalImpl(core, roomId),
      cancelAllExecs: (reason) => cancelAllExecsImpl(core, reason),
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
    return scheduleCanonicalAdvanceImpl(this.core, roomId, revision, skipParticipantId);
  }

  setSandboxEventSink(
    sink: (roomId: string, events: readonly SandboxAdvanceEvent[]) => Promise<void>,
  ): void {
    this.core.sandboxEventSink = sink;
  }

  /** Reserve capacity before the command commits its started event. */
  async reserveExec(
    roomId: string,
    participantId: string,
    execId: string,
    requestedTimeoutMs = 600_000,
  ): Promise<{ sandbox_id: string; timeout_ms: number }> {
    return reserveExecImpl(this.core, roomId, participantId, execId, requestedTimeoutMs);
  }

  /** Check that prepare still owns the slot before committing the started event. */
  assertExecReservation(
    roomId: string,
    participantId: string,
    sandboxId: string,
    execId: string,
  ): void {
    return assertExecReservationImpl(this.core, roomId, participantId, sandboxId, execId);
  }

  /** Read a pending reservation so cancel can find an exec before its private log exists. */
  pendingExec(execId: string): PendingSandboxExec | undefined {
    return pendingExecImpl(this.core, execId);
  }

  /** Release a slot after commit or rollback; consuming it at start makes this a no-op. */
  async releaseExecReservation(execId: string): Promise<void> {
    return releaseExecReservationImpl(this.core, execId);
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
    return startExecImpl(this.core, input);
  }

  async cancelExec(
    roomId: string,
    participantId: string,
    execId: string,
    reason: SandboxExecTermination = "cancelled",
    cancelledBy?: string,
  ): Promise<boolean> {
    return cancelExecImpl(this.core, roomId, participantId, execId, reason, cancelledBy);
  }

  async cancelParticipantExecs(
    roomId: string,
    participantId: string,
    reason: SandboxExecTermination,
  ): Promise<void> {
    return cancelParticipantExecsImpl(this.core, roomId, participantId, reason);
  }

  async cancelAllExecs(reason: SandboxExecTermination): Promise<void> {
    return cancelAllExecsImpl(this.core, reason);
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
  /** Report local file changes against this sandbox's base and the current canonical head. */
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
