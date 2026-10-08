import { execFile, spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import {
  createSandboxProxyCredential,
  createSandboxReadToken,
  SANDBOX_READ_TOKEN_MAX_TTL_MS,
} from "@crossover/security";
import { CrossoverError } from "@crossover/protocol";
import type { ExecutionDriver, SandboxLimits, SandboxResources } from "./execution.js";
import { createPorcelainStatusAccumulator, type SandboxFileChanges } from "./sandbox-status.js";

const DEFAULT_IMAGE = "node:22-bookworm-slim";
const DEFAULT_GIT_FETCHER_IMAGE = "crossover-git-fetcher:latest";
const GIT_NETWORK = "crossover-git";
const FETCH_TIMEOUT_MS = 4 * 60 * 1000;
const MAX_STATUS_OUTPUT_BYTES = 16 * 1024 * 1024;

export interface DockerInvocationOptions {
  timeoutMs?: number;
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
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
  if (options.onStdout) return invokeDockerStreaming(binary, args, options, options.onStdout);

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
      stdio: ["ignore", "pipe", "pipe"],
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

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
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

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderrBytes >= maxStderrBytes) return;
      const bytes = Buffer.from(chunk);
      const saved = bytes.subarray(0, maxStderrBytes - stderrBytes);
      stderr += saved.toString("utf8");
      stderrBytes += saved.length;
    });

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
