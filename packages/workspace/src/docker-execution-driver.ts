import { execFile, spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import type { Readable } from "node:stream";
import {
  createSandboxProxyCredential,
  createSandboxReadToken,
  SANDBOX_READ_TOKEN_MAX_TTL_MS,
} from "@crossover/security";
import { CrossoverError, isId } from "@crossover/protocol";
import { normalizePath } from "./path.js";
import { ignoredPrunedDirectories } from "./ignore.js";
import type {
  ExecutionDriver,
  SandboxLimits,
  SandboxResources,
  SandboxExecOutcome,
  SandboxExecProcess,
  SandboxExecTermination,
  SandboxSnapshotEntry,
  SandboxSnapshotFile,
} from "./execution.js";
import {
  createPorcelainStatusAccumulator,
  MAX_STATUS_OUTPUT_BYTES,
  type SandboxFileChanges,
} from "./sandbox-status.js";
import { SANDBOX_SNAPSHOT_HELPER } from "./sandbox-snapshot-helper.js";

const DEFAULT_IMAGE = "node:22-bookworm-slim";
const DEFAULT_GIT_FETCHER_IMAGE = "crossover-git-fetcher:latest";
const GIT_NETWORK = "crossover-git";
const FETCH_TIMEOUT_MS = 4 * 60 * 1000;
const MAX_SNAPSHOT_OUTPUT_BYTES = 96 * 1024 * 1024;

export interface DockerInvocationOptions {
  timeoutMs?: number;
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
  input?: string | Buffer;
  /** Stream stdout to the caller; returning false stops the child process. */
  onStdout?: (chunk: string) => boolean;
}

export interface DockerInvocationResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type DockerInvoker = (
  args: readonly string[],
  options?: DockerInvocationOptions,
) => Promise<DockerInvocationResult>;

export interface DockerExecutionDriverOptions {
  dockerBinary?: string;
  image?: string;
  /** Required with hard enforcement; passed directly as Docker --opt values. */
  volumeDriver?: string;
  volumeOptions?: Readonly<Record<string, string>>;
  /** Optional Docker runtime such as gVisor's `runsc`. */
  runtime?: string;
  /** Operator-provisioned allowlist proxy container; sandboxes get a private internal network. */
  egressProxyContainer?: string;
  egressProxyPort?: number;
  /** Shared HMAC secret used to mint a credential scoped to each sandbox ID. */
  egressProxySecret?: string;
  /** Name of the server container attached to the private crossover-git network. */
  gitInternalContainer?: string;
  gitInternalPort?: number;
  /** HMAC secret for five-minute, sandbox-scoped workspace fetch credentials. */
  gitInternalTokenSecret?: string;
  gitFetcherImage?: string;
  /** Test seam; production callers should use the Docker CLI. */
  invoke?: DockerInvoker;
}

function invokeDocker(
  binary: string,
  args: readonly string[],
  options: DockerInvocationOptions = {},
): Promise<DockerInvocationResult> {
  if (options.onStdout || options.input !== undefined)
    return invokeDockerStreaming(binary, args, options, options.onStdout ?? (() => true));

  return new Promise<DockerInvocationResult>((resolve) => {
    execFile(
      binary,
      [...args],
      {
        encoding: "utf8",
        timeout: options.timeoutMs ?? 20_000,
        maxBuffer: options.maxBuffer ?? 1024 * 1024,
        ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
      },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
  });
}

function invokeDockerStreaming(
  binary: string,
  args: readonly string[],
  options: DockerInvocationOptions,
  onStdout: (chunk: string) => boolean,
): Promise<DockerInvocationResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [...args], {
      env: options.env ? { ...process.env, ...options.env } : process.env,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const timeoutMs = options.timeoutMs ?? 20_000;
    const maxStderrBytes = options.maxBuffer ?? 1024 * 1024;
    let stderr = "";
    let stderrBytes = 0;
    let stoppedEarly = false;
    let callbackError: unknown;
    let timedOut = false;
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const terminate = () => {
      if (child.kill("SIGTERM")) {
        forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
        forceKillTimer.unref();
      }
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);

    const stdout = child.stdout;
    const stderrStream = child.stderr;
    if (!stdout || !stderrStream) {
      settled = true;
      clearTimeout(timeout);
      reject(new Error("Docker process streams are unavailable"));
      return;
    }
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => {
      if (stoppedEarly || callbackError !== undefined) return;
      try {
        if (!onStdout(chunk)) {
          stoppedEarly = true;
          terminate();
        }
      } catch (error) {
        callbackError = error;
        terminate();
      }
    });

    stderrStream.setEncoding("utf8");
    stderrStream.on("data", (chunk: string) => {
      if (stderrBytes >= maxStderrBytes) return;
      const bytes = Buffer.from(chunk);
      const saved = bytes.subarray(0, maxStderrBytes - stderrBytes);
      stderr += saved.toString("utf8");
      stderrBytes += saved.length;
    });
    if (child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(options.input);
    }

    child.once("error", (error) => {
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (callbackError !== undefined) {
        reject(callbackError);
        return;
      }
      resolve({
        code: stoppedEarly ? 0 : (code ?? (timedOut ? 124 : 1)),
        stdout: "",
        stderr,
      });
    });
  });
}

/** Local Docker implementation of the execution host interface (§14.6). */
export class DockerExecutionDriver implements ExecutionDriver {
  private readonly dockerBinary: string;
  private readonly image: string;
  private readonly volumeDriver: string | undefined;
  private readonly volumeOptions: Readonly<Record<string, string>>;
  private readonly runtime: string | undefined;
  private readonly egressProxyContainer: string | undefined;
  private readonly egressProxyPort: number;
  private readonly egressProxySecret: string | undefined;
  private readonly gitInternalContainer: string | undefined;
  private readonly gitInternalPort: number;
  private readonly gitInternalTokenSecret: string | undefined;
  private readonly gitFetcherImage: string;
  private readonly invoke: DockerInvoker;

  constructor(options: DockerExecutionDriverOptions = {}) {
    this.dockerBinary = options.dockerBinary ?? "docker";
    this.image = options.image ?? DEFAULT_IMAGE;
    this.volumeDriver = options.volumeDriver?.trim() || undefined;
    this.volumeOptions = options.volumeOptions ?? {};
    if (options.runtime !== undefined && !options.runtime.trim())
      throw new Error("SANDBOX_RUNTIME must be a nonempty Docker runtime name");
    this.runtime = options.runtime?.trim() || undefined;
    this.egressProxyContainer = options.egressProxyContainer?.trim() || undefined;
    if (
      this.egressProxyContainer !== undefined &&
      !/^[a-z0-9][a-z0-9_.-]*$/.test(this.egressProxyContainer)
    ) {
      throw new Error("SANDBOX_EGRESS_PROXY_CONTAINER must be a Docker container name");
    }
    if (
      options.egressProxyPort !== undefined &&
      (!Number.isSafeInteger(options.egressProxyPort) ||
        options.egressProxyPort < 1 ||
        options.egressProxyPort > 65_535)
    ) {
      throw new Error("SANDBOX_EGRESS_PROXY_PORT must be a port from 1 to 65535");
    }
    if (!this.egressProxyContainer && options.egressProxyPort !== undefined)
      throw new Error("SANDBOX_EGRESS_PROXY_PORT requires SANDBOX_EGRESS_PROXY_CONTAINER");
    if (this.egressProxyContainer && !options.egressProxySecret)
      throw new Error(
        "SANDBOX_EGRESS_PROXY_SECRET is required with SANDBOX_EGRESS_PROXY_CONTAINER",
      );
    if (!this.egressProxyContainer && options.egressProxySecret)
      throw new Error("SANDBOX_EGRESS_PROXY_SECRET requires SANDBOX_EGRESS_PROXY_CONTAINER");
    if (
      options.egressProxySecret !== undefined &&
      Buffer.byteLength(options.egressProxySecret) < 32
    )
      throw new Error("SANDBOX_EGRESS_PROXY_SECRET must be at least 32 bytes");
    this.egressProxySecret = options.egressProxySecret;
    this.egressProxyPort = options.egressProxyPort ?? 3128;
    this.gitInternalContainer = options.gitInternalContainer?.trim() || undefined;
    if (
      this.gitInternalContainer !== undefined &&
      !/^[a-z0-9][a-z0-9_.-]*$/.test(this.gitInternalContainer)
    ) {
      throw new Error("GIT_INTERNAL_CONTAINER must be a Docker container name");
    }
    if (
      options.gitInternalPort !== undefined &&
      (!Number.isSafeInteger(options.gitInternalPort) ||
        options.gitInternalPort < 1 ||
        options.gitInternalPort > 65_535)
    ) {
      throw new Error("GIT_INTERNAL_PORT must be a port from 1 to 65535");
    }
    this.gitInternalPort = options.gitInternalPort ?? 8081;
    this.gitInternalTokenSecret = options.gitInternalTokenSecret;
    if (this.gitInternalContainer && !this.gitInternalTokenSecret)
      throw new Error("GIT_INTERNAL_TOKEN_SECRET is required with GIT_INTERNAL_CONTAINER");
    if (!this.gitInternalContainer && this.gitInternalTokenSecret)
      throw new Error("GIT_INTERNAL_CONTAINER is required with GIT_INTERNAL_TOKEN_SECRET");
    if (
      this.gitInternalTokenSecret !== undefined &&
      Buffer.byteLength(this.gitInternalTokenSecret) < 32
    ) {
      throw new Error("GIT_INTERNAL_TOKEN_SECRET must be at least 32 bytes");
    }
    this.gitFetcherImage = options.gitFetcherImage?.trim() || DEFAULT_GIT_FETCHER_IMAGE;
    if (/\s|\0/.test(this.gitFetcherImage))
      throw new Error("GIT_FETCHER_IMAGE must be a nonempty Docker image reference");
    if (
      Object.entries(this.volumeOptions).some(
        ([key, value]) =>
          !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(key) || value.length === 0 || value.includes("\0"),
      )
    ) {
      throw new Error("SANDBOX_VOLUME_OPTS must contain nonempty Docker option keys and values");
    }
    this.invoke =
      options.invoke ??
      ((args, invokeOptions) => invokeDocker(this.dockerBinary, args, invokeOptions));
  }

  async create(input: {
    sandbox_id: string;
    room_id: string;
    participant_id: string;
    limits: SandboxLimits;
  }): Promise<SandboxResources> {
    const hard = input.limits.disk_enforcement === "hard";
    if (hard && (!this.volumeDriver || Object.keys(this.volumeOptions).length === 0)) {
      throw new Error(
        "ERROR: SANDBOX_DISK_ENFORCEMENT=hard requires SANDBOX_VOLUME_DRIVER and nonempty SANDBOX_VOLUME_OPTS",
      );
    }

    const resources = sandboxResources(input.sandbox_id);
    if (this.egressProxyContainer) await this.ensureProxyNetwork(input.sandbox_id);
    if (hard) await this.ensureHardVolume(resources.volume_ref);
    else await this.ensureSoftVolume(resources.volume_ref);
    await this.ensureContainer(input, resources, hard);
    return resources;
  }

  async start(input: { sandbox_id: string; resources: SandboxResources }): Promise<void> {
    this.assertResources(input.sandbox_id, input.resources);
    const inspected = await this.inspectContainer(input.resources.container_ref);
    if (!inspected)
      throw new Error(`ERROR: Docker sandbox container ${input.sandbox_id} is missing`);
    if (inspected.running) return;
    try {
      await this.mustSucceed(
        ["container", "start", input.resources.container_ref],
        "ERROR: Docker container start failed",
      );
    } catch (error) {
      if (!(await this.inspectContainer(input.resources.container_ref))?.running) throw error;
    }
  }

  /** Run a shell command in a fresh process group and capture stdout and stderr separately. */
  async exec(input: {
    sandbox_id: string;
    resources: SandboxResources;
    exec_id: string;
    command: string;
    cwd: string;
    timeoutMs: number;
    onOutput: (stream: "stdout" | "stderr", chunk: Buffer) => Promise<void>;
  }): Promise<SandboxExecProcess> {
    this.assertResources(input.sandbox_id, input.resources);
    if (!isId(input.exec_id, "exec")) throw new Error("Invalid sandbox execution id");
    if (input.command.includes("\0") || input.command.length === 0)
      throw new CrossoverError("VALIDATION", "Command must be nonempty text without NUL");
    if (
      !Number.isSafeInteger(input.timeoutMs) ||
      input.timeoutMs < 1 ||
      input.timeoutMs > 3_600_000
    )
      throw new CrossoverError(
        "VALIDATION",
        "Sandbox command timeout must be from 1 to 3600000 ms",
      );
    if (!isAbsolute(input.cwd) || input.cwd.includes("\0"))
      throw new CrossoverError("VALIDATION", "Sandbox working directory must be absolute");

    const processGroupMarker = `CROSSOVER_EXEC_PGID:${input.exec_id}:`;
    const wrapper =
      `printf '%s%s\\n' '${processGroupMarker}' "$$" >&2; ` +
      `physical=$(pwd -P); case "$physical" in /workspace|/workspace/*) base64 -d | sh ;; ` +
      `*) base64 -d >/dev/null; printf 'Sandbox cwd escaped /workspace\\n' >&2; exit 126 ;; esac`;
    const child = spawn(
      this.dockerBinary,
      [
        "exec",
        "-i",
        "--workdir",
        input.cwd,
        input.resources.container_ref,
        "setsid",
        "sh",
        "-lc",
        wrapper,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    const start = Date.now();
    let reason: SandboxExecTermination | undefined;
    let closed = false;
    let settled = false;
    let childCode: number | null = null;
    let outputError: unknown;
    let launchError: unknown;
    let outputTail = Promise.resolve();
    let cancelPromise: Promise<void> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let processGroupId: number | undefined;
    let pendingStderr = Buffer.alloc(0);
    let resolveFinished!: (outcome: SandboxExecOutcome) => void;
    const finished = new Promise<SandboxExecOutcome>((resolve) => (resolveFinished = resolve));

    const deliverOutput = async (stream: "stdout" | "stderr", value: Buffer): Promise<void> => {
      if (stream !== "stderr" || processGroupId !== undefined) {
        if (value.byteLength > 0) await input.onOutput(stream, value);
        return;
      }

      pendingStderr = Buffer.concat([pendingStderr, value]);
      const newline = pendingStderr.indexOf(0x0a);
      if (newline < 0) {
        if (pendingStderr.byteLength > 256)
          throw new Error("Sandbox exec did not report its process group");
        return;
      }

      const line = pendingStderr.subarray(0, newline).toString("utf8");
      const rest = pendingStderr.subarray(newline + 1);
      const rawPid = line.startsWith(processGroupMarker)
        ? line.slice(processGroupMarker.length)
        : "";
      const pid = Number(rawPid);
      if (!/^[1-9][0-9]*$/.test(rawPid) || !Number.isSafeInteger(pid) || pid <= 1) {
        throw new Error("Sandbox exec returned an invalid process-group marker");
      }

      processGroupId = pid;
      pendingStderr = Buffer.alloc(0);
      if (rest.byteLength > 0) await input.onOutput("stderr", rest);
    };
    const queueOutput = (stream: "stdout" | "stderr", source: Readable) => {
      source.on("data", (value: Buffer) => {
        source.pause();
        outputTail = outputTail
          .then(() => deliverOutput(stream, value))
          .catch((error: unknown) => {
            outputError = error;
          })
          .finally(() => source.resume());
      });
    };
    if (child.stdout) queueOutput("stdout", child.stdout);
    if (child.stderr) queueOutput("stderr", child.stderr);

    const signalGroup = async (signal: "TERM" | "KILL"): Promise<void> => {
      const deadline = Date.now() + 5_000;
      while (!closed && processGroupId === undefined && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 25));
      const pid = processGroupId;
      if (pid === undefined) return;
      await this.invoke(
        [
          "exec",
          input.resources.container_ref,
          "sh",
          "-lc",
          `kill -${signal} -${pid} 2>/dev/null || true`,
        ],
        { timeoutMs: 5_000, maxBuffer: 1024 },
      );
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      void outputTail
        .then(async () => {
          if (pendingStderr.byteLength > 0) {
            const tail = pendingStderr;
            pendingStderr = Buffer.alloc(0);
            await input.onOutput("stderr", tail);
          }
        })
        .catch((error: unknown) => {
          outputError = error;
        })
        .finally(() => {
          if (outputError) console.error("[execution] sandbox exec stream failed", outputError);
          const finalReason: SandboxExecOutcome["reason"] = launchError
            ? "start_failed"
            : outputError
              ? "output_failed"
              : (reason ?? "exit");
          resolveFinished({
            exit_code: finalReason === "exit" ? childCode : null,
            duration_ms: Date.now() - start,
            reason: finalReason,
          });
        });
    };

    const cancel = (why: SandboxExecTermination): Promise<void> => {
      if (why === "revoked" || why === "sandbox_stopped") reason = why;
      else reason ??= why;
      if (closed) return Promise.resolve();
      if (cancelPromise) return cancelPromise;
      cancelPromise = (async () => {
        await signalGroup("TERM");
        const stopped = await Promise.race([
          finished.then(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
        ]);
        if (!stopped && !closed) await signalGroup("KILL");
      })();
      return cancelPromise;
    };
    const process: SandboxExecProcess = { finished, cancel };

    child.once("error", (error) => {
      launchError = error;
      closed = true;
      finish();
    });
    child.stdin?.on("error", (error) => {
      launchError = error;
    });
    child.once("close", (code) => {
      closed = true;
      childCode = code;
      finish();
    });
    child.once("spawn", () => {
      timeout = setTimeout(() => void cancel("timed_out"), input.timeoutMs);
      timeout.unref();
    });
    child.stdin?.end(Buffer.from(input.command).toString("base64"));
    return process;
  }

  /** Fetch one scoped shallow checkout through a short-lived, isolated Git fetcher. */
  async materialize(input: {
    sandbox_id: string;
    room_id: string;
    participant_id: string;
    resources: SandboxResources;
    workspace: { repo_path: string; revision: number };
  }): Promise<void> {
    if (!this.gitInternalContainer || !this.gitInternalTokenSecret)
      throw new Error("Internal Git fetch is not configured");
    this.assertResources(input.sandbox_id, input.resources);
    if (!isAbsolute(input.workspace.repo_path) || input.workspace.repo_path.includes("\0"))
      throw new Error("Workspace reference repository path must be absolute");
    if (!Number.isSafeInteger(input.workspace.revision) || input.workspace.revision < 0)
      throw new Error("Workspace revision must be a nonnegative safe integer");

    await this.ensureGitNetwork();
    const now = Date.now();
    const token = createSandboxReadToken(
      {
        room_id: input.room_id,
        participant_id: input.participant_id,
        sandbox_id: input.sandbox_id,
        revision: input.workspace.revision,
        expires_at: now + SANDBOX_READ_TOKEN_MAX_TTL_MS,
      },
      this.gitInternalTokenSecret,
      now,
    );
    const containerName = gitFetcherName(input.sandbox_id);
    const remote = `http://${this.gitInternalContainer}:${this.gitInternalPort}/git/${encodeURIComponent(input.room_id)}/${encodeURIComponent(input.sandbox_id)}/${input.workspace.revision}`;
    const args = [
      "run",
      "--rm",
      "--init",
      "--name",
      containerName,
      "--label",
      "crossover.git.fetch=true",
      "--label",
      `crossover.room=${input.room_id}`,
      "--label",
      `crossover.sandbox=${input.sandbox_id}`,
      `--network=${GIT_NETWORK}`,
      "--read-only",
      "--user=1000:1000",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--memory=1g",
      "--cpus=1",
      "--pids-limit=64",
      "--tmpfs",
      "/tmp:rw,nosuid,size=512m",
      "--env",
      "HOME=/tmp",
      "--env",
      `GIT_REMOTE_URL=${remote}`,
      "--env",
      "GIT_TERMINAL_PROMPT=0",
      "--env",
      "GIT_CONFIG_NOSYSTEM=1",
      "--env",
      "GIT_CONFIG_GLOBAL=/dev/null",
      "--env",
      "GIT_CONFIG_COUNT=1",
      "--env",
      "GIT_CONFIG_KEY_0=http.extraHeader",
      "--env",
      "GIT_CONFIG_VALUE_0",
      "--mount",
      `type=volume,source=${input.resources.volume_ref},target=/workspace,volume-nocopy`,
      "--mount",
      `type=bind,source=${input.workspace.repo_path},target=/reference.git,readonly`,
    ];
    if (this.runtime) args.push("--runtime", this.runtime);
    args.push(this.gitFetcherImage);

    await this.removeFetcher(containerName);
    try {
      const result = await this.invoke(args, {
        timeoutMs: FETCH_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: { GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}` },
      });
      if (result.code !== 0) {
        throw new Error(
          `ERROR: workspace fetch failed: ${result.stderr.replaceAll(token, "[REDACTED]").trim()}`,
        );
      }
    } finally {
      await this.removeFetcher(containerName).catch((error: unknown) =>
        console.error("[execution] failed to remove Git fetcher container", error),
      );
    }
  }

  /** Inspect the sandbox volume with Git, even when the agent image has no Git binary. */
  async status(input: {
    sandbox_id: string;
    resources: SandboxResources;
  }): Promise<SandboxFileChanges> {
    this.assertResources(input.sandbox_id, input.resources);
    try {
      const status = createPorcelainStatusAccumulator();
      let streamed = false;
      let stoppedByLimit = false;
      let statusBytes = 0;
      const consumeStatusChunk = (chunk: string): boolean => {
        streamed = true;
        const chunkBytes = Buffer.byteLength(chunk);
        const remainingBytes = MAX_STATUS_OUTPUT_BYTES - statusBytes;
        if (chunkBytes > remainingBytes) {
          if (remainingBytes > 0) {
            const prefix = Buffer.from(chunk).subarray(0, remainingBytes).toString("utf8");
            if (!status.write(prefix)) {
              stoppedByLimit = true;
              return false;
            }
          }
          status.truncate();
          stoppedByLimit = true;
          return false;
        }
        statusBytes += chunkBytes;
        const keepReading = status.write(chunk);
        if (!keepReading) stoppedByLimit = true;
        return keepReading;
      };
      const result = await this.invoke(
        [
          "run",
          "--rm",
          "--init",
          "--network=none",
          "--read-only",
          "--user=1000:1000",
          "--cap-drop=ALL",
          "--security-opt=no-new-privileges",
          "--memory=512m",
          "--cpus=1",
          "--pids-limit=32",
          "--tmpfs",
          "/tmp:rw,nosuid,noexec,size=16m",
          "--env",
          "HOME=/tmp",
          "--env",
          "GIT_CONFIG_NOSYSTEM=1",
          "--env",
          "GIT_CONFIG_GLOBAL=/dev/null",
          "--env",
          "GIT_OPTIONAL_LOCKS=0",
          "--mount",
          `type=volume,source=${input.resources.volume_ref},target=/workspace,readonly,volume-nocopy`,
          "--workdir",
          "/workspace",
          "--entrypoint",
          "git",
          this.gitFetcherImage,
          "-C",
          "/workspace",
          "-c",
          "core.excludesFile=/workspace/.roomignore",
          "-c",
          "core.fsmonitor=false",
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
          "--no-renames",
        ],
        {
          timeoutMs: 20_000,
          maxBuffer: 8 * 1024 * 1024,
          onStdout: consumeStatusChunk,
        },
      );
      if (!streamed && result.stdout) consumeStatusChunk(result.stdout);
      if (result.code !== 0 && !stoppedByLimit)
        throw new CrossoverError(
          "UNAVAILABLE",
          "Sandbox status could not be read; retry the request",
        );
      return status.finish();
    } catch (cause) {
      if (cause instanceof CrossoverError) throw cause;
      throw new CrossoverError(
        "UNAVAILABLE",
        "Sandbox status could not be read; retry the request",
        {
          cause,
        },
      );
    }
  }

  /** Inventory file bytes without calling Git or traversing a symlink from the sandbox. */
  async snapshotInventory(input: {
    sandbox_id: string;
    resources: SandboxResources;
    tracked_paths: readonly string[];
    object_format: "sha1" | "sha256";
    ignore_rules?: { path: string; patterns: string[] }[];
  }): Promise<SandboxSnapshotEntry[]> {
    this.assertResources(input.sandbox_id, input.resources);
    const request = {
      action: "inventory",
      hash: input.object_format,
      tracked_paths: input.tracked_paths.map((path) =>
        Buffer.from(path, "utf8").toString("base64"),
      ),
      ignore_rules: input.ignore_rules ?? [],
      max_bytes: 1024 * 1024 * 1024,
    };
    let payload = await this.runSnapshotHelper(input.resources, request);
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
        payload = await this.runSnapshotHelper(input.resources, {
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

  /** Return exact bytes for the selected inventory paths, rejecting changes between the two reads. */
  async readSnapshotFiles(input: {
    sandbox_id: string;
    resources: SandboxResources;
    files: readonly SandboxSnapshotEntry[];
    object_format: "sha1" | "sha256";
    max_bytes: number;
  }): Promise<SandboxSnapshotFile[]> {
    this.assertResources(input.sandbox_id, input.resources);
    const payload = await this.runSnapshotHelper(input.resources, {
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

  /** Apply the rebased tree delta with a read/write, no-network helper mounted only to the volume. */
  async updateSnapshot(input: {
    sandbox_id: string;
    resources: SandboxResources;
    files: readonly Pick<SandboxSnapshotFile, "path" | "mode" | "content">[];
    delete_paths: readonly string[];
  }): Promise<void> {
    this.assertResources(input.sandbox_id, input.resources);
    const payload = await this.runSnapshotHelper(
      input.resources,
      {
        action: "install",
        files: input.files.map((file) => ({
          path: Buffer.from(file.path, "utf8").toString("base64"),
          mode: file.mode,
          content: file.content.toString("base64"),
        })),
        delete_paths: input.delete_paths.map((path) =>
          Buffer.from(path, "utf8").toString("base64"),
        ),
      },
      false,
    );
    if (payload.installed !== true) throw snapshotUnavailable();
  }

  private async runSnapshotHelper(
    resources: SandboxResources,
    input: Record<string, unknown>,
    readOnly = true,
  ): Promise<{
    entries?: unknown[];
    pruned_directories?: unknown[];
    error?: string;
    installed?: boolean;
  }> {
    let stdout = "";
    let outputTooLarge = false;
    const result = await this.invoke(
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
        this.image,
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
      installed?: boolean;
    };
    try {
      payload = JSON.parse(stdout) as {
        entries?: unknown[];
        pruned_directories?: unknown[];
        error?: string;
        installed?: boolean;
      };
    } catch {
      throw snapshotUnavailable();
    }
    if (payload.error) {
      if (payload.error === "changed_during_read") throw snapshotChanged();
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

  async stop(input: { sandbox_id: string; resources: SandboxResources }): Promise<void> {
    this.assertResources(input.sandbox_id, input.resources);
    const inspected = await this.inspectContainer(input.resources.container_ref);
    if (!inspected || !inspected.running) return;
    try {
      await this.mustSucceed(
        ["container", "stop", "--time", "2", input.resources.container_ref],
        "ERROR: Docker container stop failed",
      );
    } catch (error) {
      if ((await this.inspectContainer(input.resources.container_ref))?.running) throw error;
    }
  }

  async restart(input: { sandbox_id: string; resources: SandboxResources }): Promise<void> {
    this.assertResources(input.sandbox_id, input.resources);
    await this.mustSucceed(
      ["container", "restart", "--time", "0", input.resources.container_ref],
      "ERROR: Docker container restart failed",
    );
  }

  async destroy(input: { sandbox_id: string; resources?: SandboxResources }): Promise<void> {
    const resources = sandboxResources(input.sandbox_id);
    if (input.resources) this.assertResources(input.sandbox_id, input.resources);
    const container = await this.invoke(["container", "rm", "--force", resources.container_ref]);
    if (container.code !== 0 && !container.stderr.toLowerCase().includes("no such container"))
      throw new Error(`ERROR: Docker container removal failed: ${container.stderr.trim()}`);
    const volume = await this.invoke(["volume", "rm", resources.volume_ref]);
    if (volume.code !== 0 && !volume.stderr.toLowerCase().includes("no such volume"))
      throw new Error(`ERROR: Docker volume removal failed: ${volume.stderr.trim()}`);
    const networkName = sandboxNetworkName(input.sandbox_id);
    if (this.egressProxyContainer) {
      const disconnected = await this.invoke([
        "network",
        "disconnect",
        "--force",
        networkName,
        this.egressProxyContainer,
      ]);
      if (disconnected.code !== 0) {
        const message = disconnected.stderr.toLowerCase();
        const alreadyDisconnected =
          message.includes("not found") ||
          message.includes("no such network") ||
          message.includes("no such container") ||
          message.includes("not connected") ||
          message.includes("endpoint not found");
        if (!alreadyDisconnected)
          throw new Error(
            `ERROR: Docker proxy network disconnect failed: ${disconnected.stderr.trim()}`,
          );
      }
    }
    const network = await this.invoke(["network", "rm", networkName]);
    if (
      network.code !== 0 &&
      !network.stderr.toLowerCase().includes("no such network") &&
      !network.stderr.toLowerCase().includes("not found")
    ) {
      throw new Error(`ERROR: Docker sandbox network removal failed: ${network.stderr.trim()}`);
    }
  }

  private async ensureSoftVolume(name: string): Promise<void> {
    const existing = await this.inspectVolume(name);
    if (existing) return;
    try {
      await this.mustSucceed(["volume", "create", name], "ERROR: workspace volume creation failed");
    } catch (error) {
      if (!(await this.inspectVolume(name))) throw error;
    }
  }

  private async ensureHardVolume(name: string): Promise<void> {
    const existing = await this.inspectVolume(name);
    if (existing) {
      this.assertHardVolume(existing, name);
      return;
    }
    const args = ["volume", "create", "--driver", this.volumeDriver!];
    for (const [key, value] of Object.entries(this.volumeOptions))
      args.push("--opt", `${key}=${value}`);
    args.push(name);
    try {
      await this.mustSucceed(args, "ERROR: hard-enforced workspace volume creation failed");
    } catch (error) {
      const created = await this.inspectVolume(name);
      if (!created) throw error;
      this.assertHardVolume(created, name);
    }
  }

  private async ensureContainer(
    input: { sandbox_id: string; room_id: string; participant_id: string },
    resources: SandboxResources,
    hard: boolean,
  ): Promise<void> {
    const network = this.egressProxyContainer ? sandboxNetworkName(input.sandbox_id) : "none";
    const existing = await this.inspectContainer(resources.container_ref);
    if (existing) {
      await this.assertIsolation(resources.container_ref, network);
      if (hard) await this.assertHardContainer(resources.container_ref);
      return;
    }
    await this.initializeWorkspaceVolume(resources.volume_ref);
    const args = [
      "container",
      "create",
      "--name",
      resources.container_ref,
      "--label",
      "crossover.sandbox=true",
      "--label",
      `crossover.room=${input.room_id}`,
      "--label",
      `crossover.participant=${input.participant_id}`,
      "--init",
      `--network=${network}`,
      "--user=1000:1000",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--pids-limit=256",
      "--env",
      "HOME=/tmp",
      "--cpus=2",
      "--memory=4g",
      "--tmpfs",
      "/tmp:rw,nosuid,size=512m",
    ];
    if (this.egressProxyContainer) {
      const credential = createSandboxProxyCredential(input.sandbox_id, this.egressProxySecret!);
      const proxyUrl = `http://${encodeURIComponent(input.sandbox_id)}:${encodeURIComponent(credential)}@${this.egressProxyContainer}:${this.egressProxyPort}`;
      for (const [name, value] of [
        ["HTTP_PROXY", proxyUrl],
        ["HTTPS_PROXY", proxyUrl],
        ["ALL_PROXY", proxyUrl],
        ["NO_PROXY", "localhost,127.0.0.1,::1"],
        ["http_proxy", proxyUrl],
        ["https_proxy", proxyUrl],
        ["all_proxy", proxyUrl],
        ["no_proxy", "localhost,127.0.0.1,::1"],
      ]) {
        args.push("--env", `${name}=${value}`);
      }
    }
    if (this.runtime) args.push("--runtime", this.runtime);
    if (hard) args.push("--storage-opt=size=20G");
    args.push(
      "--mount",
      `type=volume,source=${resources.volume_ref},target=/workspace,volume-nocopy`,
      "--workdir",
      "/workspace",
      this.image,
      "sleep",
      "infinity",
    );
    try {
      await this.mustSucceed(
        args,
        hard
          ? "ERROR: hard-enforced sandbox container creation failed"
          : "ERROR: sandbox container creation failed",
      );
    } catch (error) {
      if (!(await this.inspectContainer(resources.container_ref))) throw error;
      await this.assertIsolation(resources.container_ref, network);
      if (hard) await this.assertHardContainer(resources.container_ref);
    }
  }

  /** Give the sandbox's unprivileged UID write access to the workspace volume root. */
  private async initializeWorkspaceVolume(name: string): Promise<void> {
    const args = [
      "run",
      "--rm",
      "--network=none",
      "--user=0:0",
      "--mount",
      `type=volume,source=${name},target=/workspace,volume-nocopy`,
      ...(this.runtime ? ["--runtime", this.runtime] : []),
      "--entrypoint",
      "/bin/chown",
      this.image,
      "1000:1000",
      "/workspace",
    ];
    await this.mustSucceed(args, "ERROR: workspace volume ownership setup failed");
  }

  /** Reject resources created before the default-deny and unprivileged defaults were enforced. */
  private async assertIsolation(name: string, expectedNetwork: string): Promise<void> {
    const inspected = await this.invoke([
      "container",
      "inspect",
      "--format",
      "{{.Config.User}}|{{.HostConfig.NetworkMode}}|{{.HostConfig.Runtime}}",
      name,
    ]);
    if (inspected.code !== 0)
      throw new Error(`ERROR: Docker inspect failed: ${inspected.stderr.trim()}`);
    const [user, network, runtime] = inspected.stdout.trim().split("|");
    if (
      user !== "1000:1000" ||
      network !== expectedNetwork ||
      (this.runtime && runtime !== this.runtime)
    )
      throw new Error(
        `ERROR: existing Docker sandbox container ${name} does not enforce non-root and network isolation`,
      );
  }

  /** Isolate each sandbox and expose only the operator's allowlist proxy on its internal network. */
  private async ensureProxyNetwork(sandboxId: string): Promise<void> {
    const name = sandboxNetworkName(sandboxId);
    let inspected = await this.inspectProxyNetwork(name);
    if (!inspected) {
      try {
        await this.mustSucceed(
          ["network", "create", "--internal", "--label", "crossover.sandbox=true", name],
          "ERROR: isolated sandbox network creation failed",
        );
      } catch (error) {
        if (!(await this.inspectProxyNetwork(name))) throw error;
      }
      inspected = await this.inspectProxyNetwork(name);
    }
    if (!inspected?.internal)
      throw new Error(`ERROR: Docker sandbox network ${name} is not internal`);
    if (inspected.proxyConnected) return;

    try {
      await this.mustSucceed(
        ["network", "connect", name, this.egressProxyContainer!],
        "ERROR: egress proxy connection failed",
      );
    } catch (error) {
      if (!(await this.inspectProxyNetwork(name))?.proxyConnected) throw error;
    }
  }

  /** Attach only the trusted Git server and one-shot fetchers to the private network. */
  private async ensureGitNetwork(): Promise<void> {
    let inspected = await this.inspectGitNetwork();
    if (!inspected) {
      try {
        await this.mustSucceed(
          ["network", "create", "--internal", "--label", "crossover.git=true", GIT_NETWORK],
          "ERROR: internal Git network creation failed",
        );
      } catch (error) {
        if (!(await this.inspectGitNetwork())) throw error;
      }
      inspected = await this.inspectGitNetwork();
    }
    if (!inspected?.internal)
      throw new Error(`ERROR: Docker network ${GIT_NETWORK} is not internal`);
    if (inspected.serverConnected) return;
    try {
      await this.mustSucceed(
        ["network", "connect", GIT_NETWORK, this.gitInternalContainer!],
        "ERROR: internal Git server network connection failed",
      );
    } catch (error) {
      if (!(await this.inspectGitNetwork())?.serverConnected) throw error;
    }
  }

  private async inspectGitNetwork(): Promise<{
    internal: boolean;
    serverConnected: boolean;
  } | null> {
    const inspected = await this.invoke([
      "network",
      "inspect",
      "--format",
      "{{.Internal}}|{{json .Containers}}",
      GIT_NETWORK,
    ]);
    if (inspected.code !== 0) {
      const message = inspected.stderr.toLowerCase();
      if (message.includes("no such network") || message.includes("not found")) return null;
      throw new Error(`ERROR: internal Git network inspect failed: ${inspected.stderr.trim()}`);
    }
    const separator = inspected.stdout.indexOf("|");
    if (separator < 0) throw new Error("ERROR: Docker returned invalid Git network data");
    let containers: unknown;
    try {
      containers = JSON.parse(inspected.stdout.slice(separator + 1).trim()) as unknown;
    } catch {
      throw new Error("ERROR: Docker returned invalid Git network data");
    }
    if (containers === null) containers = {};
    if (!containers || typeof containers !== "object" || Array.isArray(containers))
      throw new Error("ERROR: Docker returned invalid Git network data");
    const serverConnected = Object.values(containers as Record<string, { Name?: unknown }>).some(
      (container) => container?.Name === this.gitInternalContainer,
    );
    return { internal: inspected.stdout.slice(0, separator).trim() === "true", serverConnected };
  }

  private async removeFetcher(name: string): Promise<void> {
    const removed = await this.invoke(["container", "rm", "--force", name]);
    if (removed.code === 0) return;
    const message = removed.stderr.toLowerCase();
    if (message.includes("no such container") || message.includes("no such object")) return;
    throw new Error(`ERROR: Git fetcher cleanup failed: ${removed.stderr.trim()}`);
  }

  private async inspectProxyNetwork(
    name: string,
  ): Promise<{ internal: boolean; proxyConnected: boolean } | null> {
    const inspected = await this.invoke([
      "network",
      "inspect",
      "--format",
      "{{.Internal}}|{{json .Containers}}",
      name,
    ]);
    if (inspected.code !== 0) {
      const message = inspected.stderr.toLowerCase();
      if (message.includes("no such network") || message.includes("not found")) return null;
      throw new Error(`ERROR: Docker network inspect failed: ${inspected.stderr.trim()}`);
    }
    const separator = inspected.stdout.indexOf("|");
    if (separator < 0) throw new Error("ERROR: Docker returned invalid network inspection data");
    let containers: unknown;
    try {
      containers = JSON.parse(inspected.stdout.slice(separator + 1).trim()) as unknown;
    } catch {
      throw new Error("ERROR: Docker returned invalid network inspection data");
    }
    if (containers === null) containers = {};
    if (!containers || typeof containers !== "object" || Array.isArray(containers))
      throw new Error("ERROR: Docker returned invalid network inspection data");
    const attached = Object.values(containers as Record<string, { Name?: unknown }>).some(
      (container) => container?.Name === this.egressProxyContainer,
    );
    return {
      internal: inspected.stdout.slice(0, separator).trim() === "true",
      proxyConnected: attached,
    };
  }

  private async inspectContainer(name: string): Promise<{ running: boolean } | null> {
    const inspected = await this.invoke([
      "container",
      "inspect",
      "--format",
      "{{.State.Running}}",
      name,
    ]);
    if (inspected.code !== 0) {
      const message = inspected.stderr.toLowerCase();
      if (message.includes("no such object") || message.includes("no such container")) return null;
      throw new Error(`ERROR: Docker inspect failed: ${inspected.stderr.trim()}`);
    }
    return { running: inspected.stdout.trim() === "true" };
  }

  private async assertHardContainer(name: string): Promise<void> {
    const inspected = await this.invoke([
      "container",
      "inspect",
      "--format",
      "{{json .HostConfig.StorageOpt}}",
      name,
    ]);
    if (inspected.code !== 0)
      throw new Error(`ERROR: Docker inspect failed: ${inspected.stderr.trim()}`);
    try {
      const storage = JSON.parse(inspected.stdout.trim()) as Record<string, string>;
      if (storage.size === "20G") return;
    } catch {
      // Report the same fail-closed message for malformed and missing runtime limits.
    }
    throw new Error(
      `ERROR: existing Docker container ${name} does not enforce its 20 GB writable-layer cap`,
    );
  }

  private async inspectVolume(
    name: string,
  ): Promise<{ driver: string; options: Record<string, string> } | null> {
    const inspected = await this.invoke([
      "volume",
      "inspect",
      "--format",
      "{{.Driver}}|{{json .Options}}",
      name,
    ]);
    if (inspected.code !== 0) {
      if (inspected.stderr.toLowerCase().includes("no such volume")) return null;
      throw new Error(`ERROR: Docker volume inspect failed: ${inspected.stderr.trim()}`);
    }
    const separator = inspected.stdout.indexOf("|");
    if (separator < 0) throw new Error("ERROR: Docker returned invalid volume inspection data");
    try {
      const options: unknown = JSON.parse(inspected.stdout.slice(separator + 1).trim()) as unknown;
      if (!options || typeof options !== "object" || Array.isArray(options))
        throw new Error("volume options must be an object");
      return {
        driver: inspected.stdout.slice(0, separator).trim(),
        options: options as Record<string, string>,
      };
    } catch {
      throw new Error("ERROR: Docker returned invalid volume inspection data");
    }
  }

  private assertHardVolume(
    actual: { driver: string; options: Record<string, string> },
    name: string,
  ): void {
    const matches =
      actual.driver === this.volumeDriver &&
      Object.entries(this.volumeOptions).every(([key, value]) => actual.options[key] === value);
    if (!matches)
      throw new Error(
        `ERROR: existing Docker volume ${name} does not match SANDBOX_VOLUME_DRIVER and SANDBOX_VOLUME_OPTS`,
      );
  }

  private assertResources(sandboxId: string, resources: SandboxResources): void {
    const expected = sandboxResources(sandboxId);
    if (
      resources.volume_ref !== expected.volume_ref ||
      resources.container_ref !== expected.container_ref
    ) {
      throw new Error(`ERROR: Docker resource references do not match sandbox ${sandboxId}`);
    }
  }

  private async mustSucceed(args: readonly string[], message: string): Promise<string> {
    const result = await this.invoke(args);
    if (result.code !== 0) throw new Error(`${message}: ${result.stderr.trim()}`);
    return result.stdout.trim();
  }
}

function decodeSnapshotPath(encoded: string): string {
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

function snapshotChanged(): CrossoverError {
  return new CrossoverError(
    "CONFLICT_VERSION",
    "Sandbox working copy changed while it was being snapshotted; retry the submission",
    { retryable: true, details: { reason: "sandbox_changed_during_snapshot" } },
  );
}

function snapshotUnavailable(): CrossoverError {
  return new CrossoverError(
    "UNAVAILABLE",
    "Sandbox working copy could not be read; retry the request",
    {
      retryable: true,
    },
  );
}

function snapshotPruningRetryFailed(path: string, cause: unknown): CrossoverError {
  return new CrossoverError(
    "VALIDATION",
    `Gitignore matcher disagreed for ${path}; unpruned re-inventory failed`,
    { cause, retryable: false, details: { reason: "ignore_pruning_retry_failed", path } },
  );
}

function sandboxResources(sandboxId: string): SandboxResources {
  const safeId = safeSandboxId(sandboxId);
  const name = `crossover-sbx-${safeId}`;
  return { volume_ref: name, container_ref: name };
}

function sandboxNetworkName(sandboxId: string): string {
  return `crossover-net-${safeSandboxId(sandboxId)}`;
}

function gitFetcherName(sandboxId: string): string {
  return `crossover-git-fetch-${safeSandboxId(sandboxId)}`;
}

function safeSandboxId(sandboxId: string): string {
  return sandboxId.toLowerCase().replaceAll(/[^a-z0-9_.-]/g, "-");
}
