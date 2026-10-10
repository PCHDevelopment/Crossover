export { git, assertGitVersion, GitError } from "./git.js";
export type { GitOptions, GitResult } from "./git.js";
export { normalizePath, PathValidationError } from "./path.js";
export { initRoomRepo } from "./repo.js";
export { materialize } from "./materialize.js";
export {
  createScopedSnapshotRepository,
  sweepSnapshotRepositories,
  createUnscopedSnapshotRepository,
  hashSnapshotScope,
} from "./scoped-snapshot.js";
export type { ScopedSnapshotRepository } from "./scoped-snapshot.js";
export type { Operation, ContentEncoding } from "./operations.js";
export { merge } from "./merge.js";
export type { MergeResult, MergeFile, MergeStage, MergeMessage } from "./merge.js";
export { classifyConflicts } from "./conflicts.js";
export type { ConflictKind, ClassifiedConflict } from "./conflicts.js";
export type { ConflictHunk, LineRange } from "./hunks.js";
export { changesetInputSchema, changesetParamsSchema } from "./changeset.js";
export type { ChangesetParams } from "./changeset.js";
export { provisionWorkspace } from "./provision.js";
export { registerWorkspaceCommands } from "./apply.js";
export type { WorkspaceCommandDeps, ApplyResponse } from "./apply.js";
export {
  conflictsGetParamsSchema,
  conflictsListParamsSchema,
  registerWorkspaceConflictReads,
} from "./conflict-reads.js";
export { registerWorkspaceConflictActions } from "./conflict-actions.js";
export {
  ConflictEscalationSweeper,
  sweepConflictEscalations,
} from "./conflict-escalation-sweeper.js";
export type { ConflictEscalationSweeperOptions } from "./conflict-escalation-sweeper.js";
export { workspaceReadParamsSchema, workspaceListParamsSchema } from "./reads.js";
export { workspaceSearchParamsSchema } from "./search.js";
export { workspaceDiffParamsSchema } from "./history.js";
export { updateCanonicalRef, reconcileRef } from "./reconcile.js";
export {
  DEFAULT_HEALTH_LOCKFILE_PATHS,
  DEFAULT_HEALTH_IMAGE,
  DockerHealthRunner,
  hashHealthLockfiles,
  normalizeHealthLockfilePaths,
  runHealthCheck,
  storeHealthRun,
} from "./health-runner.js";
export type {
  HealthRunner,
  HealthRunResult,
  HealthStatus,
  DockerHealthRunnerOptions,
} from "./health-runner.js";
export { HealthCheckQueue } from "./health-queue.js";
export type { HealthCheckQueueOptions } from "./health-queue.js";
export { workspaceHealthGate } from "./health-gate.js";
export { healthGetParamsSchema, publishHealthResult } from "./health-events.js";
export { ExecutionService } from "./execution.js";
export type {
  DiskEnforcementMode,
  ExecutionDriver,
  ExecutionServiceOptions,
  SandboxExecOutcome,
  SandboxExecProcess,
  SandboxExecTermination,
  SandboxLimits,
  SandboxRecord,
  SandboxResources,
  SandboxStatus,
  SandboxWorkspaceHead,
  SandboxSnapshotEntry,
  SandboxSnapshotFile,
  SandboxWorkingCopyFile,
  SandboxSyncResponse,
  SandboxSyncResult,
} from "./execution.js";
export { DockerExecutionDriver } from "./docker-execution-driver.js";
export type {
  DockerExecutionDriverOptions,
  DockerInvocationOptions,
  DockerInvoker,
} from "./docker-execution-driver.js";
export {
  registerSandboxExecCommands,
  sandboxExecParamsSchema,
  sandboxExecCancelParamsSchema,
} from "./sandbox-exec.js";
export type { SandboxExecCommandDeps } from "./sandbox-exec.js";
export {
  registerSandboxFileCommands,
  SANDBOX_FILE_READ_LIMIT_BYTES,
  SANDBOX_FILE_WRITE_LIMIT_BYTES,
  sandboxFileReadParamsSchema,
  sandboxFileWriteInputSchema,
  sandboxFileWriteParamsSchema,
} from "./sandbox-file.js";
export { FileLogStore, MemoryLogStore, SandboxOutputHub } from "./sandbox-log-store.js";
export type {
  LogStore,
  SandboxExecLogMetadata,
  SandboxExecReason,
  SandboxOutputChunk,
  SandboxOutputUpdate,
} from "./sandbox-log-store.js";
export { parsePorcelainStatus, registerSandboxStatusCommand } from "./sandbox-status.js";
export { sandboxStatusParamsSchema } from "./sandbox-status.js";
export type { SandboxFileChanges } from "./sandbox-status.js";
export type { SandboxWorkingCopyStatus } from "./execution.js";
export { registerSandboxSyncCommand, sandboxSyncParamsSchema } from "./sandbox-sync.js";
export { changesSubmitParamsSchema, registerSandboxSubmitCommand } from "./sandbox-submit.js";
export type { SandboxSubmitResponse } from "./sandbox-submit.js";
export * from "./upstream.js";
export * from "./upstream-import.js";
export * from "./health-suggestion.js";
export * from "./checkpoints.js";
export * from "./upstream-pull.js";
export * from "./checkpoint-export.js";
