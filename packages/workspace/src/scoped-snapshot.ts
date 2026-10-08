import { mkdtemp, rm, writeFile, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "./git.js";

const GIT_TIMEOUT_MS = 30_000;
type SnapshotDirectoryRemover = (
  path: string,
  options: { recursive: true; force: true },
) => Promise<unknown>;

interface BlobEntry {
  mode: string;
  type: "blob" | "commit";
  oid: string;
  path: string;
}

interface TreeNode {
  files: Map<string, BlobEntry>;
  directories: Map<string, TreeNode>;
}

export interface ScopedSnapshotRepository {
  /** A temporary bare repository whose only advertised branch is the filtered snapshot. */
  repo_path: string;
  /** Canonical alternate for unscoped advertisements only; never for negotiation. */
  reference_repository?: string;
  /** Synthetic commit SHA for the filtered tree; the canonical revision remains numeric. */
  commit: string;
  /** Stable digest of the readable path set represented by the snapshot. */
  scope_hash: string;
  /** Remove the temporary repository. */
  dispose(): Promise<void>;
}

/**
 * Create an isolated Git view containing only paths accepted by `canRead` (§14.3, T521).
 * The canonical repository is a temporary alternate while building the filtered tree. The
 * reachable snapshot objects are then packed into this repository so Git upload-pack cannot
 * serve any other canonical object, even when a client requests an arbitrary object ID.
 */
export async function createScopedSnapshotRepository(input: {
  referenceRepository: string;
  canonicalCommit: string;
  revision: number;
  canonicalTimestamp: number;
  canRead(path: string): Promise<boolean>;
  /** Advertisement only: no object negotiation may use an unpacked snapshot. */
  advertisementOnly?: boolean;
}): Promise<ScopedSnapshotRepository> {
  const directory = await mkdtemp(join(tmpdir(), "crossover-sandbox-git-"));
  const repoPath = join(directory, "snapshot.git");
  const env = {
    GIT_ALTERNATE_OBJECT_DIRECTORIES: join(input.referenceRepository, "objects"),
  };

  try {
    const source = await git(["ls-tree", "-r", "-z", "--full-tree", input.canonicalCommit], {
      gitDir: input.referenceRepository,
      timeoutMs: GIT_TIMEOUT_MS,
    });
    const allowed: BlobEntry[] = [];
    for (const record of source.stdout.split("\0").filter(Boolean)) {
      const tab = record.indexOf("\t");
      if (tab < 0) throw new Error("Git returned a malformed tree entry");
      const [mode, type, oid] = record.slice(0, tab).split(" ");
      const path = record.slice(tab + 1);
      if (
        !mode ||
        !oid ||
        !path ||
        (type !== "blob" && type !== "commit") ||
        !/^(100644|100755|120000|160000)$/.test(mode)
      ) {
        throw new Error("Git returned an unsupported tree entry");
      }
      if (await input.canRead(path)) allowed.push({ mode, type, oid, path });
    }

    await git(["init", "--bare", repoPath], { timeoutMs: GIT_TIMEOUT_MS });
    const tree = await writeTree(repoPath, input.referenceRepository, allowed, env);
    const scopeHash = hashSnapshotScope(allowed.map((entry) => entry.path));
    const commitContent = snapshotCommit({
      tree,
      revision: input.revision,
      scopeHash,
      timestamp: input.canonicalTimestamp,
    });
    const { stdout: commit } = await git(["hash-object", "-w", "-t", "commit", "--stdin"], {
      gitDir: repoPath,
      timeoutMs: GIT_TIMEOUT_MS,
      env,
      input: commitContent,
    });
    const syntheticCommit = commit.trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(syntheticCommit))
      throw new Error("Git returned an invalid scoped snapshot commit");
    await git(["update-ref", "refs/heads/main", syntheticCommit], {
      gitDir: repoPath,
      timeoutMs: GIT_TIMEOUT_MS,
    });
    if (!input.advertisementOnly)
      await git(["pack-objects", "--revs", join(repoPath, "objects", "pack", "snapshot")], {
        gitDir: repoPath,
        timeoutMs: GIT_TIMEOUT_MS,
        env,
        input: `${syntheticCommit}\n`,
      });

    return {
      repo_path: repoPath,
      commit: syntheticCommit,
      scope_hash: scopeHash,
      dispose: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Expose an unscoped canonical commit under a clone-friendly ref without rewriting its SHA. */
export async function createUnscopedSnapshotRepository(input: {
  referenceRepository: string;
  canonicalCommit: string;
  advertisementOnly?: boolean;
}): Promise<ScopedSnapshotRepository> {
  const directory = await mkdtemp(join(tmpdir(), "crossover-sandbox-git-"));
  const repoPath = join(directory, "snapshot.git");
  const env = {
    GIT_ALTERNATE_OBJECT_DIRECTORIES: join(input.referenceRepository, "objects"),
  };
  try {
    await git(["init", "--bare", repoPath], { timeoutMs: GIT_TIMEOUT_MS });
    await git(["update-ref", "refs/heads/main", input.canonicalCommit], {
      gitDir: repoPath,
      timeoutMs: GIT_TIMEOUT_MS,
      env,
    });
    await git(["symbolic-ref", "HEAD", "refs/heads/main"], {
      gitDir: repoPath,
      timeoutMs: GIT_TIMEOUT_MS,
    });
    // The boundary keeps the real head SHA while excluding all parent commits and their blobs.
    await writeFile(join(repoPath, "shallow"), `${input.canonicalCommit}\n`);
    if (!input.advertisementOnly)
      await git(["pack-objects", "--revs", join(repoPath, "objects", "pack", "snapshot")], {
        gitDir: repoPath,
        timeoutMs: GIT_TIMEOUT_MS,
        env,
        input: `${input.canonicalCommit}\n`,
      });
    return {
      repo_path: repoPath,
      ...(input.advertisementOnly ? { reference_repository: input.referenceRepository } : {}),
      commit: input.canonicalCommit,
      scope_hash: "unscoped",
      dispose: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Remove abandoned snapshots on startup; a day of grace avoids touching live fetches. */
export async function sweepSnapshotRepositories(
  root = tmpdir(),
  now = Date.now(),
  onError: (error: unknown) => void = (error) =>
    console.error("[workspace] snapshot cleanup failed", error),
  removeDirectory: SnapshotDirectoryRemover = rm,
): Promise<void> {
  const report = (error: unknown) => {
    try {
      onError(error);
    } catch (reportError) {
      console.error("[workspace] snapshot cleanup error reporter failed", reportError);
    }
  };

  let entries: Array<{ isDirectory(): boolean; name: string }>;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    report(error);
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("crossover-sandbox-git-")) continue;
    const directory = join(root, entry.name);
    try {
      if ((await stat(directory)).mtimeMs < now - 24 * 60 * 60 * 1000)
        await removeDirectory(directory, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") report(error);
    }
  }
}

async function writeTree(
  repoPath: string,
  referenceRepository: string,
  entries: readonly BlobEntry[],
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const root = treeNode();
  for (const entry of entries) {
    const segments = entry.path.split("/");
    let current = root;
    for (const segment of segments.slice(0, -1)) {
      let child = current.directories.get(segment);
      if (!child) {
        child = treeNode();
        current.directories.set(segment, child);
      }
      current = child;
    }
    current.files.set(segments.at(-1)!, entry);
  }

  const write = async (node: TreeNode): Promise<string> => {
    const lines: string[] = [];
    for (const [name, entry] of node.files)
      lines.push(`${entry.mode} ${entry.type} ${entry.oid}\t${name}\0`);
    for (const [name, child] of node.directories)
      lines.push(`040000 tree ${await write(child)}\t${name}\0`);
    const { stdout } = await git(["mktree", "-z", "--missing"], {
      gitDir: repoPath,
      timeoutMs: GIT_TIMEOUT_MS,
      env,
      input: lines.join(""),
    });
    const oid = stdout.trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid))
      throw new Error("Git returned an invalid scoped tree");
    return oid;
  };
  return write(root);
}

function treeNode(): TreeNode {
  return { files: new Map(), directories: new Map() };
}

export function hashSnapshotScope(paths: readonly string[]): string {
  return createHash("sha256")
    .update([...paths].sort().join("\0"))
    .digest("hex");
}

function snapshotCommit(input: {
  tree: string;
  revision: number;
  scopeHash: string;
  timestamp: number;
}): string {
  const { tree, revision, scopeHash, timestamp } = input;
  if (!Number.isSafeInteger(revision) || revision < 0)
    throw new RangeError("Workspace revision must be a nonnegative safe integer");
  if (!Number.isSafeInteger(timestamp)) throw new RangeError("Invalid canonical commit timestamp");
  if (!/^[a-f0-9]{64}$/.test(scopeHash)) throw new TypeError("Invalid sandbox scope hash");
  return [
    `tree ${tree}`,
    `author Crossover <sandbox@crossover.invalid> ${timestamp} +0000`,
    `committer Crossover <sandbox@crossover.invalid> ${timestamp} +0000`,
    `x-crossover-workspace-revision ${revision}`,
    `x-crossover-scope-sha256 ${scopeHash}`,
    "",
    "Crossover sandbox snapshot",
    "",
  ].join("\n");
}
