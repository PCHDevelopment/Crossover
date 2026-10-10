import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, resolve, join } from "node:path";
import type { Dispatcher, EmittedEvent, PrepareContext } from "@crossover/kernel";
import { CrossoverError } from "@crossover/protocol";
import { z } from "zod";
import { apply, type ApplyResponse, type WorkspaceCommandDeps } from "./apply.js";
import { changesetParamsSchema, type ChangesetParams } from "./changeset.js";
import type { ExecutionService, SandboxSnapshotEntry, SandboxSnapshotFile } from "./execution.js";
import { git } from "./git.js";
import { ignoredWorkspacePaths } from "./ignore.js";
import { materialize } from "./materialize.js";
import { merge } from "./merge.js";
import { normalizePath } from "./path.js";

const MAX_OPERATIONS = 500;
const MAX_CHANGESET_BYTES = 25 * 1024 * 1024;
const MAX_REBASE_BYTES = 64 * 1024 * 1024;
const MAX_REBASE_PATHS = 10_000;
const pathFilter = z
  .string()
  .refine((value) => !/[?*]/.test(value), "Glob path filters are not supported")
  .transform((value) => {
    const directory = value.endsWith("/");
    const path = normalizePath(directory ? value.slice(0, -1) : value);
    return directory ? `${path}/` : path;
  });

export const changesSubmitParamsSchema = z.strictObject({
  paths: z.array(pathFilter).max(MAX_OPERATIONS).optional(),
  message: z.string().refine((value) => !value.includes("\0"), "Text contains NUL"),
  task_id: z.string().min(1).optional(),
});
type ChangesSubmitParams = z.infer<typeof changesSubmitParamsSchema>;
type TreeEntry = { mode: string; sha: string };
type TreeMap = Map<string, TreeEntry>;
type FileOperation = Extract<ChangesetParams["operations"][number], { path: string }>;

interface PreparedSandboxSubmit {
  base_revision: number;
  base_commit: string;
  repo_path: string;
  object_repo: string;
  snapshot_commit: string;
  all_operations: FileOperation[];
  operations: FileOperation[];
  submitted_paths: ReadonlySet<string>;
  protected_paths: ReadonlySet<string>;
}
export type SandboxSubmitResponse = ApplyResponse & {
  base_revision: number;
  sandbox_advance: "scheduled" | "behind";
};

/** Register `changes.submit` with a raw, bounded sandbox snapshot before the apply transaction. */
export function registerSandboxSubmitCommand(
  dispatcher: Dispatcher,
  execution: ExecutionService,
  deps: WorkspaceCommandDeps = {},
): void {
  dispatcher.registerCommand({
    method: "changes.submit",
    action: "workspace.write",
    perPathAuthorize: true,
    mutating: true,
    params: changesSubmitParamsSchema,
    prepare: async (ctx, params) => prepareSandboxSubmit(ctx, params, execution),
    disposePrepared: async (prepared) => {
      const item = prepared as PreparedSandboxSubmit | undefined;
      if (item) await rm(item.object_repo, { recursive: true, force: true });
    },
    execute: async (
      ctx,
      params,
    ): Promise<{ response: SandboxSubmitResponse; events?: EmittedEvent[] }> => {
      const prepared = ctx.prepared as PreparedSandboxSubmit | undefined;
      if (!prepared) throw new CrossoverError("UNAVAILABLE", "Sandbox snapshot was not prepared");
      const { rows } = await ctx.client.query<{ base_revision: string | null }>(
        `SELECT base_revision FROM sandboxes
         WHERE room_id = $1 AND participant_id = $2 FOR UPDATE`,
        [ctx.room_id, ctx.principal.participant_id],
      );
      if (!rows[0]) throw new CrossoverError("NOT_FOUND", "Participant sandbox was not found");
      if (
        rows[0].base_revision === null ||
        Number(rows[0].base_revision) !== prepared.base_revision
      )
        throw new CrossoverError(
          "CONFLICT_VERSION",
          "Sandbox base changed; sync before submitting",
        );
      let sandboxAdvance: SandboxSubmitResponse["sandbox_advance"] = "behind";
      const changeParams = changesetParamsSchema.parse({
        source: "SANDBOX",
        message: params.message,
        base_workspace_revision: prepared.base_revision,
        base_file_revisions: {},
        operations: prepared.operations,
        ...(params.task_id !== undefined ? { task_id: params.task_id } : {}),
      });
      const reportAdvanceEvent = (
        type: "sandbox.synced" | "sandbox.behind",
        payload: Record<string, unknown>,
      ) =>
        void dispatcher
          .runSystem(ctx.room_id, "changes.submit.advance", async () => ({
            result: undefined,
            events: [{ type, actor_id: "system", payload }],
          }))
          .catch((error: unknown) =>
            console.error("Failed to report sandbox submit advance", error),
          );
      const result = await apply(ctx, changeParams, deps, {
        onApplied: async (applyContext, applied) => {
          const localOperations = prepared.all_operations.filter(
            (operation) => !prepared.submitted_paths.has(operation.path),
          );
          const rebasedTree = await planRebase(prepared, applied.applied_commit, localOperations);
          const behindEvent = async (): Promise<EmittedEvent> => {
            const changedPaths = await changedTreePaths(
              prepared.object_repo,
              prepared.base_commit,
              applied.applied_commit,
            );
            const visible: string[] = [];
            for (const path of changedPaths) {
              try {
                await applyContext.authorize("workspace.read", { path });
                visible.push(path);
              } catch (error) {
                if (!(error instanceof CrossoverError) || error.code !== "FORBIDDEN") throw error;
              }
            }
            return {
              type: "sandbox.behind",
              payload: {
                behind_by: Math.max(0, applied.revision - prepared.base_revision),
                changed_paths: visible,
                overlaps_local_changes: true,
                intents: [],
              },
            };
          };
          if (!rebasedTree.clean) return { events: [await behindEvent()] };
          const delta = await snapshotDelta(
            prepared.object_repo,
            prepared.snapshot_commit,
            rebasedTree.tree,
          );
          if (overwritesOmittedPaths(delta, prepared.protected_paths))
            return { events: [await behindEvent()] };
          sandboxAdvance = "scheduled";
          return {
            afterCommit: () =>
              execution
                .advanceWorkingCopy(
                  ctx.room_id,
                  ctx.principal.participant_id,
                  prepared.base_revision,
                  applied.revision,
                  delta.files,
                  delta.delete_paths,
                )
                .then(
                  () => reportAdvanceEvent("sandbox.synced", { base_revision: applied.revision }),
                  (error: unknown) => {
                    console.error("Sandbox submit applied, but working copy advance failed", error);
                    reportAdvanceEvent("sandbox.behind", {
                      behind_by: Math.max(0, applied.revision - prepared.base_revision),
                      changed_paths: [],
                      overlaps_local_changes: true,
                      intents: [],
                      reason: "advance_failed",
                    });
                  },
                ),
          };
        },
      });
      return {
        response: {
          ...result.response,
          base_revision: prepared.base_revision,
          sandbox_advance: sandboxAdvance,
        },
        ...(result.events ? { events: result.events } : {}),
      };
    },
  });
}

async function prepareSandboxSubmit(
  ctx: PrepareContext,
  params: ChangesSubmitParams,
  execution: ExecutionService,
): Promise<PreparedSandboxSubmit> {
  return execution.withSandboxLock(ctx.room_id, ctx.principal.participant_id, async (sandbox) => {
    if (sandbox.base_revision === null || !sandbox.volume_ref || !sandbox.container_ref)
      throw new CrossoverError("CONFLICT_VERSION", "Sandbox workspace is not ready");
    if (!execution.supportsSandboxSubmit())
      throw new CrossoverError(
        "UNAVAILABLE",
        "Sandbox snapshot is not supported by this execution driver",
      );
    const { rows } = await ctx.pool.query<{ id: string; repo_path: string; commit_sha: string }>(
      `SELECT w.id, w.repo_path, wr.commit_sha
       FROM workspaces w
       JOIN workspace_revisions wr ON wr.workspace_id = w.id AND wr.room_id = w.room_id
       WHERE w.room_id = $1 AND wr.revision = $2`,
      [ctx.room_id, sandbox.base_revision],
    );
    const workspace = rows[0];
    if (!workspace)
      throw new CrossoverError("CONFLICT_VERSION", "Sandbox base revision is unavailable");
    const objectFormat = (
      await git(["rev-parse", "--show-object-format"], {
        gitDir: workspace.repo_path,
        timeoutMs: 10_000,
      })
    ).stdout.trim();
    if (objectFormat !== "sha1" && objectFormat !== "sha256")
      throw new CrossoverError("UNAVAILABLE", "Workspace Git object format is unsupported");
    const baseEntries = await readTree(workspace.repo_path, workspace.commit_sha);
    const ignoreRules = await Promise.all(
      [...baseEntries]
        .filter(
          ([path, entry]) =>
            entry.mode.startsWith("100") &&
            (path === ".roomignore" || path === ".gitignore" || path.endsWith("/.gitignore")),
        )
        .sort(
          ([a], [b]) =>
            Number(b === ".roomignore") - Number(a === ".roomignore") ||
            a.split("/").length - b.split("/").length,
        )
        .map(async ([path, { sha }]) => ({
          path,
          patterns: (
            await git(["cat-file", "blob", sha], {
              gitDir: workspace.repo_path,
              timeoutMs: 10_000,
              encoding: "buffer",
            })
          ).stdout
            .toString("utf8")
            .split(/\r?\n/),
        })),
    );
    const inventory = await execution.snapshotInventory(
      sandbox,
      [...baseEntries.keys()],
      objectFormat,
      ignoreRules,
    );
    const newPaths = inventory
      .filter((entry) => !baseEntries.has(entry.path))
      .map(({ path }) => path);
    const ignored = await ignoredWorkspacePaths(workspace.repo_path, baseEntries, newPaths);
    const changes = diffSnapshot(baseEntries, inventory, ignored);
    if (!changes.length) throw noChanges();
    validateFilters(
      params.paths ?? [],
      changes.map(({ path }) => path),
    );
    const selected = changes.filter(({ path }) => matchesAnyFilter(path, params.paths ?? []));
    if (!selected.length) throw noChanges();
    // Refuse selected links, but let unrelated links remain untouched for a filtered submit.
    // Deleting a selected base symlink is safe because the delete never reads or follows it.
    for (const change of selected) {
      if ((change.entry?.mode === "120000" || change.base?.mode === "120000") && change.entry) {
        throw new CrossoverError(
          "VALIDATION",
          `Cannot submit a symbolic link or change its target: ${change.path}`,
          { details: { path: change.path, reason: "symlink_not_supported" } },
        );
      }
    }
    if (selected.length > MAX_OPERATIONS)
      throw tooLarge("changeset_too_many_operations", MAX_OPERATIONS);
    const selectedBytes = selected.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
    if (selectedBytes > MAX_CHANGESET_BYTES)
      throw tooLarge("changeset_too_large", MAX_CHANGESET_BYTES);
    if (changes.length > MAX_REBASE_PATHS)
      throw tooLarge("sandbox_snapshot_too_many_paths", MAX_REBASE_PATHS);
    const rebaseBytes = changes.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
    if (rebaseBytes > MAX_REBASE_BYTES)
      throw tooLarge("sandbox_snapshot_too_large", MAX_REBASE_BYTES);
    for (const change of changes) {
      if (change.size !== undefined && change.size > 25 * 1024 * 1024)
        throw tooLarge("sandbox_file_too_large", 25 * 1024 * 1024, change.path);
    }
    const selectedPaths = new Set(selected.map(({ path }) => path));
    const excludedSymlinkPaths = new Set(
      changes
        .filter(
          (change) =>
            !selectedPaths.has(change.path) &&
            change.entry !== undefined &&
            (change.entry.mode === "120000" || change.base?.mode === "120000"),
        )
        .map(({ path }) => path),
    );
    const rebaseChanges = changes.filter(
      (change) =>
        selectedPaths.has(change.path) ||
        !change.entry ||
        (change.entry.mode !== "120000" && change.base?.mode !== "120000"),
    );
    const filesToRead = rebaseChanges.flatMap((change) => (change.entry ? [change.entry] : []));
    const fileBytes = await execution.readSnapshotFiles(
      sandbox,
      filesToRead,
      objectFormat,
      MAX_REBASE_BYTES,
    );
    const byPath = new Map(fileBytes.map((file) => [file.path, file]));
    const allOperations = operationsForChanges(rebaseChanges, byPath);
    const submittedPaths = selectedPaths;
    const operations = allOperations.filter((operation) => submittedPaths.has(operation.path));
    const objectRepo = await createObjectRepo(workspace.repo_path, objectFormat);
    try {
      const snapshotCommit = await materialize(objectRepo, workspace.commit_sha, allOperations);
      return {
        base_revision: sandbox.base_revision,
        base_commit: workspace.commit_sha,
        repo_path: workspace.repo_path,
        object_repo: objectRepo,
        snapshot_commit: snapshotCommit,
        all_operations: allOperations,
        operations,
        submitted_paths: submittedPaths,
        protected_paths: new Set([
          ...newPaths.filter((path) => ignored.has(path)),
          ...excludedSymlinkPaths,
        ]),
      };
    } catch (error) {
      await rm(objectRepo, { recursive: true, force: true });
      throw error;
    }
  });
}

function overwritesOmittedPaths(
  delta: { files: readonly { path: string }[]; delete_paths: readonly string[] },
  protectedPaths: ReadonlySet<string>,
): boolean {
  const changed = [...delta.files.map(({ path }) => path), ...delta.delete_paths];
  return [...protectedPaths].some((protectedPath) =>
    changed.some(
      (path) =>
        protectedPath === path ||
        protectedPath.startsWith(`${path}/`) ||
        path.startsWith(`${protectedPath}/`),
    ),
  );
}

interface SnapshotChange {
  path: string;
  entry?: SandboxSnapshotEntry;
  base?: TreeEntry;
  mode?: string;
  size?: number;
}

function diffSnapshot(
  base: TreeMap,
  inventory: readonly SandboxSnapshotEntry[],
  ignored: ReadonlySet<string>,
): SnapshotChange[] {
  const current = new Map(inventory.map((entry) => [entry.path, entry]));
  const changes: SnapshotChange[] = [];
  for (const [path, old] of base) {
    if (old.mode === "160000") continue;
    const entry = current.get(path);
    if (!entry) changes.push({ path, base: old });
    else if (entry.sha !== old.sha || (entry.mode === "120000") !== (old.mode === "120000"))
      changes.push({ path, entry, base: old, mode: entry.mode, size: entry.size });
  }
  for (const entry of inventory) {
    if (!base.has(entry.path) && !ignored.has(entry.path))
      changes.push({ path: entry.path, entry, mode: entry.mode, size: entry.size });
  }
  return changes.sort((left, right) => comparePath(left.path, right.path));
}

function operationsForChanges(
  changes: readonly SnapshotChange[],
  files: ReadonlyMap<string, SandboxSnapshotFile>,
): FileOperation[] {
  const deletes: FileOperation[] = [];
  const writes: FileOperation[] = [];
  for (const change of changes) {
    if (!change.entry) {
      deletes.push({ type: "delete", path: change.path });
      continue;
    }
    const file = files.get(change.path);
    if (!file)
      throw new CrossoverError("UNAVAILABLE", "Sandbox snapshot file bytes are unavailable");
    const content = encodeContent(file.content, file.mode === "120000");
    if (change.base) writes.push({ type: "modify", path: change.path, ...content });
    else writes.push({ type: "create", path: change.path, ...content });
  }
  deletes.sort(
    (left, right) => depth(right.path) - depth(left.path) || comparePath(left.path, right.path),
  );
  writes.sort((left, right) => comparePath(left.path, right.path));
  return [...deletes, ...writes];
}

function encodeContent(
  content: Buffer,
  forceBase64: boolean,
): { content: string; encoding?: "base64" } {
  if (!forceBase64) {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
      if (!text.includes("\0")) return { content: text };
    } catch {
      // Binary data is represented canonically as base64.
    }
  }
  return { content: content.toString("base64"), encoding: "base64" };
}

function validateFilters(filters: readonly string[], changedPaths: readonly string[]): void {
  const unmatched = filters.find(
    (filter) => !changedPaths.some((path) => matchesFilter(path, filter)),
  );
  if (unmatched)
    throw new CrossoverError(
      "VALIDATION",
      `Path filter did not match a changed path: ${unmatched}`,
      {
        details: { reason: "path_not_changed", path: unmatched },
      },
    );
}
function matchesAnyFilter(path: string, filters: readonly string[]): boolean {
  return !filters.length || filters.some((filter) => matchesFilter(path, filter));
}
function matchesFilter(path: string, filter: string): boolean {
  return filter.endsWith("/") ? path.startsWith(filter) : path === filter;
}

const depth = (path: string) => path.split("/").length;
const comparePath = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
async function readTree(repo: string, commit: string): Promise<TreeMap> {
  const { stdout } = await git(["ls-tree", "-r", "-z", "--full-tree", commit], {
    gitDir: repo,
    timeoutMs: 60_000,
    maxBuffer: 128 * 1024 * 1024,
  });
  const entries: TreeMap = new Map();
  for (const record of stdout.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    const [mode, type, sha] = record.slice(0, tab).split(" ");
    const rawPath = record.slice(tab + 1);
    if (!mode || (type !== "blob" && type !== "commit") || !sha || !rawPath)
      throw new CrossoverError("UNAVAILABLE", "Workspace tree is malformed");
    const path = normalizePath(rawPath);
    if (path !== rawPath)
      throw new CrossoverError("VALIDATION", "Workspace contains a non-canonical path");
    entries.set(path, { mode, sha });
  }
  return entries;
}

async function createObjectRepo(repo: string, objectFormat: "sha1" | "sha256"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "crossover-sandbox-submit-"));
  try {
    await git(
      [
        "init",
        "--quiet",
        "--bare",
        "--template=",
        ...(objectFormat === "sha256" ? ["--object-format=sha256"] : []),
        dir,
      ],
      { timeoutMs: 10_000, env: { GIT_CONFIG_GLOBAL: "/dev/null" } },
    );
    const objectPath = (
      await git(["rev-parse", "--git-path", "objects"], {
        gitDir: repo,
        timeoutMs: 10_000,
      })
    ).stdout.trim();
    const canonicalObjects = isAbsolute(objectPath) ? objectPath : resolve(repo, objectPath);
    await mkdir(join(dir, "objects", "info"), { recursive: true });
    await writeFile(join(dir, "objects", "info", "alternates"), `${canonicalObjects}\n`, {
      mode: 0o600,
    });
    return dir;
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}
async function planRebase(
  prepared: PreparedSandboxSubmit,
  appliedCommit: string,
  localOperations: readonly FileOperation[],
): Promise<{ clean: boolean; tree: string }> {
  const localCommit = await materialize(
    prepared.object_repo,
    prepared.base_commit,
    localOperations,
  );
  return merge(prepared.object_repo, prepared.base_commit, appliedCommit, localCommit);
}
async function snapshotDelta(
  repo: string,
  oldCommit: string,
  newTree: string,
): Promise<{ files: SandboxSnapshotFile[]; delete_paths: string[] }> {
  const [oldEntries, newEntries] = await Promise.all([
    readTree(repo, oldCommit),
    readTree(repo, newTree),
  ]);
  const paths = [...new Set([...oldEntries.keys(), ...newEntries.keys()])]
    .filter((path) => {
      const old = oldEntries.get(path);
      const next = newEntries.get(path);
      return !old || !next || old.mode !== next.mode || old.sha !== next.sha;
    })
    .sort(comparePath);
  if (paths.length > MAX_REBASE_PATHS)
    throw tooLarge("sandbox_rebase_too_many_paths", MAX_REBASE_PATHS);
  const files: SandboxSnapshotFile[] = [];
  const delete_paths: string[] = [];
  let totalBytes = 0;
  for (const path of paths) {
    const entry = newEntries.get(path);
    if (!entry) {
      delete_paths.push(path);
      continue;
    }
    const { stdout } = await git(["cat-file", "blob", entry.sha], {
      gitDir: repo,
      timeoutMs: 10_000,
      encoding: "buffer",
      maxBuffer: 25 * 1024 * 1024 + 1024,
    });
    totalBytes += stdout.length;
    if (stdout.length > 25 * 1024 * 1024 || totalBytes > MAX_REBASE_BYTES)
      throw tooLarge("sandbox_rebase_too_large", MAX_REBASE_BYTES);
    files.push({ path, mode: entry.mode, sha: entry.sha, size: stdout.length, content: stdout });
  }
  return { files, delete_paths };
}

async function changedTreePaths(repo: string, base: string, head: string): Promise<string[]> {
  const [baseEntries, headEntries] = await Promise.all([
    readTree(repo, base),
    readTree(repo, head),
  ]);
  return [...new Set([...baseEntries.keys(), ...headEntries.keys()])]
    .filter((path) => {
      const previous = baseEntries.get(path);
      const next = headEntries.get(path);
      return !previous || !next || previous.mode !== next.mode || previous.sha !== next.sha;
    })
    .sort(comparePath);
}

function noChanges(): CrossoverError {
  return new CrossoverError("VALIDATION", "Sandbox working copy has no changes to submit", {
    retryable: false,
    details: { reason: "no_changes" },
  });
}
function tooLarge(reason: string, limit: number, path?: string): CrossoverError {
  return new CrossoverError("VALIDATION", "Sandbox working copy exceeds submission limits", {
    details: { reason, limit, ...(path ? { path } : {}) },
  });
}
