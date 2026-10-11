import { pathGlobMatch } from "@crossover/policy";
import { GitError, git } from "./git.js";
import { treeChanges } from "./tree-changes.js";

export const DEFAULT_PROTECTED_PATHS = [
  ".github/workflows/**",
  "**/*.pem",
  "**/.env*",
  "infra/prod/**",
] as const;

export type CircuitBreakerReason =
  "mass_delete" | "lines_removed" | "protected_path" | "rejection_streak";

export interface CircuitBreakerAssessment {
  reasons: CircuitBreakerReason[];
  protected_paths: string[];
  deleted_files: number;
  baseline_lines: number;
  removed_lines: number;
}

const LINE_REMOVAL_PERCENT = 30;
const MIN_BASELINE_LINES = 200;
const MASS_DELETE_FILES = 50;

/** Count tracked text lines and deleted lines between two trees, excluding binary blobs. */
async function lineCounts(
  repoPath: string,
  baseCommit: string,
  candidateTree: string,
): Promise<{ baseline: number; removed: number }> {
  let baseline = 0;
  try {
    const { stdout } = await git(["grep", "-I", "-c", "-z", "^", baseCommit], {
      gitDir: repoPath,
      timeoutMs: 60_000,
    });
    const fields = stdout.split("\0");
    for (let i = 1; i < fields.length; i += 2) {
      const count = Number(fields[i]);
      if (Number.isSafeInteger(count) && count > 0) baseline += count;
    }
  } catch (error) {
    // An empty tree has no matches. Any other Git error means the breaker could not be evaluated.
    if (!(error instanceof GitError) || error.exitCode !== 1) throw error;
  }

  if (baseline < MIN_BASELINE_LINES) return { baseline, removed: 0 };

  const { stdout } = await git(
    [
      "diff",
      "--numstat",
      "-z",
      "--no-ext-diff",
      "--no-textconv",
      "--find-renames",
      baseCommit,
      candidateTree,
    ],
    { gitDir: repoPath, timeoutMs: 60_000 },
  );
  let removed = 0;
  for (const row of stdout.split("\0")) {
    if (!row) continue;
    const [added, deleted] = row.split("\t");
    if (added === "-" || deleted === "-") continue;
    const count = Number(deleted);
    if (Number.isSafeInteger(count) && count > 0) removed += count;
  }
  return { baseline, removed };
}

/** Evaluate §22.4 against the exact base and candidate trees before the merge is applied. */
export async function assessCircuitBreaker(input: {
  repoPath: string;
  baseCommit: string;
  candidateTree: string;
  touchedPaths: readonly string[];
  protectedPatterns: readonly string[];
  rejectedRecently: boolean;
}): Promise<CircuitBreakerAssessment> {
  const changed = await treeChanges(input.repoPath, input.baseCommit, input.candidateTree);
  const deletedFiles = changed.filter((entry) => entry.blob === null).length;
  const { baseline, removed } = await lineCounts(
    input.repoPath,
    input.baseCommit,
    input.candidateTree,
  );
  const protectedPaths = [...new Set(input.touchedPaths)]
    .filter((path) => input.protectedPatterns.some((pattern) => pathGlobMatch(pattern, path)))
    .sort();
  const reasons: CircuitBreakerReason[] = [];
  if (deletedFiles > MASS_DELETE_FILES) reasons.push("mass_delete");
  if (baseline >= MIN_BASELINE_LINES && removed * 100 > baseline * LINE_REMOVAL_PERCENT)
    reasons.push("lines_removed");
  if (protectedPaths.length > 0) reasons.push("protected_path");
  if (input.rejectedRecently) reasons.push("rejection_streak");
  return {
    reasons,
    protected_paths: protectedPaths,
    deleted_files: deletedFiles,
    baseline_lines: baseline,
    removed_lines: removed,
  };
}
