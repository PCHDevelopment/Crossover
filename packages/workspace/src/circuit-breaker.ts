import { pathGlobMatch } from "@crossover/policy";
import { GitError, git } from "./git.js";
import { treeChanges } from "./tree-changes.js";

export { DEFAULT_PROTECTED_PATHS } from "@crossover/protocol";

export type CircuitBreakerReason =
  "mass_delete" | "lines_removed" | "protected_path" | "rejection_streak";

const LINE_REMOVAL_PERCENT = 30;
const MIN_BASELINE_LINES = 200;
const MASS_DELETE_FILES = 50;
const MIN_REMOVED_LINES_TO_CHECK = 60;
const BASELINE_CACHE_LIMIT = 256;
const baselineLineCountCache = new Map<string, number>();

/** Count tracked text lines in an immutable base tree, retaining recent counts per repository. */
async function baselineLineCount(repoPath: string, baseCommit: string): Promise<number> {
  const key = `${repoPath}\0${baseCommit}`;
  const cached = baselineLineCountCache.get(key);
  if (cached !== undefined) return cached;

  let baseline = 0;
  try {
    const { stdout } = await git(["grep", "-I", "-c", "-z", "^", baseCommit], {
      gitDir: repoPath,
      timeoutMs: 60_000,
    });
    const fields = stdout.split("\0");
    for (let i = 1; i < fields.length; i += 2) baseline += Number(fields[i]) || 0;
  } catch (error) {
    // An empty tree has no matches. Any other Git error means the breaker could not be evaluated.
    if (!(error instanceof GitError) || error.exitCode !== 1) throw error;
  }

  baselineLineCountCache.set(key, baseline);
  if (baselineLineCountCache.size > BASELINE_CACHE_LIMIT)
    baselineLineCountCache.delete(baselineLineCountCache.keys().next().value!);
  return baseline;
}

/** Check the removal threshold without scanning the base unless at least 60 lines were removed. */
async function lineRemovalTriggered(
  repoPath: string,
  baseCommit: string,
  candidateTree: string,
): Promise<boolean> {
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
    const count = Number(row.split("\t")[1]);
    if (Number.isSafeInteger(count) && count > 0) removed += count;
  }
  if (removed < MIN_REMOVED_LINES_TO_CHECK) return false;

  const baseline = await baselineLineCount(repoPath, baseCommit);
  return baseline >= MIN_BASELINE_LINES && removed * 100 > baseline * LINE_REMOVAL_PERCENT;
}

/** Evaluate §22.4 against the exact base and candidate trees before the merge is applied. */
export async function assessCircuitBreaker(input: {
  repoPath: string;
  baseCommit: string;
  candidateTree: string;
  touchedPaths: readonly string[];
  protectedPatterns: readonly string[];
  rejectedRecently: boolean;
}): Promise<{ reasons: CircuitBreakerReason[]; protected_paths: string[] }> {
  const changed = await treeChanges(input.repoPath, input.baseCommit, input.candidateTree);
  const deletedFiles = changed.filter((entry) => entry.blob === null).length;
  const linesRemoved = await lineRemovalTriggered(
    input.repoPath,
    input.baseCommit,
    input.candidateTree,
  );
  const protectedPaths = [...new Set(input.touchedPaths)]
    .filter((path) => input.protectedPatterns.some((pattern) => pathGlobMatch(pattern, path)))
    .sort();
  const reasons: CircuitBreakerReason[] = [];
  if (deletedFiles > MASS_DELETE_FILES) reasons.push("mass_delete");
  if (linesRemoved) reasons.push("lines_removed");
  if (protectedPaths.length > 0) reasons.push("protected_path");
  if (input.rejectedRecently) reasons.push("rejection_streak");
  return {
    reasons,
    protected_paths: protectedPaths,
  };
}
