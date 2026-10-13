import { withTransaction } from "@crossover/db";
import type { EditIntent } from "@crossover/kernel";
import { CrossoverError } from "@crossover/protocol";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { ignoredWorkspacePaths } from "../ignore.js";
import { git } from "../git.js";
import { materialize } from "../materialize.js";
import { merge } from "../merge.js";
import { normalizePath } from "../path.js";
import { createSandboxFileChangesAccumulator } from "../sandbox-status.js";
import type { SandboxFileChanges } from "../sandbox-status.js";
import type { Operation } from "../operations.js";
import { MAX_AUTO_SYNC_BYTES } from "./core.js";
import type {
  ExecutionCore,
  SandboxAdvanceEvent,
  SandboxRecord,
  SandboxSnapshotEntry,
  SandboxSnapshotFile,
  SandboxSyncResponse,
  SandboxSyncResult,
  SandboxWorkingCopyFile,
  SandboxWorkingCopyStatus,
  SandboxWorkspaceHead,
} from "./core.js";
import { ensure, withSandboxLock } from "./lifecycle.js";

export async function snapshotInventory(
  core: ExecutionCore,
  sandbox: SandboxRecord,
  trackedPaths: readonly string[],
  objectFormat: "sha1" | "sha256",
  ignoreRules: { path: string; patterns: string[] }[] = [],
): Promise<SandboxSnapshotEntry[]> {
  if (!core.driver.snapshotInventory || !sandbox.volume_ref || !sandbox.container_ref)
    throw new CrossoverError(
      "UNAVAILABLE",
      "Sandbox snapshot is not supported by this execution driver",
    );
  return core.driver.snapshotInventory({
    sandbox_id: sandbox.id,
    resources: { volume_ref: sandbox.volume_ref, container_ref: sandbox.container_ref },
    tracked_paths: trackedPaths,
    object_format: objectFormat,
    ignore_rules: ignoreRules,
  });
}

export async function readSnapshotFiles(
  core: ExecutionCore,
  sandbox: SandboxRecord,
  files: readonly SandboxSnapshotEntry[],
  objectFormat: "sha1" | "sha256",
  maxBytes: number,
): Promise<SandboxSnapshotFile[]> {
  if (!core.driver.readSnapshotFiles || !sandbox.volume_ref || !sandbox.container_ref)
    throw new CrossoverError(
      "UNAVAILABLE",
      "Sandbox snapshot is not supported by this execution driver",
    );
  return core.driver.readSnapshotFiles({
    sandbox_id: sandbox.id,
    resources: { volume_ref: sandbox.volume_ref, container_ref: sandbox.container_ref },
    files,
    object_format: objectFormat,
    max_bytes: maxBytes,
  });
}

/** Install a server-computed submit rebase, then move the sandbox base only after the write. */
export async function advanceWorkingCopy(
  core: ExecutionCore,
  roomId: string,
  participantId: string,
  expectedBaseRevision: number,
  nextBaseRevision: number,
  files: readonly Pick<SandboxSnapshotFile, "path" | "mode" | "content">[],
  deletePaths: readonly string[],
): Promise<"advanced" | "process_running"> {
  return withSandboxLock(core, roomId, participantId, async (sandbox) => {
    return advanceWorkingCopyLocked(
      core,
      sandbox,
      expectedBaseRevision,
      nextBaseRevision,
      files,
      deletePaths,
    );
  });
}

/** Rebase a participant's local changes onto the latest canonical head on explicit sync. */
export async function syncWorkingCopy(
  core: ExecutionCore,
  roomId: string,
  participantId: string,
): Promise<SandboxSyncResult> {
  return withSandboxLock(core, roomId, participantId, async (sandbox) => {
    if (sandbox.base_revision === null || !sandbox.volume_ref || !sandbox.container_ref)
      throw new CrossoverError("CONFLICT_VERSION", "Sandbox workspace is not ready");
    const head = await core.canonicalHead(roomId);
    if (sandbox.base_revision > head.revision)
      throw new CrossoverError("CONFLICT_VERSION", "Sandbox base is ahead of the workspace");
    if (sandbox.base_revision === head.revision) return { response: { synced_to: head.revision } };

    const base = await core.workspaceRevision(roomId, sandbox.base_revision);
    const changedPaths = await changedWorkspacePaths(
      base.repo_path,
      base.commit_sha,
      head.commit_sha,
    );
    const visibleChanged = await readablePaths(core, roomId, participantId, changedPaths);
    const working = await snapshotChanges(core, sandbox, base.repo_path, base.commit_sha);
    const localPaths = [...working.modified, ...working.added, ...working.deleted];
    const visibleLocal = await readablePaths(core, roomId, participantId, localPaths);
    const overlaps = visibleChanged.some((path) =>
      visibleLocal.some((local) => pathsOverlap(path, local)),
    );
    const intents = await filteredIntents(core, roomId, participantId);
    const behindPayload = {
      participant_id: participantId,
      behind_by: Math.max(0, head.revision - sandbox.base_revision),
      changed_paths: visibleChanged,
      overlaps_local_changes: overlaps || working.truncated,
      intents,
    };
    const behind = (reason: string): SandboxAdvanceEvent => ({
      type: "sandbox.behind",
      actor_id: "system",
      payload: { ...behindPayload, reason },
    });
    const blocked = (
      reason: Extract<SandboxSyncResponse, { reason: string }>["reason"],
    ): SandboxSyncResult => ({
      response: {
        base_revision: sandbox.base_revision!,
        head_revision: head.revision,
        reason,
      },
      event: behind(reason),
    });

    if (core.activeCount(sandbox.id) > 0) return blocked("process_running");
    if (working.truncated) return blocked("status_truncated");
    if (
      !core.driver.updateSnapshot ||
      !core.driver.snapshotInventory ||
      !core.driver.readSnapshotFiles
    )
      return blocked("unsupported_local_change");

    const rebased = await rebaseHumanWorkingCopy(core, sandbox, base, head, working);
    if (!rebased) return blocked("unsupported_local_change");
    const conflictedPaths = await readablePaths(
      core,
      roomId,
      participantId,
      rebased.conflicted_paths,
    );
    const delta = filterSnapshotDelta(rebased.delta, new Set([...visibleChanged, ...visibleLocal]));
    const advanced = await advanceWorkingCopyLocked(
      core,
      sandbox,
      sandbox.base_revision,
      head.revision,
      delta.files,
      delta.delete_paths,
    );
    if (advanced === "process_running") return blocked("process_running");

    return {
      response: {
        synced_to: head.revision,
        ...(conflictedPaths.length ? { conflicted_paths: conflictedPaths } : {}),
      },
      event: {
        type: "sandbox.synced",
        actor_id: "system",
        payload: {
          participant_id: participantId,
          base_revision: head.revision,
          ...(conflictedPaths.length ? { conflicted_paths: conflictedPaths } : {}),
        },
      },
    };
  });
}

export async function advanceWorkingCopyLocked(
  core: ExecutionCore,
  sandbox: SandboxRecord,
  expectedBaseRevision: number,
  nextBaseRevision: number,
  files: readonly Pick<SandboxSnapshotFile, "path" | "mode" | "content">[],
  deletePaths: readonly string[],
): Promise<"advanced" | "process_running"> {
  if (sandbox.base_revision !== expectedBaseRevision)
    throw new CrossoverError("CONFLICT_VERSION", "Sandbox base changed; sync before submitting");
  if (!sandbox.volume_ref || !sandbox.container_ref || !core.driver.updateSnapshot)
    throw new CrossoverError("UNAVAILABLE", "Sandbox working copy cannot be advanced");
  if (core.activeCount(sandbox.id) > 0) return "process_running";
  await core.driver.updateSnapshot({
    sandbox_id: sandbox.id,
    resources: { volume_ref: sandbox.volume_ref, container_ref: sandbox.container_ref },
    files,
    delete_paths: deletePaths,
  });
  const { rowCount } = await withTransaction(core.pool, (client) =>
    client.query(
      `UPDATE sandboxes SET base_revision = $4, updated_at = clock_timestamp()
         WHERE id = $1 AND room_id = $2 AND participant_id = $3 AND base_revision = $5`,
      [sandbox.id, sandbox.room_id, sandbox.participant_id, nextBaseRevision, expectedBaseRevision],
    ),
  );
  if (rowCount !== 1)
    throw new CrossoverError(
      "CONFLICT_VERSION",
      "Sandbox base changed while it was being advanced",
    );
  return "advanced";
}

export async function rebaseHumanWorkingCopy(
  core: ExecutionCore,
  sandbox: SandboxRecord,
  base: { repo_path: string; commit_sha: string },
  head: { repo_path: string; revision: number; commit_sha: string },
  changes: SandboxFileChanges,
): Promise<
  | {
      delta: { files: SandboxSnapshotFile[]; delete_paths: string[] };
      conflicted_paths: string[];
    }
  | undefined
> {
  if (!core.driver.readSnapshotFiles) return undefined;
  const baseEntries = await readWorkspaceTree(base.repo_path, base.commit_sha);
  const visiblePaths = await readablePaths(core, sandbox.room_id, sandbox.participant_id, [
    ...baseEntries.keys(),
  ]);
  const visible = new Set(visiblePaths);
  const entries = new Map([...baseEntries].filter(([path]) => visible.has(path)));
  const objectFormat = await workspaceObjectFormat(base.repo_path);
  const ignoreRules = await readWorkspaceIgnoreRules(base.repo_path, baseEntries);
  let inventory = await snapshotInventory(
    core,
    sandbox,
    [...entries.keys()],
    objectFormat,
    ignoreRules,
  );
  const newPaths = inventory.filter(({ path }) => !entries.has(path)).map(({ path }) => path);
  if (newPaths.length) {
    inventory = await snapshotInventory(
      core,
      sandbox,
      [...entries.keys(), ...newPaths],
      objectFormat,
      ignoreRules,
    );
  }
  const ignored = await ignoredWorkspacePaths(base.repo_path, baseEntries, newPaths);
  const changePaths = new Set([...changes.modified, ...changes.added, ...changes.deleted]);
  const changedEntries = inventory.filter(({ path, sha }) => changePaths.has(path) && sha !== null);
  const files = await readSnapshotFiles(
    core,
    sandbox,
    changedEntries,
    objectFormat,
    MAX_AUTO_SYNC_BYTES,
  );
  const byPath = new Map(files.map((file) => [file.path, file]));
  const operations: Operation[] = [];
  for (const path of [...changePaths].sort(comparePath)) {
    const entry = inventory.find((candidate) => candidate.path === path);
    if (!entry) {
      operations.push({ type: "delete", path });
      continue;
    }
    if (ignored.has(path)) continue;
    if (entry.mode === "120000") return undefined;
    const file = byPath.get(path);
    if (!file) return undefined;
    operations.push({
      type: entries.has(path) ? "modify" : "create",
      path,
      content: file.content,
    });
  }
  const objectRepo = await createSandboxObjectRepo(base.repo_path, objectFormat);
  try {
    const localCommit = await materialize(objectRepo, base.commit_sha, operations);
    const result = await merge(objectRepo, base.commit_sha, head.commit_sha, localCommit);
    return {
      delta: await snapshotDelta(objectRepo, base.commit_sha, result.tree),
      conflicted_paths: result.clean
        ? []
        : result.conflicts.files.map(({ path }) => path).sort(comparePath),
    };
  } finally {
    await rm(objectRepo, { recursive: true, force: true });
  }
}

export async function readablePaths(
  core: ExecutionCore,
  roomId: string,
  participantId: string,
  paths: readonly string[],
): Promise<string[]> {
  return core.options.readablePaths
    ? core.options.readablePaths(roomId, participantId, paths)
    : [...paths];
}

export async function filteredIntents(
  core: ExecutionCore,
  roomId: string,
  participantId: string,
): Promise<EditIntent[]> {
  const stored = (await core.options.listIntents?.(roomId)) ?? [];
  const visible = new Set(
    await readablePaths(
      core,
      roomId,
      participantId,
      stored.flatMap(({ paths }) => paths),
    ),
  );
  return stored.flatMap((intent) => {
    const paths = intent.paths.filter((path) => visible.has(path));
    if (!paths.length) return [];
    const keep = new Set(paths);
    return [{ ...intent, paths, ranges: intent.ranges.filter(({ path }) => keep.has(path)) }];
  });
}

/** Report local file changes against this sandbox's base and the current canonical head. */
export async function status(
  core: ExecutionCore,
  roomId: string,
  participantId: string,
): Promise<SandboxWorkingCopyStatus> {
  const sandbox = await ensure(core, roomId, participantId);
  if (sandbox.base_revision === null)
    throw new CrossoverError("CONFLICT_VERSION", "Sandbox workspace is not ready");
  if (!sandbox.volume_ref || !sandbox.container_ref)
    throw new CrossoverError("NOT_FOUND", "Sandbox workspace resources are unavailable");

  let workspace: SandboxWorkspaceHead;
  let changes: SandboxFileChanges;
  try {
    const base = await core.workspaceRevision(roomId, sandbox.base_revision);
    [workspace, changes] = await Promise.all([
      core.workspaceHead(roomId),
      snapshotChanges(core, sandbox, base.repo_path, base.commit_sha),
    ]);
  } catch (cause) {
    if (cause instanceof CrossoverError) throw cause;
    throw new CrossoverError("UNAVAILABLE", "Sandbox status could not be read; retry the request", {
      cause,
    });
  }
  return {
    base_revision: sandbox.base_revision,
    head_revision: workspace.revision,
    behind_by: Math.max(0, workspace.revision - sandbox.base_revision),
    ...changes,
  };
}

/** Read a single file from the caller's live working copy without following symlinks. */
export async function readWorkingCopyFile(
  core: ExecutionCore,
  roomId: string,
  participantId: string,
  path: string,
  maxBytes: number,
): Promise<SandboxWorkingCopyFile> {
  return withSandboxLock(core, roomId, participantId, async (sandbox) => {
    if (!sandbox.volume_ref || !sandbox.container_ref)
      throw new CrossoverError("NOT_FOUND", "Sandbox workspace resources are unavailable");
    if (!core.driver.readFile)
      throw new CrossoverError(
        "UNAVAILABLE",
        "Sandbox file reads are not supported by this driver",
      );
    try {
      const file = await core.driver.readFile({
        sandbox_id: sandbox.id,
        resources: { volume_ref: sandbox.volume_ref, container_ref: sandbox.container_ref },
        path,
        max_bytes: maxBytes,
      });
      if (file.content.length > maxBytes)
        throw new CrossoverError("VALIDATION", "Sandbox file exceeds the read limit", {
          details: { reason: "file_too_large", size: file.content.length, limit: maxBytes },
        });
      return file;
    } catch (cause) {
      if (cause instanceof CrossoverError) throw cause;
      throw new CrossoverError("UNAVAILABLE", "Sandbox file could not be read; retry the request", {
        cause,
      });
    }
  });
}

/** Replace one regular file using the snapshot installer's no-follow path handling. */
export async function writeWorkingCopyFile(
  core: ExecutionCore,
  roomId: string,
  participantId: string,
  path: string,
  content: Buffer,
): Promise<void> {
  await withSandboxLock(core, roomId, participantId, async (sandbox) => {
    if (!sandbox.volume_ref || !sandbox.container_ref)
      throw new CrossoverError("NOT_FOUND", "Sandbox workspace resources are unavailable");
    if (!core.driver.updateSnapshot)
      throw new CrossoverError(
        "UNAVAILABLE",
        "Sandbox file writes are not supported by this driver",
      );
    try {
      await core.driver.updateSnapshot({
        sandbox_id: sandbox.id,
        resources: { volume_ref: sandbox.volume_ref, container_ref: sandbox.container_ref },
        files: [{ path, mode: "100644", content, preserve_mode: true }],
        delete_paths: [],
      });
    } catch (cause) {
      if (cause instanceof CrossoverError) throw cause;
      throw new CrossoverError(
        "UNAVAILABLE",
        "Sandbox file could not be written; retry the request",
        { cause },
      );
    }
  });
}

export async function snapshotChanges(
  core: ExecutionCore,
  sandbox: SandboxRecord,
  repoPath: string,
  baseCommit: string,
): Promise<SandboxFileChanges> {
  if (!core.driver.snapshotInventory)
    throw new CrossoverError("UNAVAILABLE", "Sandbox snapshot is not supported by this driver");
  const fullBase = await readWorkspaceTree(repoPath, baseCommit);
  const visiblePaths = core.options.readablePaths
    ? await core.options.readablePaths(sandbox.room_id, sandbox.participant_id, [
        ...fullBase.keys(),
      ])
    : [...fullBase.keys()];
  const visible = new Set(visiblePaths);
  const base = new Map([...fullBase].filter(([path]) => visible.has(path)));
  const ignoreRules = await readWorkspaceIgnoreRules(repoPath, fullBase);
  const objectFormat = await workspaceObjectFormat(repoPath);
  const inventory = await snapshotInventory(
    core,
    sandbox,
    [...base.keys()],
    objectFormat,
    ignoreRules,
  );
  const inventoryPaths = await readablePaths(
    core,
    sandbox.room_id,
    sandbox.participant_id,
    inventory.map(({ path }) => path),
  );
  const visibleInventory = new Set(inventoryPaths);
  const currentInventory = inventory.filter(({ path }) => visibleInventory.has(path));
  const addedPaths = currentInventory
    .filter((entry) => !base.has(entry.path))
    .map(({ path }) => path);
  const ignored = await ignoredWorkspacePaths(repoPath, fullBase, addedPaths);
  const current = new Map(currentInventory.map((entry) => [entry.path, entry]));
  const changes = createSandboxFileChangesAccumulator();
  let stopped = false;
  for (const [path, previous] of base) {
    if (previous.mode === "160000") continue;
    const entry = current.get(path);
    if (!entry) stopped = !changes.add("deleted", path);
    else if (entry.sha !== previous.sha || entry.mode !== previous.mode)
      stopped = !changes.add("modified", path);
    if (stopped) break;
  }
  if (!stopped) {
    for (const { path } of currentInventory) {
      if (base.has(path) || ignored.has(path)) continue;
      if (!changes.add("added", path)) break;
    }
  }
  return changes.finish();
}

type WorkspaceTreeEntry = { mode: string; sha: string };

async function readWorkspaceTree(
  repoPath: string,
  commit: string,
): Promise<Map<string, WorkspaceTreeEntry>> {
  const { stdout } = await git(["ls-tree", "-r", "-z", "--full-tree", commit], {
    gitDir: repoPath,
    timeoutMs: 60_000,
    maxBuffer: 128 * 1024 * 1024,
  });
  const entries = new Map<string, WorkspaceTreeEntry>();
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

async function readWorkspaceIgnoreRules(
  repoPath: string,
  entries: ReadonlyMap<string, WorkspaceTreeEntry>,
): Promise<{ path: string; patterns: string[] }[]> {
  const rules: { path: string; patterns: string[] }[] = [];
  for (const [path, entry] of entries) {
    if (
      (entry.mode !== "100644" && entry.mode !== "100755") ||
      (path !== ".roomignore" && path !== ".gitignore" && !path.endsWith("/.gitignore"))
    )
      continue;
    const { stdout } = await git(["cat-file", "blob", entry.sha], {
      gitDir: repoPath,
      timeoutMs: 10_000,
      encoding: "buffer",
    });
    rules.push({ path, patterns: stdout.toString("utf8").split(/\r?\n/) });
  }
  return rules;
}

async function workspaceObjectFormat(repoPath: string): Promise<"sha1" | "sha256"> {
  const value = (
    await git(["rev-parse", "--show-object-format"], { gitDir: repoPath, timeoutMs: 10_000 })
  ).stdout.trim();
  if (value !== "sha1" && value !== "sha256")
    throw new CrossoverError("UNAVAILABLE", "Workspace Git object format is unsupported");
  return value;
}

export async function changedWorkspacePaths(
  repoPath: string,
  base: string,
  head: string,
): Promise<string[]> {
  const [before, after] = await Promise.all([
    readWorkspaceTree(repoPath, base),
    readWorkspaceTree(repoPath, head),
  ]);
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => {
      const old = before.get(path);
      const next = after.get(path);
      return !old || !next || old.mode !== next.mode || old.sha !== next.sha;
    })
    .sort(comparePath);
}

export async function snapshotDelta(
  repoPath: string,
  oldCommit: string,
  newTree: string,
): Promise<{ files: SandboxSnapshotFile[]; delete_paths: string[] }> {
  const [before, after] = await Promise.all([
    readWorkspaceTree(repoPath, oldCommit),
    readWorkspaceTree(repoPath, newTree),
  ]);
  const paths = [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => {
      const old = before.get(path);
      const next = after.get(path);
      return !old || !next || old.mode !== next.mode || old.sha !== next.sha;
    })
    .sort(comparePath);
  const files: SandboxSnapshotFile[] = [];
  const delete_paths: string[] = [];
  let bytes = 0;
  for (const path of paths) {
    const entry = after.get(path);
    if (!entry) {
      delete_paths.push(path);
      continue;
    }
    const { stdout } = await git(["cat-file", "blob", entry.sha], {
      gitDir: repoPath,
      timeoutMs: 10_000,
      encoding: "buffer",
      maxBuffer: MAX_AUTO_SYNC_BYTES + 1024,
    });
    bytes += stdout.length;
    if (stdout.length > 25 * 1024 * 1024 || bytes > MAX_AUTO_SYNC_BYTES)
      throw new CrossoverError("VALIDATION", "Sandbox auto-sync exceeds its size limit", {
        details: { reason: "auto_sync_too_large" },
      });
    files.push({ path, mode: entry.mode, sha: entry.sha, size: stdout.length, content: stdout });
  }
  return { files, delete_paths };
}

export function filterSnapshotDelta(
  delta: { files: SandboxSnapshotFile[]; delete_paths: string[] },
  allowedPaths: ReadonlySet<string>,
): { files: SandboxSnapshotFile[]; delete_paths: string[] } {
  return {
    files: delta.files.filter(({ path }) => allowedPaths.has(path)),
    delete_paths: delta.delete_paths.filter((path) => allowedPaths.has(path)),
  };
}

async function createSandboxObjectRepo(
  canonicalRepo: string,
  objectFormat: "sha1" | "sha256",
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "crossover-sandbox-advance-"));
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
        gitDir: canonicalRepo,
        timeoutMs: 10_000,
      })
    ).stdout.trim();
    const canonicalObjects = isAbsolute(objectPath)
      ? objectPath
      : resolve(canonicalRepo, objectPath);
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

export function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function comparePath(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
