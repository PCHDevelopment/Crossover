import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Pool } from "@crossover/db";
import { CrossoverError, newId } from "@crossover/protocol";
import { git } from "./git.js";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_LOG_BYTES = 1024 * 1024;
export const DEFAULT_HEALTH_IMAGE = "node:22-bookworm-slim";

export type HealthStatus = "GREEN" | "RED" | "ERROR";

export interface HealthRunResult {
  status: HealthStatus;
  durationMs: number;
  log: string;
}

export interface HealthRunner {
  run(input: {
    repository: string;
    revision: string;
    command: string;
    image?: string;
  }): Promise<HealthRunResult>;
}

export interface DockerHealthRunnerOptions {
  /** Default image is used when the room does not set health_image. */
  image?: string;
  /** Operator-controlled allowlist; rooms can select only images from this list. */
  allowedImages?: readonly string[];
  timeoutMs?: number;
  dockerBinary?: string;
}

interface ProcessResult {
  code: number | null;
  timedOut: boolean;
  output: string;
}

function runProcess(
  binary: string,
  args: readonly string[],
  options: {
    cwd?: string;
    timeoutMs: number;
    maxBuffer: number;
    onTimeout?: () => Promise<void>;
  },
): Promise<ProcessResult> {
  return new Promise((resolveProcess) => {
    const child = spawn(binary, [...args], {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let buffered = 0;
    let timedOut = false;
    let exitCode: number | null = null;
    let spawnError: Error | undefined;
    let timeoutWork: Promise<void> | undefined;
    let closed = false;
    const append = (chunk: Buffer): void => {
      if (chunk.length >= options.maxBuffer) {
        chunks.splice(0, chunks.length, chunk.subarray(chunk.length - options.maxBuffer));
        buffered = options.maxBuffer;
        return;
      }
      chunks.push(chunk);
      buffered += chunk.length;
      while (buffered > options.maxBuffer) {
        const first = chunks[0]!;
        const excess = buffered - options.maxBuffer;
        if (first.length <= excess) {
          chunks.shift();
          buffered -= first.length;
        } else {
          chunks[0] = first.subarray(excess);
          buffered -= excess;
        }
      }
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("exit", (code) => {
      exitCode = code;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      timeoutWork = (async () => {
        try {
          await options.onTimeout?.();
        } finally {
          child.kill("SIGTERM");
          const forceKill = setTimeout(() => {
            if (!closed) child.kill("SIGKILL");
          }, 1000);
          forceKill.unref();
        }
      })();
    }, options.timeoutMs);
    child.on("close", async () => {
      closed = true;
      clearTimeout(timer);
      await timeoutWork?.catch(() => {});
      const output = Buffer.concat(chunks, buffered).toString("utf8");
      resolveProcess({
        code: spawnError ? null : exitCode,
        timedOut,
        output: spawnError ? `${output}\n${spawnError.message}`.trim() : output.trim(),
      });
    });
  });
}

function clipLog(log: string): string {
  const bytes = Buffer.from(log);
  if (bytes.length <= MAX_LOG_BYTES) return log;
  return `${bytes.subarray(0, MAX_LOG_BYTES).toString("utf8")}\n[log truncated]`;
}

/** Execute a configured check in a network-isolated Docker container (§12.1). */
export class DockerHealthRunner implements HealthRunner {
  private readonly timeoutMs: number;
  private readonly dockerBinary: string;
  private readonly image: string;
  private readonly allowedImages: ReadonlySet<string>;

  constructor(
    options: DockerHealthRunnerOptions,
    private readonly processRunner = runProcess,
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.dockerBinary = options.dockerBinary ?? "docker";
    this.image = options.image ?? DEFAULT_HEALTH_IMAGE;
    this.allowedImages = new Set(options.allowedImages ?? [DEFAULT_HEALTH_IMAGE]);
    if (!this.allowedImages.size || [...this.allowedImages].some((image) => !image.trim()))
      throw new TypeError("Docker health runner image allowlist must not be empty");
    if (!this.allowedImages.has(this.image))
      throw new TypeError("Default Docker health image must be in the operator allowlist");
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1)
      throw new RangeError("Health check timeout must be a positive safe integer");
  }

  async run(input: {
    repository: string;
    revision: string;
    command: string;
    image?: string;
  }): Promise<HealthRunResult> {
    const started = Date.now();
    let checkout: string | undefined;
    try {
      checkout = await mkdtemp(join(tmpdir(), "crossover-health-"));
      await chmod(checkout, 0o755);
      const repository = resolve(input.repository);
      await git(["clone", "--quiet", "--shared", "--no-checkout", "--", repository, checkout], {
        timeoutMs: 30_000,
      });
      await git(["checkout", "--quiet", "--detach", "--force", `${input.revision}^{commit}`], {
        cwd: checkout,
        timeoutMs: 30_000,
      });
      const image = input.image ?? this.image;
      if (!this.allowedImages.has(image))
        throw new Error("Room health image is not operator-allowed");
      const containerName = `health-${newId("health").slice("health_".length)}`;
      let result: ProcessResult;
      try {
        result = await this.processRunner(
          this.dockerBinary,
          [
            "run",
            "--rm",
            "--init",
            "--name",
            containerName,
            "--label",
            "crossover.health.runner=true",
            "--network=none",
            "--read-only",
            "--user=1000:1000",
            "--cap-drop=ALL",
            "--security-opt=no-new-privileges",
            "--memory=1g",
            "--cpus=2",
            "--pids-limit=256",
            "--tmpfs",
            "/tmp:rw,nosuid,size=512m",
            "--env",
            "HOME=/tmp",
            "--volume",
            `${checkout}:/workspace:rw`,
            "--workdir",
            "/workspace",
            image,
            "/bin/sh",
            "-lc",
            input.command,
          ],
          {
            timeoutMs: this.timeoutMs,
            maxBuffer: MAX_LOG_BYTES,
            onTimeout: async () => {
              await this.processRunner(this.dockerBinary, ["kill", containerName], {
                timeoutMs: 5_000,
                maxBuffer: 8192,
              });
            },
          },
        );
      } finally {
        await this.processRunner(this.dockerBinary, ["rm", "-f", containerName], {
          timeoutMs: 5_000,
          maxBuffer: 8192,
        }).catch(() => ({ code: null, timedOut: false, output: "" }));
      }
      const status: HealthStatus =
        result.timedOut || result.code === null ? "ERROR" : result.code === 0 ? "GREEN" : "RED";
      const log = result.timedOut
        ? `${result.output}\nHealth check timed out after ${this.timeoutMs}ms.`
        : result.output;
      return { status, durationMs: Date.now() - started, log: clipLog(log) };
    } catch (error) {
      return {
        status: "ERROR",
        durationMs: Date.now() - started,
        log: clipLog(error instanceof Error ? error.message : String(error)),
      };
    } finally {
      if (checkout) await rm(checkout, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/** Persist a completed check against its exact room-scoped workspace revision. */
export async function storeHealthRun(
  pool: Pool,
  input: {
    workspaceId: string;
    roomId: string;
    revision: number;
    result: HealthRunResult;
  },
): Promise<string> {
  const id = newId("health");
  await pool.query(
    `INSERT INTO health_runs (id, workspace_id, room_id, revision, status, duration_ms, log)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      input.workspaceId,
      input.roomId,
      input.revision,
      input.result.status,
      input.result.durationMs,
      input.result.log,
    ],
  );
  return id;
}

/** Run and persist health for an explicit room workspace revision; unset commands are skipped. */
export async function runHealthCheck(
  pool: Pool,
  runner: HealthRunner,
  roomId: string,
  revision: number,
): Promise<{ id: string; result: HealthRunResult } | null> {
  if (!Number.isSafeInteger(revision) || revision < 0)
    throw new CrossoverError("VALIDATION", "Workspace revision must be a nonnegative integer");
  const { rows } = await pool.query<{
    workspace_id: string;
    repo_path: string;
    commit_sha: string;
    health_command: string | null;
    health_image: string | null;
  }>(
    `SELECT w.id AS workspace_id, w.repo_path, r.commit_sha,
            room.settings ->> 'health_command' AS health_command,
            room.settings ->> 'health_image' AS health_image
     FROM rooms room
     JOIN workspaces w ON w.room_id = room.id
     JOIN workspace_revisions r ON r.workspace_id = w.id AND r.room_id = w.room_id
     WHERE room.id = $1 AND r.revision = $2`,
    [roomId, revision],
  );
  const target = rows[0];
  if (!target) throw new CrossoverError("NOT_FOUND", "Workspace revision not found");
  if (!target.health_command?.trim()) return null;
  const result = await runner.run({
    repository: target.repo_path,
    revision: target.commit_sha,
    command: target.health_command,
    ...(target.health_image ? { image: target.health_image } : {}),
  });
  const id = await storeHealthRun(pool, {
    workspaceId: target.workspace_id,
    roomId,
    revision,
    result,
  });
  return { id, result };
}
