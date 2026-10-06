import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CrossoverError } from "@crossover/protocol";
import { git, GitError } from "./git.js";
import type { Operation } from "./operations.js";
import { normalizePath } from "./path.js";
import { patchFailure, validatePatch } from "./patch.js";
import { validateIntroducedPaths } from "./ignore.js";
import { validateFileSize } from "./binary.js";

type Entry = { mode: string; sha: string };
type Reason = "exists" | "missing" | "rename_target_exists" | "not_a_file" | "patch_path_mismatch";

function parents(path: string): string[] {
  const parts = path.split("/");
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
}

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
  for (const operation of normalized) {
    if ("content" in operation && operation.content !== undefined)
      validateFileSize(
        operation.type === "rename" ? operation.to : operation.path,
        Buffer.byteLength(operation.content),
      );
  }
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
    const listing = await git(["ls-tree", "-rz", base], options);
    const entries = new Map<string, Entry>();
    for (const record of listing.stdout.split("\0")) {
      if (!record) continue;
      const tab = record.indexOf("\t");
      const [mode, , sha] = record.slice(0, tab).split(" ");
      entries.set(record.slice(tab + 1), { mode: mode!, sha: sha! });
    }
    await validateIntroducedPaths(
      repo,
      entries,
      normalized.flatMap((operation) =>
        operation.type === "create"
          ? [operation.path]
          : operation.type === "rename"
            ? [operation.to]
            : [],
      ),
    );
    const directories = new Map<string, number>();
    const countParents = (path: string, delta: number): void => {
      for (const parent of parents(path)) {
        const count = (directories.get(parent) ?? 0) + delta;
        if (count) directories.set(parent, count);
        else directories.delete(parent);
      }
    };
    for (const path of entries.keys()) countParents(path, 1);
    const setEntry = (path: string, entry: Entry): void => {
      if (!entries.has(path)) countParents(path, 1);
      entries.set(path, entry);
    };
    const deleteEntry = (path: string): void => {
      entries.delete(path);
      countParents(path, -1);
    };
    const requireEntry = (path: string): Entry => entries.get(path) ?? invalid(path, "missing");
    const requireFile = (path: string, entry: Entry): void => {
      if (entry.mode === "160000") invalid(path, "not_a_file");
    };
    const requireVacant = (path: string, reason: Reason): void => {
      // Git trees cannot contain both a file and a directory at the same path.
      if (
        entries.has(path) ||
        directories.has(path) ||
        parents(path).some((parent) => entries.has(parent))
      )
        invalid(path, reason);
    };
    const contents = normalized.filter(
      (operation): operation is Operation & { content: string } =>
        "content" in operation && operation.content !== undefined,
    );
    const blobs = new Map<Operation, string>();
    if (contents.length) {
      const files = contents.map((_, index) => join(dir, `blob-${index}`));
      await Promise.all(
        contents.map((operation, index) => writeFile(files[index]!, operation.content)),
      );
      // Generated temp paths contain no newlines; filters never alter submitted text.
      const hashes = (
        await git(["hash-object", "-w", "--no-filters", "--stdin-paths"], {
          ...options,
          input: files.map((file) => JSON.stringify(file)).join("\n") + "\n",
        })
      ).stdout
        .trim()
        .split("\n");
      contents.forEach((operation, index) => blobs.set(operation, hashes[index]!));
    }
    const stageEntries = async (): Promise<void> => {
      await git(["read-tree", "--empty"], options);
      await git(["update-index", "-z", "--index-info"], {
        ...options,
        input: [...entries]
          .map(([path, entry]) => `${entry.mode} ${entry.sha}\t${path}\0`)
          .join(""),
      });
    };
    for (const operation of normalized) {
      switch (operation.type) {
        case "create":
          requireVacant(operation.path, "exists");
          setEntry(operation.path, { mode: "100644", sha: blobs.get(operation)! });
          break;
        case "modify": {
          const entry = requireEntry(operation.path);
          requireFile(operation.path, entry);
          if (operation.patch !== undefined) {
            await validatePatch(operation.path, operation.patch, options);
            await stageEntries();
            try {
              await git(["apply", "--cached", "--whitespace=nowarn", "--", "-"], {
                ...options,
                input: operation.patch,
              });
            } catch (error) {
              if (!(error instanceof GitError)) throw error;
              patchFailure(operation.path, error);
            }
            // A modify patch may change only its named file, never add/delete/rename paths.
            const listing = await git(["ls-files", "--stage", "-z"], options);
            const patched = new Map<string, Entry>();
            for (const record of listing.stdout.split("\0")) {
              if (!record) continue;
              const tab = record.indexOf("\t");
              const [mode, sha] = record.slice(0, tab).split(" ");
              patched.set(record.slice(tab + 1), { mode: mode!, sha: sha! });
            }
            if (patched.size !== entries.size || !patched.has(operation.path))
              invalid(operation.path, "patch_path_mismatch");
            for (const [path, previous] of entries) {
              const next = patched.get(path);
              if (
                !next ||
                next.mode !== previous.mode ||
                (path !== operation.path && next.sha !== previous.sha)
              )
                invalid(operation.path, "patch_path_mismatch");
            }
            setEntry(operation.path, patched.get(operation.path)!);
          } else {
            setEntry(operation.path, { ...entry, sha: blobs.get(operation)! });
          }
          break;
        }
        case "delete":
          requireEntry(operation.path);
          deleteEntry(operation.path);
          break;
        case "rename": {
          const entry = requireEntry(operation.from);
          if (operation.content !== undefined) requireFile(operation.from, entry);
          requireVacant(operation.to, "rename_target_exists");
          deleteEntry(operation.from);
          setEntry(operation.to, {
            ...entry,
            sha: operation.content === undefined ? entry.sha : blobs.get(operation)!,
          });
          break;
        }
      }
    }
    const touched = new Set(
      normalized.flatMap((operation) =>
        operation.type === "delete"
          ? []
          : [operation.type === "rename" ? operation.to : operation.path],
      ),
    );
    for (const path of touched) {
      const entry = entries.get(path);
      if (entry && entry.mode !== "160000") {
        const size = Number((await git(["cat-file", "-s", entry.sha], options)).stdout.trim());
        validateFileSize(path, size);
      }
    }
    await stageEntries();
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
