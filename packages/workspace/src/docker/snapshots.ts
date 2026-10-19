import { CrossoverError } from "@crossover/protocol";
import { normalizePath } from "../path.js";
import { SANDBOX_SNAPSHOT_HELPER } from "../sandbox-snapshot-helper.js";
import type { SandboxResources } from "../execution.js";
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
