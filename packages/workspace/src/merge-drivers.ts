import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { blobSizes, readBlobs } from "./blobs.js";
import { git } from "./git.js";
import type { MergeResult } from "./merge.js";

export interface MergeDriverInput {
  path: string;
  base: string;
  head: string;
  candidate: string;
}

export type MergeDriverRefusal =
  | "parse_error"
  | "same_key"
  | "add_add"
  | "delete_modify"
  | "duplicate_key"
  | "unkeyed_change"
  | "reorder"
  | "trailer"
  | "result_parse_error"
  | "verify_mismatch"
  | "not_canonical"
  | "unsupported"
  | "too_large"
  | "driver_error";

export type MergeDriverOutcome =
  { ok: true; content: string } | { ok: false; reason: MergeDriverRefusal };

export interface MergeDriver {
  readonly name: string;
  matches(path: string): boolean;
  merge(input: MergeDriverInput): Promise<MergeDriverOutcome>;
}

export interface StructuredMergeRecord {
  path: string;
  driver: string;
}

export interface StructuredMergeRefusalRecord {
  path: string;
  driver: string | null;
  reason: MergeDriverRefusal | "ineligible" | "no_driver" | "budget" | "not_utf8";
}

export const STRUCTURED_MERGE_MAX_FILES = 20;
export const STRUCTURED_MERGE_FILE_MAX_BYTES = 1024 * 1024;
export const STRUCTURED_MERGE_BUDGET_BYTES = 2 * 1024 * 1024;

let defaultDrivers: readonly MergeDriver[] = Object.freeze([]);

/** Set the process default without retaining a mutable caller-owned array. */
export function setDefaultMergeDrivers(drivers: readonly MergeDriver[]): void {
  defaultDrivers = Object.freeze([...drivers]);
}

export function defaultMergeDrivers(): readonly MergeDriver[] {
  return defaultDrivers;
}

/** Shipped drivers are registered by later tasks. */
export function structuredMergeDrivers(): MergeDriver[] {
  return [];
}

/** Resolve a Git content conflict only when every conflicted path has a safe driver result. */
export async function resolveStructurally(
  repo: string,
  result: Extract<MergeResult, { clean: false }>,
  binaryPaths: ReadonlySet<string>,
  drivers: readonly MergeDriver[],
): Promise<MergeResult> {
  if (drivers.length === 0) return result;
  const files = result.conflicts.files;
  const refuse = (
    path: string,
    driver: string | null,
    reason: StructuredMergeRefusalRecord["reason"],
  ): MergeResult => ({
    ...result,
    structuredRefusals: [{ path, driver, reason }],
  });
  if (files.length === 0) return refuse("", null, "ineligible");
  if (files.length > STRUCTURED_MERGE_MAX_FILES) return refuse(files[0]!.path, null, "budget");

  const paths = new Set(files.map((file) => file.path));
  const contentMessages = new Set<string>();
  for (const message of result.conflicts.messages) {
    if (!message.type.startsWith("CONFLICT")) continue;
    const path = message.paths[0] ?? "";
    if (message.type !== "CONFLICT (contents)" || message.paths.length !== 1 || !paths.has(path))
      return refuse(path, null, "ineligible");
    contentMessages.add(path);
  }

  const eligible: {
    path: string;
    mode: string;
    oids: [string, string, string];
    driver: MergeDriver;
  }[] = [];
  for (const file of files) {
    const stages = [...file.stages].sort((a, b) => a.stage - b.stage);
    if (
      !contentMessages.has(file.path) ||
      binaryPaths.has(file.path) ||
      stages.length !== 3 ||
      stages[0]?.stage !== 1 ||
      stages[1]?.stage !== 2 ||
      stages[2]?.stage !== 3 ||
      !["100644", "100755"].includes(stages[0].mode) ||
      stages.some((stage) => stage.mode !== stages[0]!.mode)
    )
      return refuse(file.path, null, "ineligible");
    let driver: MergeDriver | undefined;
    try {
      driver = drivers.find((candidate) => candidate.matches(file.path));
    } catch (error) {
      console.error("structured merge driver failed", {
        driver: "matches",
        error: error instanceof Error ? error.name : "unknown",
      });
      return refuse(file.path, null, "driver_error");
    }
    if (!driver) return refuse(file.path, null, "no_driver");
    eligible.push({
      path: file.path,
      mode: stages[0].mode,
      oids: [stages[0].oid, stages[1].oid, stages[2].oid],
      driver,
    });
  }

  const oids = eligible.flatMap((file) => file.oids);
  const sizes = await blobSizes(repo, oids);
  let total = 0;
  for (const file of eligible) {
    for (const oid of file.oids) {
      const size = sizes.get(oid);
      if (size === undefined || size > STRUCTURED_MERGE_FILE_MAX_BYTES)
        return refuse(file.path, file.driver.name, "budget");
      total += size;
      if (total > STRUCTURED_MERGE_BUDGET_BYTES)
        return refuse(file.path, file.driver.name, "budget");
    }
  }
  const contents = await readBlobs(repo, oids, sizes);
  const decode = new TextDecoder("utf-8", { fatal: true });
  const outputs: { path: string; mode: string; driver: string; content: string }[] = [];
  for (const file of eligible) {
    let input: [string, string, string];
    try {
      input = file.oids.map((oid) => {
        const bytes = contents.get(oid);
        if (!bytes || bytes.includes(0)) throw new Error("not_utf8");
        return decode.decode(bytes);
      }) as [string, string, string];
    } catch {
      return refuse(file.path, file.driver.name, "not_utf8");
    }
    try {
      const outcome = await file.driver.merge({
        path: file.path,
        base: input[0],
        head: input[1],
        candidate: input[2],
      });
      if (!outcome.ok) return refuse(file.path, file.driver.name, outcome.reason);
      outputs.push({
        path: file.path,
        mode: file.mode,
        driver: file.driver.name,
        content: outcome.content,
      });
    } catch (error) {
      console.error("structured merge driver failed", {
        driver: file.driver.name,
        error: error instanceof Error ? error.name : "unknown",
      });
      return refuse(file.path, file.driver.name, "driver_error");
    }
  }

  const temp = await mkdtemp(join(repo, "crossover-merge-"));
  try {
    const names = outputs.map((_, index) => join(temp, `f${index}`));
    await Promise.all(outputs.map((output, index) => writeFile(names[index]!, output.content)));
    const options = { gitDir: repo, timeoutMs: 10_000 };
    const { stdout } = await git(["hash-object", "-w", "--no-filters", "--stdin-paths"], {
      ...options,
      input: `${names.join("\n")}\n`,
    });
    const hashes = stdout.trimEnd().split("\n");
    if (
      hashes.length !== outputs.length ||
      hashes.some((oid) => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid))
    )
      throw new Error("Malformed hash-object response");
    const env = { GIT_INDEX_FILE: join(temp, "index") };
    await git(["read-tree", result.tree], { ...options, env });
    const records = Buffer.concat(
      outputs.map((output, index) =>
        Buffer.from(`${output.mode} ${hashes[index]}\t${output.path}\0`),
      ),
    );
    await git(["update-index", "-z", "--index-info"], { ...options, env, input: records });
    const tree = (await git(["write-tree"], { ...options, env })).stdout.trim();
    return { clean: true, tree, structured: outputs.map(({ path, driver }) => ({ path, driver })) };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
