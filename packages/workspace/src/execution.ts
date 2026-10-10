import type { Pool } from "@crossover/db";
import { withTransaction } from "@crossover/db";
import { CrossoverError, newId } from "@crossover/protocol";
import { ignoredWorkspacePaths } from "./ignore.js";
import { git } from "./git.js";
import { normalizePath } from "./path.js";
import { createSandboxFileChangesAccumulator, type SandboxFileChanges } from "./sandbox-status.js";

const SANDBOX_IDLE_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;
const SWEEP_BATCH_SIZE = 100;
const DESTROY_RETRY_MS = 60 * 1000;
const HIBERNATION_RECOVERY_MS = 60 * 1000;
const TRANSITION_POLL_MS = 10;

export type SandboxStatus =
  "CREATING" | "STARTING" | "RUNNING" | "HIBERNATING" | "HIBERNATED" | "DESTROYING" | "DESTROYED";
export type DiskEnforcementMode = "hard" | "soft";

export interface SandboxLimits {
  disk_enforcement: DiskEnforcementMode;
}

export type SandboxExecTermination = "cancelled" | "timed_out" | "revoked" | "sandbox_stopped";

export interface SandboxExecOutcome {
  exit_code: number | null;
  duration_ms: number;
  reason: "exit" | SandboxExecTermination | "start_failed" | "output_failed";
}

export interface SandboxExecProcess {
  finished: Promise<SandboxExecOutcome>;
  cancel(reason: SandboxExecTermination): Promise<void>;
  /** Set when a reserved exec was cancelled before its driver process could start. */
  cancelled_by?: string;
}

export interface SandboxRecord {
  id: string;
  room_id: string;
  participant_id: string;
  status: SandboxStatus;
  limits: SandboxLimits;
  base_revision: number | null;
  volume_ref: string | null;
  container_ref: string | null;
  last_active_at: Date;
  updated_at: Date;
}

export interface SandboxResources {
  volume_ref: string;
  container_ref: string;
}

export interface SandboxWorkspaceHead {
  repo_path: string;
  revision: number;
}

export interface SandboxWorkingCopyStatus extends SandboxFileChanges {
  base_revision: number;
  head_revision: number;
  behind_by: number;
}

/** A no-follow inventory entry read directly from the sandbox volume. `sha` is null if new. */
export interface SandboxSnapshotEntry {
  path: string;
  mode: string;
  sha: string | null;
  size: number;
}

/** File bytes from the same mode/hash/size observed during snapshot inventory. */
export interface SandboxSnapshotFile extends SandboxSnapshotEntry {
  sha: string;
  content: Buffer;
}

export interface ExecutionDriver {
  /**
   * Every operation is repeatable by sandbox ID: create adopts deterministic existing resources;
   * start and stop converge to their target state; destroy tolerates already-removed resources.
   */
  create(input: {
    sandbox_id: string;
    room_id: string;
    participant_id: string;
    limits: SandboxLimits;
  }): Promise<SandboxResources>;
  /** Fetch the canonical head into the stopped sandbox volume through the private Git network. */
  materialize?(input: {
    sandbox_id: string;
    room_id: string;
    participant_id: string;
    resources: SandboxResources;
    workspace: SandboxWorkspaceHead;
  }): Promise<void>;
  status(input: { sandbox_id: string; resources: SandboxResources }): Promise<SandboxFileChanges>;
  /** Hash tracked files and enumerate paths without consulting any sandbox Git metadata. */
  snapshotInventory?(input: {
    sandbox_id: string;
    resources: SandboxResources;
    tracked_paths: readonly string[];
    object_format: "sha1" | "sha256";
    ignore_rules?: { path: string; patterns: string[] }[];
  }): Promise<SandboxSnapshotEntry[]>;
  /** Read only selected files, refusing a path that changed since inventory. */
  readSnapshotFiles?(input: {
    sandbox_id: string;
    resources: SandboxResources;
    files: readonly SandboxSnapshotEntry[];
    object_format: "sha1" | "sha256";
    max_bytes: number;
  }): Promise<SandboxSnapshotFile[]>;
  /** Apply a server-computed rebase delta without following any path from the sandbox. */
  updateSnapshot?(input: {
    sandbox_id: string;
    resources: SandboxResources;
    files: readonly Pick<SandboxSnapshotFile, "path" | "mode" | "content">[];
    delete_paths: readonly string[];
  }): Promise<void>;
  exec?(input: {
    sandbox_id: string;
    resources: SandboxResources;
    exec_id: string;
    command: string;
    cwd: string;
    timeoutMs: number;
    onOutput: (stream: "stdout" | "stderr", chunk: Buffer) => Promise<void>;
  }): Promise<SandboxExecProcess>;
  start(input: { sandbox_id: string; resources: SandboxResources }): Promise<void>;
  stop(input: { sandbox_id: string; resources: SandboxResources }): Promise<void>;
  restart?(input: { sandbox_id: string; resources: SandboxResources }): Promise<void>;
  destroy(input: { sandbox_id: string; resources?: SandboxResources }): Promise<void>;
}

type SandboxRow = SandboxRecord;

interface PendingSandboxExec {
  room_id: string;
  participant_id: string;
  sandbox_id: string;
  cancelled_by?: string;
  reason?: SandboxExecTermination;
}

export interface ExecutionServiceOptions {
  idleMs?: number;
  sweepIntervalMs?: number;
  diskEnforcement?: DiskEnforcementMode;
  /** Test seam for a failure after Docker resources exist but before their refs are persisted. */
  afterDriverCreate?: (sandbox: SandboxRecord) => Promise<void>;
  /** Canonical paths readable by the participant whose own status is being reported. */
  readablePaths?: (
    roomId: string,
    participantId: string,
    paths: readonly string[],
  ) => Promise<string[]>;
}

let softEnforcementWarningLogged = false;

/** Persists per-participant sandbox ownership and manages its container lifecycle. */
export class ExecutionService {
  private readonly idleMs: number;
  private readonly sweepIntervalMs: number;
  private readonly diskEnforcement: DiskEnforcementMode;
  private sweepTimer: NodeJS.Timeout | undefined;
  private readonly ensureLocks = new Map<string, Promise<void>>();
  private readonly activeExecs = new Map<
    string,
    { room_id: string; participant_id: string; sandbox_id: string; process: SandboxExecProcess }
  >();
  private readonly pendingExecs = new Map<string, PendingSandboxExec>();

  constructor(
    private readonly pool: Pool,
    private readonly driver: ExecutionDriver,
    private readonly options: ExecutionServiceOptions = {},
  ) {
    this.idleMs = options.idleMs ?? SANDBOX_IDLE_MS;
    this.sweepIntervalMs = options.sweepIntervalMs ?? SWEEP_INTERVAL_MS;
    this.diskEnforcement = options.diskEnforcement ?? "soft";
    if (this.diskEnforcement === "soft" && !softEnforcementWarningLogged) {
      console.warn(
        "[execution] SANDBOX_DISK_ENFORCEMENT=soft; Docker quotas are disabled until T1006 adds volume usage checks",
      );
      softEnforcementWarningLogged = true;
    }
  }

  /** Create lazily, or resume, the one sandbox owned by this room participant. */
  async ensure(roomId: string, participantId: string): Promise<SandboxRecord> {
    return this.withEnsureLock(roomId, participantId, () =>
      this.ensureExclusive(roomId, participantId),
    );
  }

  /** Serialize snapshot preparation with lifecycle transitions, while keeping I/O off SQL locks. */
  async withSandboxLock<T>(
    roomId: string,
    participantId: string,
    work: (sandbox: SandboxRecord) => Promise<T>,
  ): Promise<T> {
    return this.withEnsureLock(roomId, participantId, async () => {
      const sandbox = await this.ensureExclusive(roomId, participantId);
      return work(sandbox);
    });
  }

  supportsSandboxSubmit(): boolean {
    return Boolean(
      this.driver.snapshotInventory && this.driver.readSnapshotFiles && this.driver.updateSnapshot,
    );
  }

  supportsSandboxExec(): boolean {
    return Boolean(this.driver.exec);
  }

  /** Reserve capacity before the command commits its started event. */
  async reserveExec(roomId: string, participantId: string, execId: string): Promise<string> {
    return this.withSandboxLock(roomId, participantId, async (sandbox) => {
      if (!this.driver.exec)
        throw new CrossoverError(
          "UNAVAILABLE",
          "Sandbox execution is not supported by this driver",
        );
      if (this.pendingExecs.has(execId) || this.activeExecs.has(execId))
        throw new CrossoverError("CONFLICT_VERSION", "Sandbox execution id is already reserved");
      this.assertExecCapacityFor(sandbox.id);
      this.pendingExecs.set(execId, {
        room_id: roomId,
        participant_id: participantId,
        sandbox_id: sandbox.id,
      });
      return sandbox.id;
    });
  }

  /** Check that prepare still owns the slot before committing the started event. */
  assertExecReservation(
    roomId: string,
    participantId: string,
    sandboxId: string,
    execId: string,
  ): void {
    const pending = this.pendingExecs.get(execId);
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
    const pending = this.pendingExecs.get(execId);
    return pending ? { ...pending } : undefined;
  }

  /** Release a slot after commit or rollback; consuming it at start makes this a no-op. */
  async releaseExecReservation(execId: string): Promise<void> {
    const pending = this.pendingExecs.get(execId);
    if (!pending) return;
    await this.withEnsureLock(pending.room_id, pending.participant_id, async () => {
      if (this.pendingExecs.get(execId) === pending) this.pendingExecs.delete(execId);
    });
  }

  private assertExecCapacityFor(sandboxId: string): void {
    if (!this.driver.exec)
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
      const pending = this.pendingExecs.get(input.exec_id);
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
        this.pendingExecs.delete(input.exec_id);
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

      const run = this.driver.exec;
      if (!run || !sandbox.volume_ref || !sandbox.container_ref) {
        this.pendingExecs.delete(input.exec_id);
        throw new CrossoverError(
          "UNAVAILABLE",
          "Sandbox execution is not supported by this driver",
        );
      }
      let process: SandboxExecProcess;
      try {
        process = await run.call(this.driver, {
          sandbox_id: sandbox.id,
          resources: this.resources(sandbox),
          exec_id: input.exec_id,
          command: input.command,
          cwd: input.cwd,
          timeoutMs: input.timeoutMs,
          onOutput: input.onOutput,
        });
      } catch (error) {
        this.pendingExecs.delete(input.exec_id);
        throw error;
      }
      this.pendingExecs.delete(input.exec_id);
      this.activeExecs.set(input.exec_id, {
        room_id: input.room_id,
        participant_id: input.participant_id,
        sandbox_id: sandbox.id,
        process,
      });
      void process.finished
        .catch(() => undefined)
        .then(() =>
          this.withEnsureLock(input.room_id, input.participant_id, async () => {
            const active = this.activeExecs.get(input.exec_id);
            if (active?.process === process) this.activeExecs.delete(input.exec_id);
          }),
        )
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
    const pending = this.pendingExecs.get(execId);
    const active = this.activeExecs.get(execId);
    const known = pending ?? active;
    if (!known || known.room_id !== roomId || known.participant_id !== participantId) return false;
    return this.withEnsureLock(roomId, participantId, async () => {
      const stillPending = this.pendingExecs.get(execId);
      if (stillPending?.room_id === roomId && stillPending.participant_id === participantId) {
        stillPending.reason = reason;
        if (cancelledBy !== undefined) stillPending.cancelled_by = cancelledBy;
        return true;
      }
      const stillActive = this.activeExecs.get(execId);
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
    await this.withEnsureLock(roomId, participantId, async () => {
      const sandbox = await this.get(roomId, participantId);
      const active = [...this.activeExecs.values()].filter(
        (run) => run.room_id === roomId && run.participant_id === participantId,
      );
      for (const pending of this.pendingExecs.values())
        if (pending.room_id === roomId && pending.participant_id === participantId)
          pending.reason = reason;
      const cancelling = active.map((run) => run.process.cancel(reason).catch(() => undefined));
      if (reason === "revoked" && sandbox?.status === "RUNNING") {
        const resources = this.resources(sandbox);
        if (this.driver.restart) await this.driver.restart({ sandbox_id: sandbox.id, resources });
        else
          await this.driver
            .stop({ sandbox_id: sandbox.id, resources })
            .then(() => this.driver.start({ sandbox_id: sandbox.id, resources }));
      }
      await Promise.all(cancelling);
      await Promise.all(active.map((run) => run.process.finished.catch(() => undefined)));
    });
  }

  async cancelAllExecs(reason: SandboxExecTermination): Promise<void> {
    for (const pending of this.pendingExecs.values()) pending.reason = reason;
    const active = [...this.activeExecs.values()];
    await Promise.all(active.map((run) => run.process.cancel(reason).catch(() => undefined)));
    await Promise.all(active.map((run) => run.process.finished.catch(() => undefined)));
  }

  private activeCount(sandboxId: string): number {
    let count = 0;
    for (const run of this.activeExecs.values()) if (run.sandbox_id === sandboxId) count++;
    return count;
  }

  private execCount(sandboxId: string): number {
    let count = this.activeCount(sandboxId);
    for (const pending of this.pendingExecs.values()) if (pending.sandbox_id === sandboxId) count++;
    return count;
  }

  async snapshotInventory(
    sandbox: SandboxRecord,
    trackedPaths: readonly string[],
    objectFormat: "sha1" | "sha256",
    ignoreRules: { path: string; patterns: string[] }[] = [],
  ): Promise<SandboxSnapshotEntry[]> {
    if (!this.driver.snapshotInventory || !sandbox.volume_ref || !sandbox.container_ref)
      throw new CrossoverError(
        "UNAVAILABLE",
        "Sandbox snapshot is not supported by this execution driver",
      );
    return this.driver.snapshotInventory({
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
    if (!this.driver.readSnapshotFiles || !sandbox.volume_ref || !sandbox.container_ref)
      throw new CrossoverError(
        "UNAVAILABLE",
        "Sandbox snapshot is not supported by this execution driver",
      );
    return this.driver.readSnapshotFiles({
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
      if (sandbox.base_revision !== expectedBaseRevision)
        throw new CrossoverError(
          "CONFLICT_VERSION",
          "Sandbox base changed; sync before submitting",
        );
      if (!sandbox.volume_ref || !sandbox.container_ref || !this.driver.updateSnapshot)
        throw new CrossoverError("UNAVAILABLE", "Sandbox working copy cannot be advanced");
      if (this.activeCount(sandbox.id) > 0) return "process_running";
      await this.driver.updateSnapshot({
        sandbox_id: sandbox.id,
        resources: { volume_ref: sandbox.volume_ref, container_ref: sandbox.container_ref },
        files,
        delete_paths: deletePaths,
      });
      const { rowCount } = await withTransaction(this.pool, (client) =>
        client.query(
          `UPDATE sandboxes SET base_revision = $4, updated_at = clock_timestamp()
           WHERE id = $1 AND room_id = $2 AND participant_id = $3 AND base_revision = $5`,
          [sandbox.id, roomId, participantId, nextBaseRevision, expectedBaseRevision],
        ),
      );
      if (rowCount !== 1)
        throw new CrossoverError(
          "CONFLICT_VERSION",
          "Sandbox base changed while it was being advanced",
        );
      return "advanced";
    });
  }

  private async withEnsureLock<T>(
    roomId: string,
    participantId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const key = `${roomId}\0${participantId}`;
    const previous = this.ensureLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => (release = resolve));
    this.ensureLocks.set(key, current);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.ensureLocks.get(key) === current) this.ensureLocks.delete(key);
    }
  }

  private async ensureExclusive(roomId: string, participantId: string): Promise<SandboxRecord> {
    let sandbox = await this.getOrCreate(roomId, participantId);
    for (;;) {
      if (sandbox.status === "DESTROYED" || sandbox.status === "DESTROYING")
        throw new CrossoverError("NOT_FOUND", "Participant sandbox has been destroyed");
      if (sandbox.status === "HIBERNATING") {
        await delay(TRANSITION_POLL_MS);
        sandbox = await this.claimForStart(roomId, participantId);
        continue;
      }

      sandbox = await this.claimForStart(roomId, participantId);
      if (sandbox.status === "HIBERNATING") continue;
      if (sandbox.status === "DESTROYED" || sandbox.status === "DESTROYING")
        throw new CrossoverError("NOT_FOUND", "Participant sandbox has been destroyed");

      // Docker calls stay outside DB transactions. Deterministic names let retries adopt
      // resources left by a process crash or a failed database write.
      const resources = await this.driver.create({
        sandbox_id: sandbox.id,
        room_id: roomId,
        participant_id: participantId,
        limits: sandbox.limits,
      });
      await this.options.afterDriverCreate?.(sandbox);

      const starting = await this.recordResources(sandbox.id, roomId, resources);
      if (!starting) {
        await this.throwIfDestroyed(sandbox.id, roomId, resources);
        sandbox = await this.claimForStart(roomId, participantId);
        continue;
      }

      if (sandbox.base_revision === null && this.driver.materialize) {
        const workspace = await this.workspaceHead(roomId);
        await this.driver.materialize({
          sandbox_id: sandbox.id,
          room_id: roomId,
          participant_id: participantId,
          resources,
          workspace,
        });
        const recorded = await this.recordBaseRevision(sandbox.id, roomId, workspace.revision);
        if (!recorded) {
          await this.throwIfDestroyed(sandbox.id, roomId, resources);
          sandbox = await this.claimForStart(roomId, participantId);
          continue;
        }
      }

      // Always start before handing a sandbox back; this also repairs a stale RUNNING row.
      await this.driver.start({ sandbox_id: sandbox.id, resources });
      const running = await this.recordRunning(sandbox.id, roomId, resources);
      if (running) return running;

      await this.throwIfDestroyed(sandbox.id, roomId, resources);
      sandbox = await this.claimForStart(roomId, participantId);
    }
  }

  private async workspaceHead(roomId: string): Promise<SandboxWorkspaceHead> {
    const { rows } = await this.pool.query<{ repo_path: string; revision: string }>(
      `SELECT w.repo_path, wr.revision
       FROM workspaces w
       JOIN workspace_revisions wr ON wr.workspace_id = w.id AND wr.room_id = w.room_id
       WHERE w.room_id = $1
       ORDER BY wr.revision DESC LIMIT 1`,
      [roomId],
    );
    const head = rows[0];
    if (!head) throw new CrossoverError("NOT_FOUND", "Workspace is not provisioned");
    return { repo_path: head.repo_path, revision: Number(head.revision) };
  }

  private async recordBaseRevision(id: string, roomId: string, revision: number): Promise<boolean> {
    return withTransaction(this.pool, async (client) => {
      const { rowCount } = await client.query(
        `UPDATE sandboxes SET base_revision = $3, updated_at = clock_timestamp()
         WHERE id = $1 AND room_id = $2 AND status = 'STARTING' AND base_revision IS NULL`,
        [id, roomId, revision],
      );
      return rowCount === 1;
    });
  }

  /** Look up only by the caller's room and participant identity, never by another sandbox ID. */
  async get(roomId: string, participantId: string): Promise<SandboxRecord | null> {
    const { rows } = await this.pool.query<SandboxRow>(
      `SELECT id, room_id, participant_id, status, limits, base_revision, volume_ref, container_ref,
              last_active_at, updated_at
       FROM sandboxes WHERE room_id = $1 AND participant_id = $2`,
      [roomId, participantId],
    );
    return rows[0] ? normalizeSandbox(rows[0]) : null;
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
      const base = await this.workspaceRevision(roomId, sandbox.base_revision);
      [workspace, changes] = await Promise.all([
        this.workspaceHead(roomId),
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

  private async workspaceRevision(
    roomId: string,
    revision: number,
  ): Promise<{ repo_path: string; commit_sha: string }> {
    const { rows } = await this.pool.query<{ repo_path: string; commit_sha: string }>(
      `SELECT w.repo_path, wr.commit_sha
       FROM workspaces w
       JOIN workspace_revisions wr ON wr.workspace_id = w.id AND wr.room_id = w.room_id
       WHERE w.room_id = $1 AND wr.revision = $2`,
      [roomId, revision],
    );
    if (!rows[0])
      throw new CrossoverError("CONFLICT_VERSION", "Sandbox base revision is unavailable");
    return rows[0];
  }

  private async snapshotChanges(
    sandbox: SandboxRecord,
    repoPath: string,
    baseCommit: string,
  ): Promise<SandboxFileChanges> {
    if (!this.driver.snapshotInventory)
      throw new CrossoverError("UNAVAILABLE", "Sandbox snapshot is not supported by this driver");
    const fullBase = await readWorkspaceTree(repoPath, baseCommit);
    const visiblePaths = this.options.readablePaths
      ? await this.options.readablePaths(sandbox.room_id, sandbox.participant_id, [
          ...fullBase.keys(),
        ])
      : [...fullBase.keys()];
    const visible = new Set(visiblePaths);
    const base = new Map([...fullBase].filter(([path]) => visible.has(path)));
    const ignoreRules = await readWorkspaceIgnoreRules(repoPath, fullBase);
    const objectFormat = (
      await git(["rev-parse", "--show-object-format"], { gitDir: repoPath, timeoutMs: 10_000 })
    ).stdout.trim();
    if (objectFormat !== "sha1" && objectFormat !== "sha256")
      throw new CrossoverError("UNAVAILABLE", "Workspace Git object format is unsupported");
    const inventory = await this.snapshotInventory(
      sandbox,
      [...base.keys()],
      objectFormat,
      ignoreRules,
    );
    const addedPaths = inventory.filter((entry) => !base.has(entry.path)).map(({ path }) => path);
    const ignored = await ignoredWorkspacePaths(repoPath, base, addedPaths);
    const current = new Map(inventory.map((entry) => [entry.path, entry]));
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
      for (const { path } of inventory) {
        if (base.has(path) || ignored.has(path)) continue;
        if (!changes.add("added", path)) break;
      }
    }
    return changes.finish();
  }

  /** Hibernate idle sandboxes; the container stops while its Docker volume is retained. */
  async sweepIdle(now = new Date()): Promise<number> {
    const { rows } = await this.pool.query<Pick<SandboxRow, "room_id" | "participant_id">>(
      `SELECT room_id, participant_id FROM sandboxes
       WHERE status = 'RUNNING' AND last_active_at <= $1
       ORDER BY last_active_at LIMIT $2`,
      [new Date(now.getTime() - this.idleMs), SWEEP_BATCH_SIZE],
    );
    let hibernated = 0;
    for (const row of rows)
      if (await this.hibernateOne(row.room_id, row.participant_id, now)) hibernated++;
    return hibernated;
  }

  /** Retry cleanup for interrupted destroys and owners that have left or archived their room. */
  async sweepCleanup(now = new Date()): Promise<number> {
    const staleBefore = new Date(now.getTime() - DESTROY_RETRY_MS);
    const { rows } = await this.pool.query<Pick<SandboxRow, "room_id" | "participant_id">>(
      `SELECT s.room_id, s.participant_id FROM sandboxes s
       JOIN rooms r ON r.id = s.room_id
       LEFT JOIN participants p ON p.id = s.participant_id AND p.room_id = s.room_id
       WHERE s.status <> 'DESTROYED' AND (
         (s.status = 'DESTROYING' AND s.updated_at <= $1) OR
         p.status = 'REMOVED' OR r.status = 'ARCHIVED'
       )
       ORDER BY s.updated_at LIMIT $2`,
      [staleBefore, SWEEP_BATCH_SIZE],
    );
    let destroyed = 0;
    for (const row of rows) {
      try {
        if (await this.destroyOne(row.room_id, row.participant_id)) destroyed++;
      } catch (error) {
        // Keep processing independent sandboxes; the next sweep retries this DESTROYING row.
        console.error(
          `[execution] sandbox cleanup retry failed for ${row.room_id}/${row.participant_id}`,
          error,
        );
      }
    }
    return destroyed;
  }

  /** Stop every sandbox in a room, optionally limiting the operation to agents (§5). */
  async hibernateRoom(roomId: string, agentsOnly = false): Promise<void> {
    const { rows } = await this.pool.query<Pick<SandboxRow, "participant_id">>(
      `SELECT s.participant_id FROM sandboxes s
       JOIN participants p ON p.id = s.participant_id AND p.room_id = s.room_id
       WHERE s.room_id = $1 AND s.status = 'RUNNING' AND ($2 = false OR p.kind = 'AGENT')`,
      [roomId, agentsOnly],
    );
    for (const row of rows) await this.hibernateOne(roomId, row.participant_id);
  }

  async destroyParticipant(roomId: string, participantId: string): Promise<void> {
    await this.destroyOne(roomId, participantId);
  }

  async destroyRoom(roomId: string): Promise<void> {
    const { rows } = await this.pool.query<Pick<SandboxRow, "participant_id">>(
      "SELECT participant_id FROM sandboxes WHERE room_id = $1 AND status <> 'DESTROYED'",
      [roomId],
    );
    for (const row of rows) await this.destroyOne(roomId, row.participant_id);
  }

  startSweeper(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      void this.sweepIdle().catch((error: unknown) =>
        console.error("[execution] idle sandbox sweep failed", error),
      );
      void this.sweepCleanup().catch((error: unknown) =>
        console.error("[execution] sandbox cleanup sweep failed", error),
      );
    }, this.sweepIntervalMs);
    this.sweepTimer.unref();
  }

  async close(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    await this.cancelAllExecs("sandbox_stopped");
  }

  private async getOrCreate(roomId: string, participantId: string): Promise<SandboxRow> {
    return withTransaction(this.pool, async (client) => {
      const participant = await client.query<{ status: string; room_status: string }>(
        `SELECT p.status, r.status AS room_status FROM participants p
         JOIN rooms r ON r.id = p.room_id
         WHERE p.room_id = $1 AND p.id = $2`,
        [roomId, participantId],
      );
      const found = participant.rows[0];
      if (!found) throw new CrossoverError("NOT_FOUND", "Active sandbox participant not found");
      if (found.status === "PAUSED")
        throw new CrossoverError("PARTICIPANT_PAUSED", "Participant is paused", {
          details: { participant_id: participantId },
        });
      if (found.status !== "ACTIVE")
        throw new CrossoverError("NOT_FOUND", "Active sandbox participant not found");
      if (found.room_status !== "ACTIVE") {
        if (found.room_status === "DELETED")
          throw new CrossoverError("NOT_FOUND", "Room not found");
        throw new CrossoverError(
          "ROOM_PAUSED",
          found.room_status === "ARCHIVED" ? "Room is archived" : "Room is paused",
          { details: { room_status: found.room_status } },
        );
      }

      await client.query(
        `INSERT INTO sandboxes (id, room_id, participant_id, status, limits)
         VALUES ($1, $2, $3, 'CREATING', $4::jsonb)
         ON CONFLICT (room_id, participant_id) DO NOTHING`,
        [
          newId("sandbox"),
          roomId,
          participantId,
          JSON.stringify({ disk_enforcement: this.diskEnforcement }),
        ],
      );
      const { rows } = await client.query<SandboxRow>(
        `SELECT id, room_id, participant_id, status, limits, base_revision, volume_ref, container_ref,
                last_active_at, updated_at
         FROM sandboxes WHERE room_id = $1 AND participant_id = $2 FOR UPDATE`,
        [roomId, participantId],
      );
      const sandbox = rows[0];
      if (!sandbox || sandbox.status === "DESTROYED" || sandbox.status === "DESTROYING")
        throw new CrossoverError("NOT_FOUND", "Participant sandbox has been destroyed");
      return normalizeSandbox(sandbox);
    });
  }

  /** Atomically mark a sandbox active before touching Docker so the sweeper cannot stop it. */
  private async claimForStart(roomId: string, participantId: string): Promise<SandboxRow> {
    return withTransaction(this.pool, async (client) => {
      const { rows } = await client.query<SandboxRow>(
        `SELECT id, room_id, participant_id, status, limits, base_revision, volume_ref, container_ref,
                last_active_at, updated_at
         FROM sandboxes WHERE room_id = $1 AND participant_id = $2 FOR UPDATE`,
        [roomId, participantId],
      );
      const sandbox = rows[0];
      if (!sandbox) throw new CrossoverError("NOT_FOUND", "Participant sandbox has been destroyed");
      const staleHibernate =
        sandbox.status === "HIBERNATING" &&
        Date.now() - sandbox.updated_at.getTime() >= HIBERNATION_RECOVERY_MS;
      if (sandbox.status === "RUNNING" || sandbox.status === "HIBERNATED" || staleHibernate) {
        const updated = await client.query<SandboxRow>(
          `UPDATE sandboxes SET status = 'STARTING', last_active_at = clock_timestamp(),
                                updated_at = clock_timestamp()
           WHERE id = $1 AND room_id = $2
           RETURNING id, room_id, participant_id, status, limits, base_revision, volume_ref, container_ref,
                     last_active_at, updated_at`,
          [sandbox.id, roomId],
        );
        return normalizeSandbox(updated.rows[0]!);
      }
      return normalizeSandbox(sandbox);
    });
  }

  private async recordResources(
    id: string,
    roomId: string,
    resources: SandboxResources,
  ): Promise<boolean> {
    return withTransaction(this.pool, async (client) => {
      const { rowCount } = await client.query(
        `UPDATE sandboxes SET status = 'STARTING', volume_ref = $3, container_ref = $4,
                              last_active_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE id = $1 AND room_id = $2 AND status IN ('CREATING', 'STARTING')`,
        [id, roomId, resources.volume_ref, resources.container_ref],
      );
      return rowCount === 1;
    });
  }

  private async recordRunning(
    id: string,
    roomId: string,
    resources: SandboxResources,
  ): Promise<SandboxRow | null> {
    return withTransaction(this.pool, async (client) => {
      const { rows } = await client.query<SandboxRow>(
        `UPDATE sandboxes SET status = 'RUNNING', volume_ref = $3, container_ref = $4,
                              last_active_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE id = $1 AND room_id = $2 AND status = 'STARTING'
         RETURNING id, room_id, participant_id, status, limits, base_revision, volume_ref, container_ref,
                   last_active_at, updated_at`,
        [id, roomId, resources.volume_ref, resources.container_ref],
      );
      return rows[0] ? normalizeSandbox(rows[0]) : null;
    });
  }

  /** Remove resources created by an ensure call after participant/room cleanup won the race. */
  private async throwIfDestroyed(
    id: string,
    roomId: string,
    resources: SandboxResources,
  ): Promise<void> {
    const { rows } = await this.pool.query<{ status: SandboxStatus }>(
      "SELECT status FROM sandboxes WHERE id = $1 AND room_id = $2",
      [id, roomId],
    );
    const status = rows[0]?.status;
    if (status !== undefined && status !== "DESTROYING" && status !== "DESTROYED") return;

    await this.driver.destroy({ sandbox_id: id, resources });
    throw new CrossoverError("NOT_FOUND", "Participant sandbox has been destroyed");
  }

  private async hibernateOne(
    roomId: string,
    participantId: string,
    idleAtOrBefore?: Date,
  ): Promise<boolean> {
    return this.withEnsureLock(roomId, participantId, async () => {
      const sandbox = await withTransaction(this.pool, async (client) => {
        const { rows } = await client.query<SandboxRow>(
          `SELECT id, room_id, participant_id, status, limits, base_revision, volume_ref, container_ref,
                last_active_at, updated_at
         FROM sandboxes WHERE room_id = $1 AND participant_id = $2 FOR UPDATE`,
          [roomId, participantId],
        );
        const current = rows[0];
        if (!current || current.status !== "RUNNING") return null;
        if (idleAtOrBefore && current.last_active_at > idleAtOrBefore) return null;
        const { rows: claimed } = await client.query<SandboxRow>(
          `UPDATE sandboxes SET status = 'HIBERNATING', updated_at = clock_timestamp()
         WHERE id = $1 AND room_id = $2 AND status = 'RUNNING'
         RETURNING id, room_id, participant_id, status, limits, base_revision, volume_ref, container_ref,
                   last_active_at, updated_at`,
          [current.id, roomId],
        );
        return claimed[0] ?? null;
      });
      if (!sandbox) return false;

      const resources = this.resources(sandbox);
      try {
        await this.cancelSandboxExecs(sandbox.id, "sandbox_stopped", () =>
          this.driver.stop({ sandbox_id: sandbox.id, resources }),
        );
        const rowCount = await withTransaction(this.pool, async (client) => {
          const result = await client.query(
            `UPDATE sandboxes SET status = 'HIBERNATED', updated_at = clock_timestamp()
           WHERE id = $1 AND room_id = $2 AND status = 'HIBERNATING'`,
            [sandbox.id, roomId],
          );
          return result.rowCount;
        });
        return rowCount === 1;
      } catch (error) {
        // Keep future ensures able to heal a container that stopped before this write failed.
        await withTransaction(this.pool, async (client) =>
          client.query(
            `UPDATE sandboxes SET status = 'RUNNING', updated_at = clock_timestamp()
           WHERE id = $1 AND room_id = $2 AND status = 'HIBERNATING'`,
            [sandbox.id, roomId],
          ),
        ).catch((recoveryError: unknown) =>
          console.error("[execution] failed to recover interrupted hibernation", recoveryError),
        );
        throw error;
      }
    });
  }

  private async destroyOne(roomId: string, participantId: string): Promise<boolean> {
    const claim = await withTransaction(this.pool, async (client) => {
      const { rows } = await client.query<SandboxRow>(
        `SELECT id, room_id, participant_id, status, limits, base_revision, volume_ref, container_ref,
                last_active_at, updated_at
         FROM sandboxes WHERE room_id = $1 AND participant_id = $2 FOR UPDATE`,
        [roomId, participantId],
      );
      const current = rows[0];
      if (!current || current.status === "DESTROYED") return null;
      const { rows: claimed } = await client.query<SandboxRow>(
        `UPDATE sandboxes SET status = 'DESTROYING', updated_at = clock_timestamp()
         WHERE id = $1 AND room_id = $2
         RETURNING id, room_id, participant_id, status, limits, base_revision, volume_ref, container_ref,
                   last_active_at, updated_at`,
        [current.id, roomId],
      );
      return claimed[0]
        ? { sandbox: normalizeSandbox(claimed[0]), previousStatus: current.status }
        : null;
    });
    if (!claim) return false;

    const destroy = async (): Promise<boolean> => {
      const sandbox = claim.sandbox;
      await this.cancelSandboxExecs(sandbox.id, "sandbox_stopped", () =>
        this.driver.destroy({
          sandbox_id: sandbox.id,
          ...(sandbox.volume_ref && sandbox.container_ref
            ? { resources: this.resources(sandbox) }
            : {}),
        }),
      );
      await withTransaction(this.pool, async (client) =>
        client.query(
          `UPDATE sandboxes SET status = 'DESTROYED', volume_ref = NULL, container_ref = NULL,
                              updated_at = clock_timestamp()
         WHERE id = $1 AND room_id = $2 AND status = 'DESTROYING'`,
          [sandbox.id, roomId],
        ),
      );
      return true;
    };

    // A create/start transition has not returned a usable sandbox to an exec caller yet. Let
    // cleanup win immediately; the in-flight ensure observes DESTROYING and adopts this cleanup.
    // For a RUNNING sandbox, take the lock after fencing it so an exec or advance that already
    // holds the lock finishes before its process group and volume are destroyed.
    if (claim.previousStatus === "CREATING" || claim.previousStatus === "STARTING")
      return destroy();
    return this.withEnsureLock(roomId, participantId, destroy);
  }

  private async cancelSandboxExecs(
    sandboxId: string,
    reason: SandboxExecTermination,
    terminateSandbox?: () => Promise<void>,
  ): Promise<void> {
    const active = [...this.activeExecs.values()].filter((run) => run.sandbox_id === sandboxId);
    const cancelling = active.map((run) => run.process.cancel(reason).catch(() => undefined));
    await terminateSandbox?.();
    await Promise.all(cancelling);
    await Promise.all(active.map((run) => run.process.finished.catch(() => undefined)));
  }

  private resources(sandbox: SandboxRow): SandboxResources {
    if (!sandbox.volume_ref || !sandbox.container_ref)
      throw new Error(`Sandbox ${sandbox.id} is missing its driver references`);
    return { volume_ref: sandbox.volume_ref, container_ref: sandbox.container_ref };
  }
}

function normalizeSandbox(sandbox: SandboxRow): SandboxRecord {
  return {
    ...sandbox,
    base_revision: sandbox.base_revision === null ? null : Number(sandbox.base_revision),
  };
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
