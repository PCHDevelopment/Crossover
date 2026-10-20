import { git, GitError } from "./git.js";
import { concurrentBinaryFiles, enforceBinaryConflicts } from "./binary.js";
import {
  defaultMergeDrivers,
  resolveStructurally,
  type MergeDriver,
  type StructuredMergeRecord,
  type StructuredMergeRefusalRecord,
} from "./merge-drivers.js";

export interface MergeStage {
  mode: string;
  oid: string;
  /** Git's stages: 1 = base, 2 = head, 3 = candidate. */
  stage: 1 | 2 | 3;
}

export interface MergeFile {
  path: string;
  stages: MergeStage[];
}

export interface MergeMessage {
  paths: string[];
  type: string;
  message: string;
}

export type MergeResult =
  | { clean: true; tree: string; structured?: StructuredMergeRecord[] }
  | {
      clean: false;
      tree: string;
      conflicts: { files: MergeFile[]; messages: MergeMessage[] };
      structuredRefusals?: StructuredMergeRefusalRecord[];
    };

function parseConflict(stdout: string): Extract<MergeResult, { clean: false }> {
  const fields = stdout.split("\0");
  let index = 0;
  const take = (): string => {
    const field = fields[index++];
    if (field === undefined)
      throw new GitError("Truncated merge-tree output", 1, "", false, null, undefined, stdout);
    return field;
  };
  const tree = take();
  const malformed = (): never => {
    throw new GitError("Malformed merge-tree output", 1, "", false, null, undefined, stdout);
  };
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(tree)) malformed();
  const files = new Map<string, MergeFile>();
  while (fields[index] !== "") {
    const record = take();
    const match = /^([0-7]{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([123])\t([\s\S]+)$/.exec(record);
    if (!match) malformed();
    const path = match![4]!;
    const file = files.get(path) ?? { path, stages: [] };
    file.stages.push({ mode: match![1]!, oid: match![2]!, stage: Number(match![3]) as 1 | 2 | 3 });
    files.set(path, file);
  }
  take(); // Empty field separates stage entries from informational messages.
  const messages: MergeMessage[] = [];
  while (index < fields.length - 1) {
    const countText = take();
    const count = Number(countText);
    if (
      !/^\d+$/.test(countText) ||
      !Number.isSafeInteger(count) ||
      count > fields.length - index - 2
    )
      malformed();
    const paths = Array.from({ length: count }, take);
    messages.push({ paths, type: take(), message: take() });
  }
  if (take() !== "") malformed();
  return { clean: false, tree, conflicts: { files: [...files.values()], messages } };
}

/** Merge a candidate against head using its explicit base, without updating refs (§10.3). */
export async function merge(
  repo: string,
  base: string,
  head: string,
  candidate: string,
  options: { drivers?: readonly MergeDriver[] } = {},
): Promise<MergeResult> {
  const gitOptions = { gitDir: repo, timeoutMs: 10_000, env: { GIT_CONFIG_GLOBAL: "/dev/null" } };
  // Resolve revisions before building commands, preventing options or moving refs in arguments.
  const [baseOid, headOid, candidateOid] = await Promise.all(
    [base, head, candidate].map(async (revision) =>
      (
        await git(["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`], gitOptions)
      ).stdout.trim(),
    ),
  );
  if (baseOid === headOid) {
    return {
      clean: true,
      tree: (await git(["rev-parse", `${candidateOid}^{tree}`], gitOptions)).stdout.trim(),
    };
  }
  const binaryFiles = await concurrentBinaryFiles(repo, [baseOid!, headOid!, candidateOid!]);
  try {
    const result = await git(
      [
        "merge-tree",
        "--write-tree",
        "-z",
        "--messages",
        `--merge-base=${baseOid}`,
        headOid!,
        candidateOid!,
      ],
      gitOptions,
    );
    const tree = result.stdout.split("\0")[0]!;
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(tree))
      throw new GitError(
        "Malformed merge-tree output",
        0,
        result.stderr,
        false,
        null,
        undefined,
        result.stdout,
      );
    return enforceBinaryConflicts({ clean: true, tree }, binaryFiles);
  } catch (error) {
    if (
      !(error instanceof GitError) ||
      error.exitCode !== 1 ||
      error.timedOut ||
      error.signal !== null
    )
      throw error;
    const parsed = parseConflict(
      typeof error.stdout === "string" ? error.stdout : error.stdout.toString("utf8"),
    );
    return enforceBinaryConflicts(
      await resolveStructurally(
        repo,
        parsed,
        new Set(binaryFiles.map((file) => file.path)),
        options.drivers ?? defaultMergeDrivers(),
      ),
      binaryFiles,
    );
  }
}
