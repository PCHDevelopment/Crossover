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
  const [base, head, candidate] = commits;
  if (!base || !head || !candidate) throw new Error("Binary classification needs three commits");
  const options = {
    gitDir: repo,
    timeoutMs: 10_000,
    env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_LITERAL_PATHSPECS: "1" },
  };
  const raw = (stdout: string) => {
    const changes = new Map<
      string,
      { old?: { mode: string; oid: string }; new?: { mode: string; oid: string } }
    >();
    const fields = stdout.split("\0");
    for (let index = 0; index < fields.length - 1;) {
      const header = fields[index++]!;
      const path = fields[index++]!;
      const [oldMode, newMode, oldOid, newOid] = header.slice(1).split(" ");
      if (!path || !oldMode || !newMode || !oldOid || !newOid)
        throw new Error("Malformed git diff-tree raw output");
      const change: { old?: { mode: string; oid: string }; new?: { mode: string; oid: string } } =
        {};
      if (!/^0+$/.test(oldOid)) change.old = { mode: oldMode, oid: oldOid };
      if (!/^0+$/.test(newOid)) change.new = { mode: newMode, oid: newOid };
      changes.set(path, change);
    }
    return changes;
  };
  const candidateChanges = raw(
    (
      await git(
        ["diff-tree", "--raw", "-z", "--no-renames", "-r", "--no-commit-id", base, candidate],
        options,
      )
    ).stdout,
  );
  if (!candidateChanges.size) return [];
  const headChanges = raw(
    (
      await git(
        ["diff-tree", "--raw", "-z", "--no-renames", "-r", "--no-commit-id", base, head],
        options,
      )
    ).stdout,
  );
  const concurrent = [...candidateChanges]
    .flatMap(([path, candidateChange]) => {
      const headChange = headChanges.get(path);
      if (!headChange) return [];
      const stages: MergeStage[] = [];
      if (headChange.old) stages.push({ ...headChange.old, stage: 1 });
      if (headChange.new) stages.push({ ...headChange.new, stage: 2 });
      if (candidateChange.new) stages.push({ ...candidateChange.new, stage: 3 });
      return [{ path, stages }];
    })
    .filter(({ stages }) =>
      stages.some((entry) => entry.mode === "100644" || entry.mode === "100755"),
    );
  if (!concurrent.length) return [];

  const oids = [
    ...new Set(
      concurrent.flatMap(({ stages }) =>
        stages
          .filter((entry) => entry.mode === "100644" || entry.mode === "100755")
          .map((entry) => entry.oid),
      ),
    ),
  ];
  const sizes = (
    await git(["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], {
      ...options,
      input: `${oids.join("\n")}\n`,
    })
  ).stdout
    .trimEnd()
    .split("\n")
    .map((line) => {
      const [oid, type, size] = line.split(" ");
      if (type !== "blob" || !oid || !size || !Number.isSafeInteger(Number(size)))
        throw new Error("Malformed git cat-file batch-check output");
      return { oid, size: Number(size) };
    });
  const binary = new Set(sizes.filter(({ size }) => size > BINARY_SIZE).map(({ oid }) => oid));
  const small = sizes.filter(({ size }) => size <= BINARY_SIZE);
  // Keep each buffered batch under Git's 32 MiB default output limit. Ordinary ChangeSets fit
  // in one invocation; pathological sets are split without loading oversized blobs.
  for (let offset = 0; offset < small.length;) {
    let end = offset;
    let bytes = 0;
    while (end < small.length && (end === offset || bytes + small[end]!.size <= 24 * 1024 * 1024)) {
      bytes += small[end]!.size + 128;
      end++;
    }
    const batch = small.slice(offset, end);
    const { stdout } = await git(["cat-file", "--batch"], {
      ...options,
      input: `${batch.map(({ oid }) => oid).join("\n")}\n`,
      encoding: "buffer",
      maxBuffer: 32 * 1024 * 1024,
    });
    let cursor = 0;
    for (const expected of batch) {
      const newline = stdout.indexOf(0x0a, cursor);
      if (newline < 0) throw new Error("Malformed git cat-file batch output");
      const header = stdout.subarray(cursor, newline).toString("ascii").split(" ");
      const [oid, type, sizeText] = header;
      const size = Number(sizeText);
      const contentStart = newline + 1;
      if (oid !== expected.oid || type !== "blob" || size !== expected.size)
        throw new Error("Unexpected git cat-file batch object");
      if (stdout.subarray(contentStart, contentStart + Math.min(size, 8192)).includes(0))
        binary.add(oid);
      cursor = contentStart + size;
      if (stdout[cursor] !== 0x0a) throw new Error("Malformed git cat-file batch separator");
      cursor++;
    }
    offset = end;
  }
  return concurrent
    .filter(({ stages }) => stages.some((entry) => binary.has(entry.oid)))
    .map(({ path, stages }) => ({ path, stages }));
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
