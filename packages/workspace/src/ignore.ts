import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CrossoverError } from "@crossover/protocol";
import { git, GitError } from "./git.js";
import { normalizePath } from "./path.js";

/** Validate introduced paths against a base-tree snapshot of §9.3 ignore rules. */
export async function validateIntroducedPaths(
  repo: string,
  entries: ReadonlyMap<string, { mode: string; sha: string }>,
  paths: readonly string[],
): Promise<void> {
  const ignored = await ignoredWorkspacePaths(repo, entries, paths);
  const path = paths.find((candidate) => ignored.has(candidate));
  if (path)
    throw new CrossoverError("VALIDATION", `Ignored workspace path: ${path}`, {
      details: { path, reason: "ignored" },
    });
}

/** Find new paths ignored by rules stored in the canonical base tree, never the working copy. */
export async function ignoredWorkspacePaths(
  repo: string,
  entries: ReadonlyMap<string, { mode: string; sha: string }>,
  paths: readonly string[],
): Promise<ReadonlySet<string>> {
  if (!paths.length) return new Set();
  // Like Git, never follow a symlink named .gitignore (or .roomignore).
  const rules = [...entries].filter(
    ([path, entry]) =>
      (entry.mode === "100644" || entry.mode === "100755") &&
      (path === ".roomignore" || path === ".gitignore" || path.endsWith("/.gitignore")),
  );
  if (!rules.length) return new Set();
  const dir = await mkdtemp(join(tmpdir(), "crossover-ignore-"));
  const options = {
    cwd: dir,
    timeoutMs: 10_000,
    env: { GIT_CONFIG_GLOBAL: "/dev/null" },
  };
  try {
    // No project/global config or templates participate in room ignore evaluation.
    await git(["init", "--quiet", "--template=", dir], options);
    await mkdir(join(dir, ".git", "info"), { recursive: true });
    for (const [path, entry] of rules) {
      const target =
        path === ".roomignore"
          ? join(dir, ".git", "info", "exclude")
          : join(dir, normalizePath(path));
      const { stdout } = await git(["cat-file", "blob", entry.sha], {
        gitDir: repo,
        timeoutMs: 10_000,
        encoding: "buffer",
      });
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, stdout);
    }
    let output: string;
    try {
      output = (
        await git(
          ["-c", "core.excludesFile=/dev/null", "check-ignore", "--no-index", "-z", "--stdin"],
          { ...options, input: paths.join("\0") + "\0" },
        )
      ).stdout;
    } catch (error) {
      // Exit 1 means no path matched. Engine failures must still propagate.
      if (!(error instanceof GitError) || error.exitCode !== 1 || error.timedOut || error.signal)
        throw error;
      return new Set();
    }
    return new Set(output.split("\0").filter(Boolean));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
