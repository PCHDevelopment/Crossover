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
  private readonly invoke: DockerInvoker;

  constructor(options: DockerExecutionDriverOptions = {}) {
    this.dockerBinary = options.dockerBinary ?? "docker";
    this.image = options.image ?? DEFAULT_IMAGE;
    this.volumeDriver = options.volumeDriver?.trim() || undefined;
    this.volumeOptions = options.volumeOptions ?? {};
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
    const existing = await this.inspectContainer(resources.container_ref);
    if (existing) {
      if (hard) await this.assertHardContainer(resources.container_ref);
      return;
    }
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
      "--cpus=2",
      "--memory=4g",
    ];
    if (hard) args.push("--storage-opt=size=20G");
    args.push(
      "--mount",
      `type=volume,source=${resources.volume_ref},target=/workspace`,
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
      if (hard) await this.assertHardContainer(resources.container_ref);
    }
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
      if (inspected.stderr.toLowerCase().includes("no such object")) return null;
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
  const safeId = sandboxId.toLowerCase().replaceAll(/[^a-z0-9_.-]/g, "-");
  const name = `crossover-sbx-${safeId}`;
  return { volume_ref: name, container_ref: name };
}
