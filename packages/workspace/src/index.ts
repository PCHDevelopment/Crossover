export { git, assertGitVersion, GitError } from "./git.js";
export type { GitOptions, GitResult } from "./git.js";
export { normalizePath, PathValidationError } from "./path.js";
export { initRoomRepo } from "./repo.js";
export { materialize } from "./materialize.js";
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
export { workspaceReadParamsSchema, workspaceListParamsSchema } from "./reads.js";
export { workspaceSearchParamsSchema } from "./search.js";
export { workspaceDiffParamsSchema } from "./history.js";
export { updateCanonicalRef, reconcileRef } from "./reconcile.js";
