import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import type { Readable } from "node:stream";
import { CrossoverError, isId } from "@crossover/protocol";
import type {
  ExecutionDriver,
  SandboxCpuUsage,
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
import type { DockerModuleContext } from "./docker/context.js";
import * as dockerNetworks from "./docker/networks.js";
import * as dockerSnapshots from "./docker/snapshots.js";
import * as dockerContainers from "./docker/containers.js";
import * as dockerLifecycle from "./docker/lifecycle.js";
import * as dockerVolumes from "./docker/volumes.js";
import { sandboxNetworkName } from "./docker/networks.js";
import { sandboxResources } from "./docker/containers.js";
import {
  invokeDocker,
  mustSucceed,
  type DockerExecutionDriverOptions,
  type DockerInvoker,
} from "./docker/invoke.js";
export { parseDockerCpuUsageUsec } from "./docker/engine-api.js";
export type {
  DockerExecutionDriverOptions,
  DockerInvocationOptions,
  DockerInvocationResult,
  DockerInvoker,
} from "./docker/invoke.js";

const DEFAULT_IMAGE = "node:22-bookworm-slim";
const DEFAULT_GIT_FETCHER_IMAGE = "crossover-git-fetcher:latest";
export const DEFAULT_GIT_INTERNAL_NETWORK = "crossover-git";

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
  private readonly gitInternalNetwork: string;
  private readonly gitInternalPort: number;
  private readonly gitInternalTokenSecret: string | undefined;
  private readonly gitFetcherImage: string;
  private readonly invoke: DockerInvoker;
  private readonly dockerStatsSocketPath: string | undefined;
  private readonly context: DockerModuleContext;

  constructor(options: DockerExecutionDriverOptions = {}) {
    this.dockerBinary = options.dockerBinary ?? "docker";
    this.dockerStatsSocketPath = options.dockerSocketPath;
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
    this.gitInternalNetwork = options.gitInternalNetwork?.trim() || DEFAULT_GIT_INTERNAL_NETWORK;
    if (!/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(this.gitInternalNetwork)) {
      throw new Error("GIT_INTERNAL_NETWORK must be a Docker network name");
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
    this.context = {
      invoke: this.invoke,
      dockerBinary: this.dockerBinary,
      dockerStatsSocketPath: this.dockerStatsSocketPath,
      image: this.image,
      runtime: this.runtime,
      volumeDriver: this.volumeDriver,
      volumeOptions: this.volumeOptions,
      egressProxyContainer: this.egressProxyContainer,
      egressProxyPort: this.egressProxyPort,
      egressProxySecret: this.egressProxySecret,
      gitInternalContainer: this.gitInternalContainer,
      gitInternalNetwork: this.gitInternalNetwork,
      gitInternalPort: this.gitInternalPort,
      gitInternalTokenSecret: this.gitInternalTokenSecret,
      gitFetcherImage: this.gitFetcherImage,
    };
  }

  async create(input: {
    sandbox_id: string;
    room_id: string;
    participant_id: string;
    limits: SandboxLimits;
  }): Promise<SandboxResources> {
    return dockerLifecycle.create(this.context, input);
  }

  async start(input: { sandbox_id: string; resources: SandboxResources }): Promise<void> {
    return dockerLifecycle.start(this.context, input);
  }

  /** Read cumulative CPU time from Docker's host-side stats API, keyed by container generation. */
  async cpuUsage(input: {
    sandbox_id: string;
    resources: SandboxResources;
  }): Promise<SandboxCpuUsage> {
    return dockerLifecycle.cpuUsage(this.context, input);
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
    return dockerLifecycle.materialize(this.context, input);
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
    return dockerSnapshots.snapshotInventory(this.context, input);
  }

  /** Read a single regular file without following a symlink from the working copy. */
  async readFile(input: {
    sandbox_id: string;
    resources: SandboxResources;
    path: string;
    max_bytes: number;
  }): Promise<{ mode: string; content: Buffer }> {
    this.assertResources(input.sandbox_id, input.resources);
    return dockerSnapshots.readFile(this.context, input);
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
    return dockerSnapshots.readSnapshotFiles(this.context, input);
  }

  /** Apply the rebased tree delta with a read/write, no-network helper mounted only to the volume. */
  async updateSnapshot(input: {
    sandbox_id: string;
    resources: SandboxResources;
    files: readonly (Pick<SandboxSnapshotFile, "path" | "mode" | "content"> & {
      preserve_mode?: boolean;
    })[];
    delete_paths: readonly string[];
  }): Promise<void> {
    this.assertResources(input.sandbox_id, input.resources);
    return dockerSnapshots.updateSnapshot(this.context, input);
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
    return dockerVolumes.ensureSoftVolume(this.context, name);
  }

  private async ensureHardVolume(name: string): Promise<void> {
    return dockerVolumes.ensureHardVolume(this.context, name);
  }

  private async ensureContainer(
    input: { sandbox_id: string; room_id: string; participant_id: string },
    resources: SandboxResources,
    hard: boolean,
  ): Promise<void> {
    const network = this.egressProxyContainer ? sandboxNetworkName(input.sandbox_id) : "none";
    return dockerContainers.ensureContainer(this.context, input, resources, hard, network);
  }

  private async ensureProxyNetwork(sandboxId: string): Promise<void> {
    return dockerNetworks.ensureProxyNetwork(this.context, sandboxId);
  }

  private async ensureGitNetwork(): Promise<void> {
    return dockerNetworks.ensureGitNetwork(this.context);
  }

  private async removeFetcher(name: string): Promise<void> {
    return dockerNetworks.removeFetcher(this.context, name);
  }

  private async inspectContainer(name: string): Promise<{ running: boolean } | null> {
    return dockerContainers.inspectContainer(this.context, name);
  }

  private async inspectVolume(
    name: string,
  ): Promise<{ driver: string; options: Record<string, string> } | null> {
    return dockerVolumes.inspectVolume(this.context, name);
  }

  private assertHardVolume(
    actual: { driver: string; options: Record<string, string> },
    name: string,
  ): void {
    return dockerVolumes.assertHardVolume(this.context, actual, name);
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
    return mustSucceed(this.invoke, args, message);
  }
}
