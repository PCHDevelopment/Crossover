import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, chown, lchown, mkdtemp, readdir, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Pool } from "@crossover/db";
import { CrossoverError, newId } from "@crossover/protocol";
import { createHealthInstallProxyCredential } from "@crossover/security";
import { git } from "./git.js";
import { normalizePath } from "./path.js";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const INSTALL_EXPIRY_MARGIN_MS = 60 * 1000;
const INSTALL_SETUP_STALE_MS = 2 * 60 * 1000;
const MAX_LOG_BYTES = 1024 * 1024;
export const DEFAULT_HEALTH_IMAGE = "node:22-bookworm-slim";
export const DEFAULT_HEALTH_LOCKFILE_PATHS = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "poetry.lock",
  "go.sum",
] as const;

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
    roomId?: string;
    command: string;
    image?: string;
    dependencyInstall?: {
      pool: Pool;
      command: string;
      lockfilePaths: readonly string[];
    };
    signal?: AbortSignal;
  }): Promise<HealthRunResult>;
}

export interface DockerHealthRunnerOptions {
  /** Default image is used when the room does not set health_image. */
  image?: string;
  /** Operator-controlled allowlist; rooms can select only images from this list. */
  allowedImages?: readonly string[];
  timeoutMs?: number;
  dockerBinary?: string;
  /** Optional Docker runtime such as gVisor's `runsc`. */
  runtime?: string;
  egressProxyContainer?: string;
  egressProxyPort?: number;
  egressProxySecret?: string;
  /** Identifies this server process so a sweep never expires another node's live install. */
  nodeId?: string;
}

interface ProcessResult {
  code: number | null;
  timedOut: boolean;
  aborted?: boolean;
  output: string;
}

interface DependencyCacheVolume {
  name: string;
  roomId: string;
  cacheKey: string;
  installId: string;
}

function runProcess(
  binary: string,
  args: readonly string[],
  options: {
    cwd?: string;
    timeoutMs: number;
    maxBuffer: number;
    onTimeout?: () => Promise<void>;
    signal?: AbortSignal;
    onAbort?: () => Promise<void>;
  },
): Promise<ProcessResult> {
  if (options.signal?.aborted)
    return Promise.resolve({ code: null, timedOut: false, aborted: true, output: "" });
  return new Promise((resolveProcess) => {
    const child = spawn(binary, [...args], {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let buffered = 0;
    let timedOut = false;
    let aborted = false;
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
    const stop = (cleanup?: () => Promise<void>): void => {
      if (timeoutWork) return;
      timeoutWork = (async () => {
        try {
          await cleanup?.();
        } finally {
          child.kill("SIGTERM");
          const forceKill = setTimeout(() => {
            if (!closed) child.kill("SIGKILL");
          }, 1000);
          forceKill.unref();
        }
      })();
    };
    const onAbort = (): void => {
      aborted = true;
      stop(options.onAbort);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      stop(options.onTimeout);
    }, options.timeoutMs);
    child.on("close", async () => {
      closed = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      await timeoutWork?.catch(() => {});
      const output = Buffer.concat(chunks, buffered).toString("utf8");
      resolveProcess({
        code: spawnError ? null : exitCode,
        timedOut,
        aborted,
        output: spawnError ? `${output}\n${spawnError.message}`.trim() : output.trim(),
      });
    });
  });
}

function clipLog(log: string): string {
  const redacted = log.replace(
    /(https?:\/\/[^:\s/@]+:)[A-Za-z0-9_-]{43}(@[^/\s]+)/gi,
    "$1[REDACTED]$2",
  );
  const bytes = Buffer.from(redacted);
  if (bytes.length <= MAX_LOG_BYTES) return redacted;
  return `${bytes.subarray(0, MAX_LOG_BYTES).toString("utf8")}\n[log truncated]`;
}

function redactHealthInstallCredential(log: string, installId: string, credential: string): string {
  const secrets = [
    credential,
    encodeURIComponent(credential),
    Buffer.from(credential).toString("base64"),
    Buffer.from(`${installId}:${credential}`).toString("base64"),
  ];
  return secrets.reduce(
    (output, secret) => (secret ? output.replaceAll(secret, "[REDACTED]") : output),
    log,
  );
}

async function chownCheckout(checkout: string, uid: number, gid: number): Promise<void> {
  for (const entry of await readdir(checkout, { withFileTypes: true })) {
    const path = join(checkout, entry.name);
    if (entry.isSymbolicLink()) await lchown(path, uid, gid);
    else if (entry.isDirectory()) await chownCheckout(path, uid, gid);
    else await chown(path, uid, gid);
  }
  await chown(checkout, uid, gid);
}

/** Give a throwaway checkout to the server's unprivileged UID, remapping root to uid 1000. */
export async function prepareHealthCheckout(
  checkout: string,
  hostUid = process.getuid?.() ?? 1000,
  hostGid = process.getgid?.() ?? 1000,
  changeOwner = chownCheckout,
): Promise<{ uid: number; gid: number }> {
  const uid = hostUid === 0 ? 1000 : hostUid;
  const gid = hostGid === 0 ? 1000 : hostGid;
  await chmod(checkout, 0o700);
  if (uid !== hostUid || gid !== hostGid) await changeOwner(checkout, uid, gid);
  return { uid, gid };
}

/** Hash lockfile entries from the Git tree without following symlinks in an untrusted checkout. */
export async function hashHealthLockfiles(
  repository: string,
  revision: string,
  lockfilePaths: readonly string[] = DEFAULT_HEALTH_LOCKFILE_PATHS,
): Promise<string> {
  const paths = normalizeHealthLockfilePaths(lockfilePaths);
  const requested = new Set(paths);
  const { stdout } = await git(
    [
      "ls-tree",
      "--full-tree",
      "-r",
      "-z",
      revision,
      "--",
      ...paths.map((path) => `:(literal)${path}`),
    ],
    { cwd: repository, timeoutMs: 30_000, encoding: "buffer" },
  );
  const entries = new Map<string, string>();
  for (const record of stdout.toString("utf8").split("\0")) {
    if (!record) continue;
    const match = /^\d{6} blob ([0-9a-f]{40}|[0-9a-f]{64})\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error("Git returned an invalid health lockfile tree entry");
    const [, objectId, path] = match;
    if (requested.has(path!)) entries.set(path!, objectId!);
  }

  const hash = createHash("sha256");
  for (const [path, objectId] of [...entries].sort(([a], [b]) => a.localeCompare(b)))
    hash.update(path).update("\0").update(objectId).update("\0");
  return hash.digest("hex");
}

/** Validate room-configured lockfile paths; absent settings use the backlog defaults. */
export function normalizeHealthLockfilePaths(
  value: unknown = DEFAULT_HEALTH_LOCKFILE_PATHS,
): string[] {
  if (!Array.isArray(value) || value.length > 10)
    throw new TypeError("health_lockfile_paths must be an array of at most 10 relative paths");
  if (value.some((path) => typeof path !== "string"))
    throw new TypeError("health_lockfile_paths entries must be strings");
  return [...new Set((value as string[]).map(normalizePath))].sort();
}

/** Execute a configured check in a network-isolated Docker container (§12.1). */
export class DockerHealthRunner implements HealthRunner {
  private readonly timeoutMs: number;
  private readonly dockerBinary: string;
  private readonly runtime: string | undefined;
  private readonly nodeId: string;
  private readonly image: string;
  private readonly allowedImages: ReadonlySet<string>;
  private readonly egressProxyContainer: string | undefined;
  private readonly egressProxyPort: number;
  private readonly egressProxySecret: string | undefined;

  constructor(
    options: DockerHealthRunnerOptions,
    private readonly processRunner = runProcess,
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.dockerBinary = options.dockerBinary ?? "docker";
    this.nodeId = options.nodeId?.trim() || `${hostname()}-${process.pid}`;
    if (options.runtime !== undefined && !/^[A-Za-z0-9_.-]+$/.test(options.runtime.trim()))
      throw new Error("SANDBOX_RUNTIME must be a nonempty Docker runtime name");
    this.runtime = options.runtime?.trim() || undefined;
    this.image = options.image ?? DEFAULT_HEALTH_IMAGE;
    this.allowedImages = new Set(options.allowedImages ?? [DEFAULT_HEALTH_IMAGE]);
    this.egressProxyContainer = options.egressProxyContainer?.trim() || undefined;
    if (
      this.egressProxyContainer !== undefined &&
      !/^[a-z0-9][a-z0-9_.-]*$/.test(this.egressProxyContainer)
    ) {
      throw new Error("SANDBOX_EGRESS_PROXY_CONTAINER must be a Docker container name");
    }
    this.egressProxyPort = options.egressProxyPort ?? 3128;
    if (
      !Number.isSafeInteger(this.egressProxyPort) ||
      this.egressProxyPort < 1 ||
      this.egressProxyPort > 65_535
    ) {
      throw new RangeError("SANDBOX_EGRESS_PROXY_PORT must be a port from 1 to 65535");
    }
    this.egressProxySecret = options.egressProxySecret;
    if (this.egressProxyContainer && !this.egressProxySecret)
      throw new Error(
        "SANDBOX_EGRESS_PROXY_SECRET is required with SANDBOX_EGRESS_PROXY_CONTAINER",
      );
    if (!this.egressProxyContainer && this.egressProxySecret)
      throw new Error("SANDBOX_EGRESS_PROXY_SECRET requires SANDBOX_EGRESS_PROXY_CONTAINER");
    if (this.egressProxySecret !== undefined && Buffer.byteLength(this.egressProxySecret) < 32)
      throw new Error("SANDBOX_EGRESS_PROXY_SECRET must be at least 32 bytes");
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
    roomId?: string;
    command: string;
    image?: string;
    dependencyInstall?: {
      pool: Pool;
      command: string;
      lockfilePaths: readonly string[];
    };
    signal?: AbortSignal;
  }): Promise<HealthRunResult> {
    const started = Date.now();
    let checkout: string | undefined;
    try {
      const image = input.image ?? this.image;
      if (!this.allowedImages.has(image))
        throw new Error("Room health image is not operator-allowed");
      let dependencyCache: DependencyCacheVolume | undefined;
      if (input.dependencyInstall) {
        if (!input.roomId) throw new Error("Health dependency installation requires a room ID");
        dependencyCache = await this.prepareDependencyCache(
          input.roomId,
          input.repository,
          input.revision,
          image,
          input.dependencyInstall,
          input.signal,
        );
      }
      checkout = await this.createCheckout(input.repository, input.revision, input.signal);
      const user = await prepareHealthCheckout(checkout);
      if (dependencyCache && input.dependencyInstall) {
        if (!(await this.dependencyVolumeMatches(dependencyCache))) {
          dependencyCache = await this.prepareDependencyCache(
            input.roomId!,
            input.repository,
            input.revision,
            image,
            input.dependencyInstall,
            input.signal,
          );
        }
        if (!(await this.dependencyVolumeMatches(dependencyCache)))
          throw new Error("Health dependency cache volume is missing or has invalid labels");
      }
      const containerName = `health-${newId("health").slice("health_".length)}`;
      let result: ProcessResult;
      try {
        const args = [
          "run",
          "--rm",
          "--init",
          "--name",
          containerName,
          "--label",
          "crossover.health.runner=true",
          "--label",
          `crossover.health.command=${createHash("sha256").update(input.command).digest("hex")}`,
          "--network=none",
          "--read-only",
          `--user=${user.uid}:${user.gid}`,
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
        ];
        if (this.runtime) args.push("--runtime", this.runtime);
        if (dependencyCache) {
          args.push(
            "--mount",
            `type=volume,source=${dependencyCache.name},target=/workspace/node_modules,readonly,volume-nocopy`,
            "--mount",
            `type=volume,source=${dependencyCache.name},target=/health-dependency-cache,readonly,volume-nocopy`,
            "--env",
            "HEALTH_DEPENDENCY_CACHE=/health-dependency-cache",
          );
          args.push(...dependencyCacheEnvironment());
        }
        args.push("--workdir", "/workspace", image, "/bin/sh", "-lc", input.command);
        result = await this.processRunner(this.dockerBinary, args, {
          timeoutMs: this.timeoutMs,
          maxBuffer: MAX_LOG_BYTES,
          ...(input.signal ? { signal: input.signal } : {}),
          onTimeout: async () => {
            await this.processRunner(this.dockerBinary, ["kill", containerName], {
              timeoutMs: 5_000,
              maxBuffer: 8192,
            });
          },
          onAbort: async () => {
            await this.processRunner(this.dockerBinary, ["kill", containerName], {
              timeoutMs: 5_000,
              maxBuffer: 8192,
            });
          },
        });
      } finally {
        await this.processRunner(this.dockerBinary, ["rm", "-f", containerName], {
          timeoutMs: 5_000,
          maxBuffer: 8192,
        }).catch(() => ({ code: null, timedOut: false, output: "" }));
      }
      const status: HealthStatus =
        result.aborted || result.timedOut || result.code === null
          ? "ERROR"
          : result.code === 0
            ? "GREEN"
            : "RED";
      const log = result.timedOut
        ? `${result.output}\nHealth check timed out after ${this.timeoutMs}ms.`
        : result.aborted
          ? `${result.output}\nHealth check aborted.`
          : result.output;
      return { status, durationMs: Date.now() - started, log: clipLog(log) };
    } catch (error) {
      if (input.signal?.aborted)
        return {
          status: "ERROR",
          durationMs: Date.now() - started,
          log: "Health check aborted.",
        };
      return {
        status: "ERROR",
        durationMs: Date.now() - started,
        log: clipLog(error instanceof Error ? error.message : String(error)),
      };
    } finally {
      if (checkout) await rm(checkout, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Expire stale runs, remove leftover installer containers, then remove their networks. */
  async sweepExpiredInstallRuns(pool: Pool): Promise<void> {
    const containers = await this.processRunner(
      this.dockerBinary,
      [
        "container",
        "ls",
        "--all",
        "--filter",
        "label=crossover.health.install=true",
        "--format",
        '{{.Names}}|{{.Label "crossover.health.install_run"}}',
      ],
      { timeoutMs: 10_000, maxBuffer: 64 * 1024 },
    );
    if (containers.code !== 0) {
      console.error(
        "[health] install container sweep failed; continuing without cleanup",
        containers.output,
      );
      return;
    }
    const networks = await this.processRunner(
      this.dockerBinary,
      [
        "network",
        "ls",
        "--filter",
        "label=crossover.health.install=true",
        "--format",
        '{{.Name}}|{{.Label "crossover.health.install_run"}}',
      ],
      { timeoutMs: 10_000, maxBuffer: 64 * 1024 },
    );
    if (networks.code !== 0) {
      console.error(
        "[health] install network sweep failed; continuing without cleanup",
        networks.output,
      );
      return;
    }
    const running = await pool.query<{ id: string; started_at: Date }>(
      `SELECT id, started_at FROM health_install_runs
       WHERE status = 'RUNNING' AND node_id = $1 AND expires_at > clock_timestamp()`,
      [this.nodeId],
    );
    const containerIds = new Set(
      containers.output
        .split(/\r?\n/)
        .map((line) => line.split("|", 2)[1])
        .filter((id): id is string => Boolean(id)),
    );
    for (const run of running.rows) {
      if (
        Date.now() - run.started_at.getTime() < INSTALL_SETUP_STALE_MS ||
        containerIds.has(run.id)
      )
        continue;
      await pool.query(
        `UPDATE health_install_runs
         SET status = 'FAILED', finished_at = clock_timestamp()
         WHERE id = $1 AND node_id = $2 AND status = 'RUNNING'
           AND expires_at > clock_timestamp()`,
        [run.id, this.nodeId],
      );
    }
    await pool.query(
      `UPDATE health_install_runs
       SET status = 'FAILED', finished_at = clock_timestamp()
       WHERE status = 'RUNNING' AND expires_at <= clock_timestamp()`,
    );
    const active = await pool.query<{ id: string }>(
      `SELECT id FROM health_install_runs
       WHERE status = 'RUNNING' AND expires_at > clock_timestamp()`,
    );
    const activeIds = new Set(active.rows.map((row) => row.id));
    for (const line of containers.output.split(/\r?\n/)) {
      const [name, installId] = line.split("|", 2);
      if (!name || !installId || activeIds.has(installId) || !isHealthInstallId(installId))
        continue;
      if (name !== healthInstallContainerName(installId)) continue;
      const removed = await this.processRunner(
        this.dockerBinary,
        ["container", "rm", "--force", name],
        {
          timeoutMs: 10_000,
          maxBuffer: 8192,
        },
      );
      if (removed.code !== 0 && !/no such container|no such object|not found/i.test(removed.output))
        throw new Error(`Health install container removal failed: ${removed.output}`);
    }
    for (const line of networks.output.split(/\r?\n/)) {
      const [name, installId] = line.split("|", 2);
      if (!name || !installId || activeIds.has(installId)) continue;
      if (name !== healthInstallNetworkName(installId) || !isHealthInstallId(installId)) continue;
      await this.removeInstallNetwork(name);
    }
  }

  private async prepareDependencyCache(
    roomId: string,
    repository: string,
    revision: string,
    image: string,
    install: { pool: Pool; command: string; lockfilePaths: readonly string[] },
    signal?: AbortSignal,
  ): Promise<DependencyCacheVolume> {
    if (!this.egressProxyContainer || !this.egressProxySecret)
      throw new Error("health_install_command requires the configured egress allowlist proxy");
    if (!install.command.trim()) throw new Error("health_install_command must not be empty");
    if (signal?.aborted) throw new Error("Health check aborted");

    await this.sweepExpiredInstallRuns(install.pool);
    const lockfileHash = await hashHealthLockfiles(repository, revision, install.lockfilePaths);
    const cacheKey = createHash("sha256")
      .update(
        JSON.stringify({
          lockfileHash,
          installCommand: install.command,
          image,
          runtime: this.runtime,
        }),
      )
      .digest("hex");
    const prior = await install.pool.query<{ id: string }>(
      `SELECT id FROM health_install_runs
       WHERE room_id = $1 AND cache_key = $2 AND status = 'SUCCEEDED'
       ORDER BY finished_at DESC, started_at DESC
       LIMIT 1`,
      [roomId, cacheKey],
    );
    const successfulInstallId = prior.rows[0]?.id;
    if (successfulInstallId) {
      const successfulVolume = healthDependencyVolumeName(roomId, cacheKey, successfulInstallId);
      const cached = { name: successfulVolume, roomId, cacheKey, installId: successfulInstallId };
      if (await this.dependencyVolumeMatches(cached)) {
        await this.collectDependencyVolumes(install.pool, roomId, successfulInstallId).catch(
          (error: unknown) => console.error("[health] dependency cache collection failed", error),
        );
        return cached;
      }
      if (await this.dependencyVolumeExists(successfulVolume))
        await this.removeDependencyVolumeForGc(successfulVolume);
    }
    const running = await install.pool.query<{ id: string }>(
      `SELECT id FROM health_install_runs WHERE room_id = $1 AND status = 'RUNNING' LIMIT 1`,
      [roomId],
    );
    if (running.rows[0])
      throw new Error("Health dependency installation is already running for this room");

    const installId = newId("hinstall");
    const volume = healthDependencyVolumeName(roomId, cacheKey, installId);
    const network = healthInstallNetworkName(installId);
    let installCheckout: string | undefined;
    let statusUpdated = false;
    let cacheCreated = false;
    let installSucceeded = false;
    let processResult: ProcessResult | undefined;
    try {
      await install.pool.query(
        `INSERT INTO health_install_runs (id, room_id, node_id, cache_key, status, expires_at)
         VALUES ($1, $2, $3, $4, 'RUNNING',
                 clock_timestamp() + ($5::bigint * interval '1 millisecond'))`,
        [installId, roomId, this.nodeId, cacheKey, this.timeoutMs + INSTALL_EXPIRY_MARGIN_MS],
      );
      await this.dockerMustSucceed(
        [
          "network",
          "create",
          "--internal",
          "--label",
          "crossover.health.install=true",
          "--label",
          `crossover.health.install_run=${installId}`,
          network,
        ],
        "Health install network creation failed",
      );
      await this.dockerMustSucceed(
        ["network", "connect", network, this.egressProxyContainer],
        "Health install proxy connection failed",
      );
      installCheckout = await this.createCheckout(repository, revision, signal);
      const user = await prepareHealthCheckout(installCheckout);
      cacheCreated = true;
      await this.ensureDependencyVolume(
        volume,
        image,
        roomId,
        cacheKey,
        installId,
        user.uid,
        user.gid,
      );
      const containerName = healthInstallContainerName(installId);
      const credential = createHealthInstallProxyCredential(installId, this.egressProxySecret);
      const proxyUrl = `http://${encodeURIComponent(installId)}:${encodeURIComponent(credential)}@${this.egressProxyContainer}:${this.egressProxyPort}`;
      const args = [
        "run",
        "--rm",
        "--init",
        "--name",
        containerName,
        "--label",
        "crossover.health.install=true",
        "--label",
        `crossover.health.install_run=${installId}`,
        `--network=${network}`,
        "--read-only",
        `--user=${user.uid}:${user.gid}`,
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
        `${installCheckout}:/workspace:rw`,
        "--mount",
        `type=volume,source=${volume},target=/workspace/node_modules,volume-nocopy`,
        "--mount",
        `type=volume,source=${volume},target=/health-dependency-cache,volume-nocopy`,
        "--env",
        "HEALTH_DEPENDENCY_CACHE=/health-dependency-cache",
        ...dependencyCacheEnvironment(),
      ];
      if (this.runtime) args.push("--runtime", this.runtime);
      for (const [name, value] of proxyEnvironment(proxyUrl))
        args.push("--env", `${name}=${value}`);
      args.push("--workdir", "/workspace", image, "/bin/sh", "-lc", install.command);
      try {
        processResult = await this.processRunner(this.dockerBinary, args, {
          timeoutMs: this.timeoutMs,
          maxBuffer: MAX_LOG_BYTES,
          ...(signal ? { signal } : {}),
          onTimeout: () => this.killContainer(containerName),
          onAbort: () => this.killContainer(containerName),
        });
      } finally {
        await this.processRunner(this.dockerBinary, ["rm", "-f", containerName], {
          timeoutMs: 5_000,
          maxBuffer: 8192,
        }).catch(() => ({ code: null, timedOut: false, output: "" }));
      }
      const succeeded =
        !processResult.aborted && !processResult.timedOut && processResult.code === 0;
      const statusUpdate = await install.pool.query(
        `UPDATE health_install_runs
         SET status = $2, finished_at = clock_timestamp()
         WHERE id = $1 AND status = 'RUNNING'`,
        [installId, succeeded ? "SUCCEEDED" : "FAILED"],
      );
      statusUpdated = true;
      if (statusUpdate.rowCount !== 1)
        throw new Error("Health dependency install run stopped being RUNNING before completion");
      if (!succeeded) {
        const detail = processResult.timedOut
          ? `Health dependency installation timed out after ${this.timeoutMs}ms.`
          : processResult.aborted
            ? "Health dependency installation was aborted."
            : `Health dependency installation failed with exit code ${processResult.code ?? "unknown"}.`;
        const output = redactHealthInstallCredential(processResult.output, installId, credential);
        throw new Error(`${output}\n${detail}`.trim());
      }
      installSucceeded = true;
      await this.collectDependencyVolumes(install.pool, roomId, installId).catch((error: unknown) =>
        console.error("[health] dependency cache collection failed", error),
      );
      return { name: volume, roomId, cacheKey, installId };
    } catch (error) {
      if (!statusUpdated)
        await install.pool
          .query(
            `UPDATE health_install_runs
             SET status = 'FAILED', finished_at = clock_timestamp()
             WHERE id = $1 AND status = 'RUNNING'`,
            [installId],
          )
          .catch(() => undefined);
      throw error;
    } finally {
      if (cacheCreated && !installSucceeded)
        await this.removeDependencyVolume(volume).catch((error: unknown) =>
          console.error("[health] failed to remove incomplete dependency cache", error),
        );
      if (installCheckout)
        await rm(installCheckout, { recursive: true, force: true }).catch(() => {});
      await this.removeInstallNetwork(network);
    }
  }

  private async createCheckout(
    repositoryPath: string,
    revision: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const checkout = await mkdtemp(join(tmpdir(), "crossover-health-"));
    try {
      await chmod(checkout, 0o755);
      const repository = resolve(repositoryPath);
      await git(["clone", "--quiet", "--shared", "--no-checkout", "--", repository, checkout], {
        timeoutMs: 30_000,
      });
      if (signal?.aborted) throw new Error("Health check aborted");
      await git(["checkout", "--quiet", "--detach", "--force", `${revision}^{commit}`], {
        cwd: checkout,
        timeoutMs: 30_000,
      });
      if (signal?.aborted) throw new Error("Health check aborted");
      return checkout;
    } catch (error) {
      await rm(checkout, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  /** Create a fresh cache-key volume owned by the install container's unprivileged UID. */
  private async ensureDependencyVolume(
    name: string,
    image: string,
    roomId: string,
    cacheKey: string,
    installId: string,
    uid: number,
    gid: number,
  ): Promise<void> {
    await this.removeDependencyVolume(name);
    const created = await this.processRunner(
      this.dockerBinary,
      [
        "volume",
        "create",
        "--label",
        "crossover.health.cache=true",
        "--label",
        `crossover.health.cache_room=${healthCacheRoomLabel(roomId)}`,
        "--label",
        `crossover.health.cache_key=${cacheKey}`,
        "--label",
        `crossover.health.cache_install=${installId}`,
        name,
      ],
      { timeoutMs: 10_000, maxBuffer: 64 * 1024 },
    );
    if (created.code !== 0)
      throw new Error(`Health dependency cache creation failed: ${created.output}`);
    try {
      const initializedArgs = [
        "run",
        "--rm",
        "--network=none",
        "--user=0:0",
        "--cap-drop=ALL",
        "--cap-add=CHOWN",
        "--security-opt=no-new-privileges",
        "--mount",
        `type=volume,source=${name},target=/health-dependency-cache,volume-nocopy`,
        "--entrypoint",
        "/bin/sh",
      ];
      if (this.runtime) initializedArgs.push("--runtime", this.runtime);
      initializedArgs.push(
        image,
        "-lc",
        `mkdir -p /health-dependency-cache && chown ${uid}:${gid} /health-dependency-cache`,
      );
      const initialized = await this.processRunner(this.dockerBinary, initializedArgs, {
        timeoutMs: 30_000,
        maxBuffer: 64 * 1024,
      });
      if (initialized.code !== 0)
        throw new Error(`Health dependency cache initialization failed: ${initialized.output}`);
    } catch (error) {
      await this.removeDependencyVolume(name).catch(() => {});
      throw error;
    }
  }

  private async dependencyVolumeLabels(name: string): Promise<Record<string, string> | null> {
    const inspected = await this.processRunner(
      this.dockerBinary,
      ["volume", "inspect", "--format", "{{json .Labels}}", name],
      {
        timeoutMs: 10_000,
        maxBuffer: 64 * 1024,
      },
    );
    if (inspected.code !== 0) {
      if (/no such volume|not found/i.test(inspected.output)) return null;
      throw new Error(`Health dependency cache inspection failed: ${inspected.output}`);
    }
    try {
      const labels = JSON.parse(inspected.output) as unknown;
      if (labels === null) return {};
      if (typeof labels !== "object" || Array.isArray(labels))
        throw new Error("Docker returned invalid volume labels");
      return labels as Record<string, string>;
    } catch (error) {
      throw new Error(
        `Health dependency cache inspection returned invalid labels: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  private async dependencyVolumeMatches(volume: DependencyCacheVolume): Promise<boolean> {
    const labels = await this.dependencyVolumeLabels(volume.name);
    return (
      labels !== null &&
      labels["crossover.health.cache"] === "true" &&
      labels["crossover.health.cache_room"] === healthCacheRoomLabel(volume.roomId) &&
      labels["crossover.health.cache_key"] === volume.cacheKey &&
      labels["crossover.health.cache_install"] === volume.installId
    );
  }

  private async dependencyVolumeExists(name: string): Promise<boolean> {
    const inspected = await this.processRunner(this.dockerBinary, ["volume", "inspect", name], {
      timeoutMs: 10_000,
      maxBuffer: 64 * 1024,
    });
    if (inspected.code === 0) return true;
    if (/no such volume|not found/i.test(inspected.output)) return false;
    throw new Error(`Health dependency cache inspection failed: ${inspected.output}`);
  }

  private async removeDependencyVolume(name: string): Promise<void> {
    if (!(await this.dependencyVolumeExists(name))) return;
    const result = await this.processRunner(this.dockerBinary, ["volume", "rm", name], {
      timeoutMs: 10_000,
      maxBuffer: 8192,
    });
    if (result.code !== 0 && !/no such volume|not found/i.test(result.output))
      throw new Error(`Health dependency cache removal failed: ${result.output}`);
  }

  /** Retain the two most recently successful cache generations for this room. */
  private async collectDependencyVolumes(
    pool: Pool,
    roomId: string,
    preserveInstallId?: string,
  ): Promise<void> {
    const [successful, active] = await Promise.all([
      pool.query<{ id: string }>(
        `SELECT id FROM (
           SELECT DISTINCT ON (cache_key) id, cache_key, finished_at, started_at
           FROM health_install_runs
           WHERE room_id = $1 AND status = 'SUCCEEDED'
           ORDER BY cache_key, finished_at DESC, started_at DESC
         ) newest_by_key
         ORDER BY finished_at DESC, started_at DESC
         LIMIT 2`,
        [roomId],
      ),
      pool.query<{ id: string }>(
        "SELECT id FROM health_install_runs WHERE room_id = $1 AND status = 'RUNNING'",
        [roomId],
      ),
    ]);
    const retainedInstallIds = new Set([
      ...successful.rows.map((row) => row.id),
      ...active.rows.map((row) => row.id),
      ...(preserveInstallId ? [preserveInstallId] : []),
    ]);
    const listed = await this.processRunner(
      this.dockerBinary,
      [
        "volume",
        "ls",
        "--filter",
        "label=crossover.health.cache=true",
        "--filter",
        `label=crossover.health.cache_room=${healthCacheRoomLabel(roomId)}`,
        "--format",
        '{{.Name}}|{{.Label "crossover.health.cache_key"}}|{{.Label "crossover.health.cache_install"}}',
      ],
      { timeoutMs: 10_000, maxBuffer: 64 * 1024 },
    );
    if (listed.code !== 0)
      throw new Error(`Health dependency cache listing failed: ${listed.output}`);
    for (const line of listed.output.split(/\r?\n/)) {
      const [name, cacheKey, installId] = line.split("|", 3);
      if (!name || !cacheKey || !/^[a-f0-9]{64}$/.test(cacheKey)) continue;
      if (installId && isHealthInstallId(installId)) {
        if (
          name !== healthDependencyVolumeName(roomId, cacheKey, installId) ||
          retainedInstallIds.has(installId)
        )
          continue;
        await this.removeDependencyVolumeForGc(name);
      } else if (name === legacyKeyedHealthDependencyVolumeName(roomId, cacheKey)) {
        await this.removeDependencyVolumeForGc(name);
      }
    }
    // Remove the pre-T611-keyed volume after at least one keyed cache has succeeded.
    const legacy = legacyHealthDependencyVolumeName(roomId);
    if (await this.dependencyVolumeExists(legacy)) await this.removeDependencyVolumeForGc(legacy);
  }

  private async removeDependencyVolumeForGc(name: string): Promise<void> {
    await this.removeDependencyVolume(name).catch((error: unknown) =>
      console.error(`[health] failed to remove dependency cache volume ${name}`, error),
    );
  }

  private async dockerMustSucceed(args: readonly string[], description: string): Promise<void> {
    const result = await this.processRunner(this.dockerBinary, args, {
      timeoutMs: 30_000,
      maxBuffer: 64 * 1024,
    });
    if (result.code !== 0) throw new Error(`${description}: ${result.output}`);
  }

  private async killContainer(name: string): Promise<void> {
    await this.processRunner(this.dockerBinary, ["kill", name], {
      timeoutMs: 5_000,
      maxBuffer: 8192,
    });
  }

  private async removeInstallNetwork(name: string): Promise<void> {
    if (!this.egressProxyContainer) return;
    await this.processRunner(
      this.dockerBinary,
      ["network", "disconnect", "--force", name, this.egressProxyContainer],
      { timeoutMs: 10_000, maxBuffer: 8192 },
    ).catch(() => ({ code: null, timedOut: false, output: "" }));
    await this.processRunner(this.dockerBinary, ["network", "rm", name], {
      timeoutMs: 10_000,
      maxBuffer: 8192,
    }).catch(() => ({ code: null, timedOut: false, output: "" }));
  }
}

function healthDependencyVolumeName(roomId: string, cacheKey: string, installId: string): string {
  return `crossover-health-cache-${healthCacheRoomLabel(roomId)}-${cacheKey}-${installId}`;
}

function legacyKeyedHealthDependencyVolumeName(roomId: string, cacheKey: string): string {
  return `crossover-health-cache-${healthCacheRoomLabel(roomId)}-${cacheKey}`;
}

function legacyHealthDependencyVolumeName(roomId: string): string {
  const suffix = createHash("sha256").update(roomId).digest("hex").slice(0, 24);
  return `crossover-health-cache-${suffix}`;
}

function healthCacheRoomLabel(roomId: string): string {
  return createHash("sha256").update(roomId).digest("hex").slice(0, 24);
}

function healthInstallContainerName(installId: string): string {
  return `health-install-${installId.slice("hinstall_".length).toLowerCase()}`;
}

function healthInstallNetworkName(installId: string): string {
  return `crossover-health-install-${installId.slice("hinstall_".length).toLowerCase()}`;
}

function isHealthInstallId(value: string): boolean {
  return /^hinstall_[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value);
}

function dependencyCacheEnvironment(): string[] {
  return [
    "--env",
    "npm_config_cache=/tmp/npm-cache",
    "--env",
    "PIP_CACHE_DIR=/tmp/pip-cache",
    "--env",
    "POETRY_CACHE_DIR=/tmp/poetry-cache",
    "--env",
    "POETRY_VIRTUALENVS_PATH=/tmp/poetry-virtualenvs",
    "--env",
    "POETRY_VIRTUALENVS_IN_PROJECT=false",
    "--env",
    "GOPATH=/tmp/go",
    "--env",
    "GOMODCACHE=/tmp/go-mod",
    "--env",
    "GOCACHE=/tmp/go-build",
  ];
}

function proxyEnvironment(proxyUrl: string): [string, string][] {
  return [
    ["HTTP_PROXY", proxyUrl],
    ["HTTPS_PROXY", proxyUrl],
    ["ALL_PROXY", proxyUrl],
    ["NO_PROXY", "localhost,127.0.0.1,::1"],
    ["http_proxy", proxyUrl],
    ["https_proxy", proxyUrl],
    ["all_proxy", proxyUrl],
    ["no_proxy", "localhost,127.0.0.1,::1"],
  ];
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
  signal?: AbortSignal,
): Promise<{ id: string; result: HealthRunResult } | null> {
  if (!Number.isSafeInteger(revision) || revision < 0)
    throw new CrossoverError("VALIDATION", "Workspace revision must be a nonnegative integer");
  const { rows } = await pool.query<{
    workspace_id: string;
    repo_path: string;
    commit_sha: string;
    health_command: string | null;
    health_image: string | null;
    health_install_command: unknown;
    health_lockfile_paths: unknown;
    has_health_lockfile_paths: boolean;
  }>(
    `SELECT w.id AS workspace_id, w.repo_path, r.commit_sha,
            room.settings ->> 'health_command' AS health_command,
            room.settings ->> 'health_image' AS health_image,
            room.settings -> 'health_install_command' AS health_install_command,
            room.settings -> 'health_lockfile_paths' AS health_lockfile_paths,
            room.settings ? 'health_lockfile_paths' AS has_health_lockfile_paths
     FROM rooms room
     JOIN workspaces w ON w.room_id = room.id
     JOIN workspace_revisions r ON r.workspace_id = w.id AND r.room_id = w.room_id
     WHERE room.id = $1 AND r.revision = $2`,
    [roomId, revision],
  );
  const target = rows[0];
  if (!target) throw new CrossoverError("NOT_FOUND", "Workspace revision not found");
  if (signal?.aborted) return null;
  if (!target.health_command?.trim()) return null;
  const started = Date.now();
  let dependencyInstall:
    { pool: Pool; command: string; lockfilePaths: readonly string[] } | undefined;
  let configurationError: string | undefined;
  if (target.health_install_command !== null && target.health_install_command !== undefined) {
    try {
      if (
        typeof target.health_install_command !== "string" ||
        !target.health_install_command.trim() ||
        Buffer.byteLength(target.health_install_command, "utf8") > 4096
      ) {
        throw new TypeError(
          "health_install_command must be a nonempty string of at most 4096 bytes",
        );
      }
      dependencyInstall = {
        pool,
        command: target.health_install_command,
        lockfilePaths: normalizeHealthLockfilePaths(
          target.has_health_lockfile_paths ? target.health_lockfile_paths : undefined,
        ),
      };
    } catch (error) {
      configurationError = error instanceof Error ? error.message : String(error);
    }
  }
  const result: HealthRunResult = configurationError
    ? { status: "ERROR", durationMs: Date.now() - started, log: configurationError }
    : await runner.run({
        repository: target.repo_path,
        revision: target.commit_sha,
        command: target.health_command,
        ...(target.health_image ? { image: target.health_image } : {}),
        ...(dependencyInstall ? { roomId, dependencyInstall } : {}),
        ...(signal ? { signal } : {}),
      });
  if (signal?.aborted) return null;
  const id = await storeHealthRun(pool, {
    workspaceId: target.workspace_id,
    roomId,
    revision,
    result,
  });
  return { id, result };
}
