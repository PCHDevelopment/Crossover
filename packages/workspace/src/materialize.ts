import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CrossoverError } from "@crossover/protocol";
import { git } from "./git.js";
import type { Operation } from "./operations.js";
import { normalizePath } from "./path.js";

type Entry = { mode: string; sha: string };
type Reason = "exists" | "missing" | "rename_target_exists";

function invalid(path: string, reason: Reason): never {
  throw new CrossoverError("VALIDATION", `Invalid operation on ${path}: ${reason}`, {
    details: { path, reason },
  });
}

/** Build a candidate commit without changing canonical or creating a worktree (§10.3). */
export async function materialize(
  repo: string,
  baseCommit: string,
  operations: readonly Operation[],
): Promise<string> {
  // Normalize all paths before writing any objects; operations then run in order.
  const normalized = operations.map((operation): Operation =>
    operation.type === "rename"
      ? { ...operation, from: normalizePath(operation.from), to: normalizePath(operation.to) }
      : { ...operation, path: normalizePath(operation.path) },
  );
  const dir = await mkdtemp(join(tmpdir(), "crossover-index-"));
  const options = {
    gitDir: repo,
    timeoutMs: 10_000,
    env: { GIT_INDEX_FILE: join(dir, "index") },
  };
  try {
    const base = (
      await git(["rev-parse", "--verify", "--end-of-options", `${baseCommit}^{commit}`], options)
    ).stdout.trim();
    await git(["read-tree", base], options);
    const listing = await git(["ls-tree", "-rz", base], options);
    const entries = new Map<string, Entry>();
    for (const record of listing.stdout.split("\0")) {
      if (!record) continue;
      const tab = record.indexOf("\t");
      const [mode, , sha] = record.slice(0, tab).split(" ");
      entries.set(record.slice(tab + 1), { mode: mode!, sha: sha! });
    }
    const requireEntry = (path: string): Entry => entries.get(path) ?? invalid(path, "missing");
    const requireVacant = (path: string, reason: Reason): void => {
      // Git trees cannot contain both a file and a directory at the same path.
      if (
        [...entries.keys()].some(
          (existing) =>
            existing === path || existing.startsWith(`${path}/`) || path.startsWith(`${existing}/`),
        )
      )
        invalid(path, reason);
    };
    const blob = async (content: string): Promise<string> =>
      (await git(["hash-object", "-w", "--stdin"], { ...options, input: content })).stdout.trim();
    for (const operation of normalized) {
      switch (operation.type) {
        case "create":
          requireVacant(operation.path, "exists");
          entries.set(operation.path, { mode: "100644", sha: await blob(operation.content) });
          break;
        case "modify": {
          const entry = requireEntry(operation.path);
          entries.set(operation.path, { ...entry, sha: await blob(operation.content) });
          break;
        }
        case "delete":
          requireEntry(operation.path);
          entries.delete(operation.path);
          break;
        case "rename": {
          const entry = requireEntry(operation.from);
          requireVacant(operation.to, "rename_target_exists");
          entries.delete(operation.from);
          entries.set(operation.to, {
            ...entry,
            sha: operation.content === undefined ? entry.sha : await blob(operation.content),
          });
          break;
        }
      }
    }
    await git(["read-tree", "--empty"], options);
    await git(["update-index", "-z", "--index-info"], {
      ...options,
      input: [...entries].map(([path, entry]) => `${entry.mode} ${entry.sha}\t${path}\0`).join(""),
    });
    const tree = (await git(["write-tree"], options)).stdout.trim();
    return (
      await git(["commit-tree", tree, "-p", base], {
        ...options,
        input: "Materialize workspace operations\n",
        env: {
          ...options.env,
          GIT_AUTHOR_NAME: "Crossover",
          GIT_AUTHOR_EMAIL: "system@crossover.local",
          GIT_COMMITTER_NAME: "Crossover",
          GIT_COMMITTER_EMAIL: "system@crossover.local",
        },
      })
    ).stdout.trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
