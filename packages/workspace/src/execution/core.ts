import type { Pool } from "@crossover/db";
import { withTransaction } from "@crossover/db";
import type { EditIntent } from "@crossover/kernel";
import { CrossoverError } from "@crossover/protocol";
import { SandboxComputeBudgetMeter } from "../sandbox-compute-budget.js";
import { SandboxComputeSweeper } from "../sandbox-compute-sweeper.js";
import type { SandboxFileChanges } from "../sandbox-status.js";

export const SANDBOX_IDLE_MS = 30 * 60 * 1000;

export const SWEEP_INTERVAL_MS = 60 * 1000;

export const SWEEP_BATCH_SIZE = 100;

export const DESTROY_RETRY_MS = 60 * 1000;

export const HIBERNATION_RECOVERY_MS = 60 * 1000;

export const TRANSITION_POLL_MS = 10;

export const MAX_AUTO_SYNC_BYTES = 64 * 1024 * 1024;

export const SANDBOX_VCPU_COUNT = 2;

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

export interface SandboxCpuUsage {
  /** Cumulative cgroup CPU time, in microseconds. */
  usage_usec: bigint;
  /** Docker container start time; changes when its cgroup counter resets. */
  generation: string;
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

export interface SandboxWorkingCopyFile {
  mode: string;
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
  /** Read one regular file from the working copy without following symlinks. */
  readFile?(input: {
    sandbox_id: string;
    resources: SandboxResources;
    path: string;
    max_bytes: number;
  }): Promise<SandboxWorkingCopyFile>;
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
    files: readonly (Pick<SandboxSnapshotFile, "path" | "mode" | "content"> & {
      preserve_mode?: boolean;
    })[];
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
  cpuUsage?(input: { sandbox_id: string; resources: SandboxResources }): Promise<SandboxCpuUsage>;
  start(input: { sandbox_id: string; resources: SandboxResources }): Promise<void>;
  stop(input: { sandbox_id: string; resources: SandboxResources }): Promise<void>;
  restart?(input: { sandbox_id: string; resources: SandboxResources }): Promise<void>;
  destroy(input: { sandbox_id: string; resources?: SandboxResources }): Promise<void>;
}

export type SandboxRow = SandboxRecord;

export interface PendingSandboxExec {
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
  /** Current room edit intents included in sandbox.behind. */
  listIntents?: (roomId: string) => Promise<EditIntent[]>;
  computeBudgetMeter?: SandboxComputeBudgetMeter;
  now?: () => Date;
}

export interface SandboxAdvanceEvent {
  type: "sandbox.behind" | "sandbox.synced";
  actor_id: "system";
  payload: Record<string, unknown>;
}

export type SandboxSyncResponse =
  | { synced_to: number; conflicted_paths?: string[] }
  | {
      base_revision: number;
      head_revision: number;
      reason: "process_running" | "status_truncated" | "unsupported_local_change";
    };

export interface SandboxSyncResult {
  response: SandboxSyncResponse;
  event?: SandboxAdvanceEvent;
}

let softEnforcementWarningLogged = false;

export interface ExecutionCoreHooks {
  hibernateOne(roomId: string, participantId: string): Promise<boolean>;
  scheduleLatestCanonical(roomId: string): void;
  cancelAllExecs(reason: SandboxExecTermination): Promise<void>;
}

export class ExecutionCore {
  readonly idleMs: number;

  readonly sweepIntervalMs: number;

  readonly diskEnforcement: DiskEnforcementMode;

  readonly now: () => Date;

  readonly computeBudgetMeter: SandboxComputeBudgetMeter;

  readonly computeSweeper: SandboxComputeSweeper;

  sweepTimer: NodeJS.Timeout | undefined;

  readonly ensureLocks = new Map<string, Promise<void>>();

  readonly activeExecs = new Map<
    string,
    { room_id: string; participant_id: string; sandbox_id: string; process: SandboxExecProcess }
  >();

  readonly pendingExecs = new Map<string, PendingSandboxExec>();

  readonly pendingAdvances = new Map<string, number>();

  readonly pendingAdvanceSkips = new Map<string, Map<string, number>>();

  readonly advanceWorkers = new Map<string, Promise<void>>();

  closed = false;

  sandboxEventSink:
    ((roomId: string, events: readonly SandboxAdvanceEvent[]) => Promise<void>) | undefined;

  readonly hooks: ExecutionCoreHooks;

  constructor(
    readonly pool: Pool,
    readonly driver: ExecutionDriver,
    readonly options: ExecutionServiceOptions = {},
    hooks: ExecutionCoreHooks,
  ) {
    this.hooks = hooks;
    this.idleMs = options.idleMs ?? SANDBOX_IDLE_MS;
    this.sweepIntervalMs = options.sweepIntervalMs ?? SWEEP_INTERVAL_MS;
    this.diskEnforcement = options.diskEnforcement ?? "soft";
    this.now = options.now ?? (() => new Date());
    this.computeBudgetMeter =
      options.computeBudgetMeter ?? new SandboxComputeBudgetMeter(pool, this.now);
    this.computeSweeper = new SandboxComputeSweeper({
      pool,
      meter: this.computeBudgetMeter,
      readCpuUsage: this.driver.cpuUsage
        ? (sandbox) =>
            this.driver.cpuUsage!({
              sandbox_id: sandbox.id,
              resources: this.resources(sandbox),
            })
        : undefined,
      hibernate: hooks.hibernateOne,
      now: this.now,
    });
    if (this.diskEnforcement === "soft" && !softEnforcementWarningLogged) {
      console.warn(
        "[execution] SANDBOX_DISK_ENFORCEMENT=soft; Docker quotas are disabled until T1006 adds volume usage checks",
      );
      softEnforcementWarningLogged = true;
    }
  }

  async withEnsureLock<T>(
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

  async workspaceHead(roomId: string): Promise<SandboxWorkspaceHead> {
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

  async recordBaseRevision(id: string, roomId: string, revision: number): Promise<boolean> {
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

  async workspaceRevision(
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

  async canonicalHead(
    roomId: string,
  ): Promise<{ repo_path: string; revision: number; commit_sha: string }> {
    const { rows } = await this.pool.query<{
      repo_path: string;
      revision: string;
      commit_sha: string;
    }>(
      `SELECT w.repo_path, wr.revision, wr.commit_sha
       FROM workspaces w JOIN workspace_revisions wr ON wr.workspace_id = w.id AND wr.room_id = w.room_id
       WHERE w.room_id = $1 ORDER BY wr.revision DESC LIMIT 1`,
      [roomId],
    );
    if (!rows[0]) throw new CrossoverError("NOT_FOUND", "Workspace is not provisioned");
    return { ...rows[0], revision: Number(rows[0].revision) };
  }

  activeCount(sandboxId: string): number {
    let count = 0;
    for (const run of this.activeExecs.values()) if (run.sandbox_id === sandboxId) count++;
    return count;
  }

  resources(sandbox: SandboxRow): SandboxResources {
    if (!sandbox.volume_ref || !sandbox.container_ref)
      throw new Error(`Sandbox ${sandbox.id} is missing its driver references`);
    return { volume_ref: sandbox.volume_ref, container_ref: sandbox.container_ref };
  }
}

export function normalizeSandbox(sandbox: SandboxRow): SandboxRecord {
  return {
    ...sandbox,
    base_revision: sandbox.base_revision === null ? null : Number(sandbox.base_revision),
  };
}
