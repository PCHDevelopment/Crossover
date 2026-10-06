import { git, GitError } from "./git.js";

/** Actual head-to-result changes; renames become deletion and creation (§9.1). */
export async function treeChanges(
  repo: string,
  head: string,
  tree: string,
): Promise<{ path: string; blob: string | null }[]> {
  const { stdout } = await git(
    [
      "diff-tree",
      "--no-commit-id",
      "--raw",
      "-r",
      "-z",
      "--no-renames",
      "--no-abbrev",
      "--no-ext-diff",
      head,
      tree,
    ],
    { gitDir: repo, timeoutMs: 10_000 },
  );
  const fields = stdout.split("\0");
  const result: { path: string; blob: string | null }[] = [];
  for (let i = 0; i < fields.length - 1; i += 2) {
    const match = /^:[0-7]{6} ([0-7]{6}) [a-f0-9]+ ([a-f0-9]+) [AMDT]$/.exec(fields[i]!);
    const path = fields[i + 1];
    if (!match || !path)
      throw new GitError("Malformed diff-tree output", 0, "", false, null, undefined, stdout);
    result.push({ path, blob: match[1] === "000000" ? null : match[2]! });
  }
  return result;
}
