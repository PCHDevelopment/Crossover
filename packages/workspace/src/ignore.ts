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
  const rules: { path: string; content: Buffer }[] = [];
  for (const [path, entry] of entries) {
    if (
      (entry.mode !== "100644" && entry.mode !== "100755") ||
      (path !== ".roomignore" && path !== ".gitignore" && !path.endsWith("/.gitignore"))
    )
      continue;
    const { stdout } = await git(["cat-file", "blob", entry.sha], {
      gitDir: repo,
      timeoutMs: 10_000,
      encoding: "buffer",
    });
    rules.push({ path, content: stdout });
  }
  return checkIgnoredPaths(paths, rules);
}

/** Verify the snapshot helper only pruned directories Git ignores under canonical base rules. */
export async function ignoredPrunedDirectories(
  ignoreRules: readonly { path: string; patterns: string[] }[],
  paths: readonly string[],
): Promise<ReadonlySet<string>> {
  const rules = ignoreRules
    .filter(
      ({ path }) => path === ".roomignore" || path === ".gitignore" || path.endsWith("/.gitignore"),
    )
    .map(({ path, patterns }) => ({ path, content: Buffer.from(patterns.join("\n")) }));
  const ignored = await checkIgnoredPaths(
    paths.map((path) => `${path}/`),
    rules,
  );
  return new Set([...ignored].map((path) => path.slice(0, -1)));
}

async function checkIgnoredPaths(
  paths: readonly string[],
  rules: readonly { path: string; content: Buffer }[],
): Promise<ReadonlySet<string>> {
  if (!paths.length || !rules.length) return new Set();
  const dir = await mkdtemp(join(tmpdir(), "crossover-ignore-"));
  const options = {
    cwd: dir,
    timeoutMs: 10_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { GIT_CONFIG_GLOBAL: "/dev/null" },
  };
  try {
    await git(["init", "--quiet", "--template=", dir], options);
    await mkdir(join(dir, ".git", "info"), { recursive: true });
    for (const { path, content } of rules) {
      const target =
        path === ".roomignore"
          ? join(dir, ".git", "info", "exclude")
          : join(dir, normalizePath(path));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    try {
      const { stdout } = await git(
        ["-c", "core.excludesFile=/dev/null", "check-ignore", "--no-index", "-z", "--stdin"],
        { ...options, input: paths.join("\0") + "\0" },
      );
      return new Set(stdout.split("\0").filter(Boolean));
    } catch (error) {
      if (!(error instanceof GitError) || error.exitCode !== 1 || error.timedOut || error.signal)
        throw error;
      return new Set();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
