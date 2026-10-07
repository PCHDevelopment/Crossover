import { execFile } from "node:child_process";
import type { ExecutionDriver, SandboxLimits, SandboxResources } from "./execution.js";

const DEFAULT_IMAGE = "node:22-bookworm-slim";

export type DockerInvoker = (args: readonly string[]) => Promise<{
  code: number;
  stdout: string;
  stderr: string;
}>;

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
  /** Test seam; production callers should use the Docker CLI. */
  invoke?: DockerInvoker;
}

function invokeDocker(
  binary: string,
  args: readonly string[],
): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve) => {
    execFile(
      binary,
      [...args],
      { encoding: "utf8", timeout: 20_000, maxBuffer: 1024 * 1024 },
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

/** Local Docker implementation of the execution host interface (§14.6). */
export class DockerExecutionDriver implements ExecutionDriver {
  private readonly dockerBinary: string;
  private readonly image: string;
  private readonly volumeDriver: string | undefined;
  private readonly volumeOptions: Readonly<Record<string, string>>;
  private readonly runtime: string | undefined;
  private readonly egressProxyContainer: string | undefined;
  private readonly egressProxyPort: number;
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
    this.egressProxyPort = options.egressProxyPort ?? 3128;
    if (
      Object.entries(this.volumeOptions).some(
        ([key, value]) =>
          !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(key) || value.length === 0 || value.includes("\0"),
      )
    ) {
      throw new Error("SANDBOX_VOLUME_OPTS must contain nonempty Docker option keys and values");
    }
    this.invoke = options.invoke ?? ((args) => invokeDocker(this.dockerBinary, args));
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
    const network = await this.invoke(["network", "rm", sandboxNetworkName(input.sandbox_id)]);
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
      const proxyUrl = `http://${this.egressProxyContainer}:${this.egressProxyPort}`;
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
      if (inspected.stderr.toLowerCase().includes("no such network")) return null;
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

function safeSandboxId(sandboxId: string): string {
  return sandboxId.toLowerCase().replaceAll(/[^a-z0-9_.-]/g, "-");
}
