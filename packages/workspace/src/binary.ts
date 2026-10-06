import { CrossoverError } from "@crossover/protocol";
import { git } from "./git.js";
import type { MergeFile, MergeResult, MergeStage } from "./merge.js";

export const BINARY_SIZE = 5 * 1024 * 1024;
export const MAX_FILE_SIZE = 25 * 1024 * 1024;

export function validateFileSize(path: string, size: number): void {
  if (size > MAX_FILE_SIZE)
    throw new CrossoverError("VALIDATION", `Workspace file too large: ${path}`, {
      details: { path, reason: "file_too_large", size, limit: MAX_FILE_SIZE },
    });
}

/** Size first: imported large blobs need never be loaded to classify them (§9.4). */
export async function readMergeBlob(
  repo: string,
  oid: string,
): Promise<{ binary: boolean; content?: Buffer }> {
  const options = { gitDir: repo, timeoutMs: 10_000 };
  const size = Number((await git(["cat-file", "-s", oid], options)).stdout.trim());
  if (size > BINARY_SIZE) return { binary: true };
  const { stdout } = await git(["cat-file", "blob", oid], { ...options, encoding: "buffer" });
  return { binary: stdout.subarray(0, 8192).includes(0), content: stdout };
}

/** Find concurrently changed binary paths, including identical resulting blobs (§9.4). */
export async function concurrentBinaryFiles(
  repo: string,
  commits: readonly string[],
): Promise<MergeFile[]> {
  const trees = await Promise.all(
    commits.map(async (commit) => {
      const { stdout } = await git(["ls-tree", "-rz", commit], { gitDir: repo, timeoutMs: 10_000 });
      return new Map(
        stdout
          .split("\0")
          .filter(Boolean)
          .map((record) => {
            const tab = record.indexOf("\t");
            const [mode, , oid] = record.slice(0, tab).split(" ");
            return [record.slice(tab + 1), { mode: mode!, oid: oid! }];
          }),
      );
    }),
  );
  const [base, head, candidate] = trees;
  const changed = (a: { oid: string; mode: string } | undefined, b: typeof a) =>
    a?.oid !== b?.oid || a?.mode !== b?.mode;
  const paths = [...new Set(trees.flatMap((tree) => [...tree.keys()]))].filter(
    (path) =>
      changed(base!.get(path), head!.get(path)) && changed(base!.get(path), candidate!.get(path)),
  );
  const files: MergeFile[] = [];
  // Bound Git process fanout when hundreds of paths change concurrently.
  for (let offset = 0; offset < paths.length; offset += 4) {
    const chunk = await Promise.all(
      paths.slice(offset, offset + 4).map(async (path) => {
        const stages: MergeStage[] = trees.flatMap((tree, index) => {
          const entry = tree.get(path);
          return entry ? [{ ...entry, stage: (index + 1) as 1 | 2 | 3 }] : [];
        });
        for (const entry of stages) {
          if (
            (entry.mode === "100644" || entry.mode === "100755") &&
            (await readMergeBlob(repo, entry.oid)).binary
          )
            return { path, stages };
        }
        return undefined;
      }),
    );
    files.push(...chunk.filter((file) => file !== undefined));
  }
  return files;
}

export function enforceBinaryConflicts(result: MergeResult, files: MergeFile[]): MergeResult {
  if (!files.length) return result;
  const previous = result.clean ? { files: [], messages: [] } : result.conflicts;
  const byPath = new Map(previous.files.map((file) => [file.path, file]));
  for (const file of files) byPath.set(file.path, file);
  return {
    clean: false,
    tree: result.tree,
    conflicts: {
      files: [...byPath.values()],
      messages: [
        ...previous.messages,
        ...files.map(({ path }) => ({
          paths: [path],
          type: "CONFLICT (binary)",
          message: `Concurrent binary modifications: ${path}`,
        })),
      ],
    },
  };
}
