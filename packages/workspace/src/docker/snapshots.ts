import { CrossoverError } from "@crossover/protocol";
import { normalizePath } from "../path.js";
import { SANDBOX_SNAPSHOT_HELPER } from "../sandbox-snapshot-helper.js";
import type { SandboxResources, SandboxSnapshotEntry, SandboxSnapshotFile } from "../execution.js";
import { ignoredPrunedDirectories } from "../ignore.js";
import type { DockerModuleContext } from "./context.js";

const MAX_SNAPSHOT_OUTPUT_BYTES = 96 * 1024 * 1024;

export async function runSnapshotHelper(
  ctx: Pick<DockerModuleContext, "image" | "invoke">,
  resources: SandboxResources,
  input: Record<string, unknown>,
  readOnly = true,
): Promise<{
  entries?: unknown[];
  pruned_directories?: unknown[];
  error?: string;
  size?: number;
  limit?: number;
  installed?: boolean;
  file?: unknown;
}> {
  let stdout = "";
  let outputTooLarge = false;
  const result = await ctx.invoke(
    [
      "run",
      "--rm",
      "--init",
      "-i",
      "--network=none",
      "--read-only",
      "--user=1000:1000",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--memory=1g",
      "--cpus=1",
      "--pids-limit=64",
      "--tmpfs",
      "/tmp:rw,nosuid,noexec,size=16m",
      "--env",
      "HOME=/tmp",
      "--mount",
      `type=volume,source=${resources.volume_ref},target=/workspace,${readOnly ? "readonly," : ""}volume-nocopy`,
      "--workdir",
      "/workspace",
      "--entrypoint",
      "node",
      ctx.image,
      "-e",
      SANDBOX_SNAPSHOT_HELPER,
    ],
    {
      timeoutMs: 120_000,
      maxBuffer: 1024 * 1024,
      input: JSON.stringify(input),
      onStdout: (chunk) => {
        if (Buffer.byteLength(stdout) + Buffer.byteLength(chunk) > MAX_SNAPSHOT_OUTPUT_BYTES) {
          outputTooLarge = true;
          return false;
        }
        stdout += chunk;
        return true;
      },
    },
  );
  if (!stdout && result.stdout) stdout = result.stdout;
  if (outputTooLarge)
    throw new CrossoverError("VALIDATION", "Sandbox snapshot exceeds the bounded output limit");
  let payload: {
    entries?: unknown[];
    pruned_directories?: unknown[];
    error?: string;
    size?: number;
    limit?: number;
    installed?: boolean;
    file?: unknown;
  };
  try {
    payload = JSON.parse(stdout) as {
      entries?: unknown[];
      pruned_directories?: unknown[];
      error?: string;
      size?: number;
      limit?: number;
      installed?: boolean;
      file?: unknown;
    };
  } catch {
    throw snapshotUnavailable();
  }
  if (payload.error) {
    if (payload.error === "changed_during_read") throw snapshotChanged();
    if (payload.error === "path_not_found")
      throw new CrossoverError("NOT_FOUND", "Sandbox working-copy file not found");
    if (payload.error === "too_large" && input["action"] === "file_read") {
      const limit =
        typeof payload.limit === "number" && Number.isSafeInteger(payload.limit)
          ? payload.limit
          : Number(input["max_bytes"]);
      const size =
        typeof payload.size === "number" && Number.isSafeInteger(payload.size)
          ? payload.size
          : limit + 1;
      throw new CrossoverError("VALIDATION", "Sandbox file exceeds the read limit", {
        details: { reason: "file_too_large", size, limit },
      });
    }
    if (payload.error === "unsupported_file_type" && input["action"] === "file_read")
      throw new CrossoverError("VALIDATION", "Sandbox path is not a regular file", {
        details: { reason: "not_a_regular_file" },
      });
    if (payload.error.startsWith("invalid_path_encoding:"))
      throw new CrossoverError("VALIDATION", "Sandbox contains an unsupported path encoding", {
        details: {
          reason: "invalid_path_encoding",
          path: payload.error.slice("invalid_path_encoding:".length),
        },
      });
    if (
      [
        "file_too_large",
        "invalid_path",
        "ignore_rules_too_large",
        "scan_too_large",
        "too_large",
        "too_many_entries",
        "too_many_pruned_directories",
        "unsupported_file_type",
      ].includes(payload.error)
    ) {
      throw new CrossoverError("VALIDATION", "Sandbox working copy cannot be submitted", {
        details: { reason: payload.error },
      });
    }
    throw snapshotUnavailable();
  }
  if (result.code !== 0) throw snapshotUnavailable();
  return payload;
}

export function decodeSnapshotPath(encoded: string): string {
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded)
    throw new CrossoverError("VALIDATION", "Sandbox contains an unsupported path encoding");
  let path: string;
  try {
    path = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CrossoverError("VALIDATION", "Sandbox contains an unsupported path encoding");
  }
  if (normalizePath(path) !== path)
    throw new CrossoverError("VALIDATION", "Sandbox contains a non-canonical path");
  return path;
}

export function snapshotChanged(): CrossoverError {
  return new CrossoverError(
    "CONFLICT_VERSION",
    "Sandbox working copy changed while it was being snapshotted; retry the submission",
    { retryable: true, details: { reason: "sandbox_changed_during_snapshot" } },
  );
}

export function snapshotUnavailable(): CrossoverError {
  return new CrossoverError(
    "UNAVAILABLE",
    "Sandbox working copy could not be read; retry the request",
    {
      retryable: true,
    },
  );
}

export function snapshotPruningRetryFailed(path: string, cause: unknown): CrossoverError {
  return new CrossoverError(
    "VALIDATION",
    `Gitignore matcher disagreed for ${path}; unpruned re-inventory failed`,
    { cause, retryable: false, details: { reason: "ignore_pruning_retry_failed", path } },
  );
}

/** Inventory file bytes without calling Git or traversing a symlink from the sandbox. */
export async function snapshotInventory(
  ctx: DockerModuleContext,
  input: {
    sandbox_id: string;
    resources: SandboxResources;
    tracked_paths: readonly string[];
    object_format: "sha1" | "sha256";
    ignore_rules?: { path: string; patterns: string[] }[];
  },
): Promise<SandboxSnapshotEntry[]> {
  const request = {
    action: "inventory",
    hash: input.object_format,
    tracked_paths: input.tracked_paths.map((path) => Buffer.from(path, "utf8").toString("base64")),
    ignore_rules: input.ignore_rules ?? [],
    max_bytes: 1024 * 1024 * 1024,
  };
  let payload = await runSnapshotHelper(ctx, input.resources, request);
  if (!Array.isArray(payload.entries) || !Array.isArray(payload.pruned_directories))
    throw snapshotUnavailable();
  const verifiedPrunedDirectories = async (reported: unknown[]) => {
    const paths = reported.map((path) => {
      if (typeof path !== "string") throw snapshotUnavailable();
      return decodeSnapshotPath(path);
    });
    let ignored: ReadonlySet<string>;
    try {
      ignored = await ignoredPrunedDirectories(input.ignore_rules ?? [], paths);
    } catch (cause) {
      throw new CrossoverError(
        "UNAVAILABLE",
        "Canonical Git ignore rules could not verify sandbox pruning; retry the request",
        { cause, retryable: true, details: { reason: "ignore_pruning_verification_failed" } },
      );
    }
    return paths.filter((path) => !ignored.has(path));
  };
  let mismatches = await verifiedPrunedDirectories(payload.pruned_directories);
  if (mismatches.length) {
    const path = mismatches[0]!;
    try {
      payload = await runSnapshotHelper(ctx, input.resources, {
        ...request,
        unprune_directories: mismatches.map((entry) =>
          Buffer.from(entry, "utf8").toString("base64"),
        ),
      });
      if (!Array.isArray(payload.entries) || !Array.isArray(payload.pruned_directories))
        throw new Error("invalid_inventory");
      mismatches = await verifiedPrunedDirectories(payload.pruned_directories);
      if (mismatches.length) throw new Error(`pruning_mismatch:${mismatches[0]}`);
    } catch (cause) {
      if (cause instanceof CrossoverError && cause.retryable) throw cause;
      throw snapshotPruningRetryFailed(path, cause);
    }
  }
  return payload.entries.map((entry: unknown) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      !("path" in entry) ||
      typeof entry.path !== "string" ||
      !("mode" in entry) ||
      typeof entry.mode !== "string" ||
      !("sha" in entry) ||
      (entry.sha !== null && typeof entry.sha !== "string") ||
      !("size" in entry) ||
      typeof entry.size !== "number" ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0
    ) {
      throw snapshotUnavailable();
    }
    return {
      path: decodeSnapshotPath(entry.path),
      mode: entry.mode,
      sha: entry.sha,
      size: entry.size,
    };
  });
}

/** Read a single regular file without following a symlink from the working copy. */
export async function readFile(
  ctx: DockerModuleContext,
  input: {
    sandbox_id: string;
    resources: SandboxResources;
    path: string;
    max_bytes: number;
  },
): Promise<{ mode: string; content: Buffer }> {
  const encodedPath = Buffer.from(input.path, "utf8").toString("base64");
  const payload = await runSnapshotHelper(ctx, input.resources, {
    action: "file_read",
    path: encodedPath,
    max_bytes: input.max_bytes,
  });
  const file = payload.file as
    { path?: unknown; mode?: unknown; size?: unknown; content?: unknown } | undefined;
  if (
    !file ||
    file.path !== encodedPath ||
    (file.mode !== "100644" && file.mode !== "100755") ||
    typeof file.size !== "number" ||
    !Number.isSafeInteger(file.size) ||
    file.size < 0 ||
    typeof file.content !== "string"
  ) {
    throw snapshotUnavailable();
  }
  const content = Buffer.from(file.content, "base64");
  if (content.length !== file.size || content.toString("base64") !== file.content)
    throw snapshotUnavailable();
  return { mode: file.mode, content };
}

/** Return exact bytes for the selected inventory paths, rejecting changes between the two reads. */
export async function readSnapshotFiles(
  ctx: DockerModuleContext,
  input: {
    sandbox_id: string;
    resources: SandboxResources;
    files: readonly SandboxSnapshotEntry[];
    object_format: "sha1" | "sha256";
    max_bytes: number;
  },
): Promise<SandboxSnapshotFile[]> {
  const payload = await runSnapshotHelper(ctx, input.resources, {
    action: "read",
    hash: input.object_format,
    paths: input.files.map((file) => ({
      path: Buffer.from(file.path, "utf8").toString("base64"),
      mode: file.mode,
      sha: file.sha,
      size: file.size,
    })),
    max_bytes: input.max_bytes,
  });
  if (!Array.isArray(payload.entries) || payload.entries.length !== input.files.length)
    throw snapshotUnavailable();
  return payload.entries.map((entry: unknown, index: number) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      !("path" in entry) ||
      typeof entry.path !== "string" ||
      !("mode" in entry) ||
      typeof entry.mode !== "string" ||
      !("sha" in entry) ||
      typeof entry.sha !== "string" ||
      !("size" in entry) ||
      typeof entry.size !== "number" ||
      !Number.isSafeInteger(entry.size) ||
      !("content" in entry) ||
      typeof entry.content !== "string"
    ) {
      throw snapshotUnavailable();
    }
    const expected = input.files[index]!;
    const content = Buffer.from(entry.content, "base64");
    if (
      decodeSnapshotPath(entry.path) !== expected.path ||
      entry.mode !== expected.mode ||
      (expected.sha !== null && entry.sha !== expected.sha) ||
      content.length !== entry.size ||
      entry.size !== expected.size
    ) {
      throw snapshotChanged();
    }
    return {
      path: expected.path,
      mode: entry.mode,
      sha: entry.sha,
      size: entry.size,
      content,
    };
  });
}
