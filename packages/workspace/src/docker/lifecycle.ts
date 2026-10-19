import type { SandboxCpuUsage, SandboxLimits, SandboxResources } from "../execution.js";
import { sandboxResources } from "./containers.js";
import * as dockerContainers from "./containers.js";
import type { DockerModuleContext } from "./context.js";
import { dockerSocketPath, readDockerCpuUsageUsec } from "./engine-api.js";
import { mustSucceed } from "./invoke.js";
import * as dockerNetworks from "./networks.js";
import { sandboxNetworkName } from "./networks.js";
import * as dockerVolumes from "./volumes.js";

type CreateContext = Pick<
  DockerModuleContext,
  | "invoke"
  | "volumeDriver"
  | "volumeOptions"
  | "egressProxyContainer"
  | "egressProxySecret"
  | "egressProxyPort"
  | "runtime"
  | "image"
>;

export async function create(
  ctx: CreateContext,
  input: { sandbox_id: string; room_id: string; participant_id: string; limits: SandboxLimits },
): Promise<SandboxResources> {
  const hard = input.limits.disk_enforcement === "hard";
  if (hard && (!ctx.volumeDriver || Object.keys(ctx.volumeOptions).length === 0)) {
    throw new Error(
      "ERROR: SANDBOX_DISK_ENFORCEMENT=hard requires SANDBOX_VOLUME_DRIVER and nonempty SANDBOX_VOLUME_OPTS",
    );
  }

  const resources = sandboxResources(input.sandbox_id);
  if (ctx.egressProxyContainer) await dockerNetworks.ensureProxyNetwork(ctx, input.sandbox_id);
  if (hard) await dockerVolumes.ensureHardVolume(ctx, resources.volume_ref);
  else await dockerVolumes.ensureSoftVolume(ctx, resources.volume_ref);
  await dockerContainers.ensureContainer(
    ctx,
    input,
    resources,
    hard,
    ctx.egressProxyContainer ? sandboxNetworkName(input.sandbox_id) : "none",
  );
  return resources;
}

export async function start(
  ctx: Pick<DockerModuleContext, "invoke">,
  input: { sandbox_id: string; resources: SandboxResources },
): Promise<void> {
  assertResources(input.sandbox_id, input.resources);
  const inspected = await dockerContainers.inspectContainer(ctx, input.resources.container_ref);
  if (!inspected) throw new Error(`ERROR: Docker sandbox container ${input.sandbox_id} is missing`);
  if (inspected.running) return;
  try {
    await mustSucceed(
      ctx.invoke,
      ["container", "start", input.resources.container_ref],
      "ERROR: Docker container start failed",
    );
  } catch (error) {
    if (!(await dockerContainers.inspectContainer(ctx, input.resources.container_ref))?.running)
      throw error;
  }
}

/** Read cumulative CPU time from Docker's host-side stats API, keyed by container generation. */
export async function cpuUsage(
  ctx: Pick<DockerModuleContext, "invoke" | "dockerStatsSocketPath">,
  input: { sandbox_id: string; resources: SandboxResources },
): Promise<SandboxCpuUsage> {
  assertResources(input.sandbox_id, input.resources);
  const inspected = await ctx.invoke([
    "container",
    "inspect",
    "--format",
    "{{.State.Running}}|{{.State.StartedAt}}",
    input.resources.container_ref,
  ]);
  if (inspected.code !== 0)
    throw new Error(`ERROR: Docker CPU inspect failed: ${inspected.stderr.trim()}`);
  const [running, generation] = inspected.stdout.trim().split("|");
  if (running !== "true" || !generation)
    throw new Error(`ERROR: Docker sandbox ${input.sandbox_id} is not running for CPU sampling`);

  let usage_usec: bigint;
  try {
    usage_usec = await readDockerCpuUsageUsec(
      input.resources.container_ref,
      dockerSocketPath(ctx.dockerStatsSocketPath),
    );
  } catch (error) {
    throw new Error(
      `ERROR: Docker host CPU stats read failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  const afterStats = await ctx.invoke([
    "container",
    "inspect",
    "--format",
    "{{.State.Running}}|{{.State.StartedAt}}",
    input.resources.container_ref,
  ]);
  if (afterStats.code !== 0)
    throw new Error(`ERROR: Docker CPU generation check failed: ${afterStats.stderr.trim()}`);
  const [stillRunning, currentGeneration] = afterStats.stdout.trim().split("|");
  if (stillRunning !== "true" || currentGeneration !== generation)
    throw new Error(`ERROR: Docker sandbox ${input.sandbox_id} changed during CPU sampling`);
  return { usage_usec, generation };
}

function assertResources(sandboxId: string, resources: SandboxResources): void {
  const expected = sandboxResources(sandboxId);
  if (
    resources.volume_ref !== expected.volume_ref ||
    resources.container_ref !== expected.container_ref
  ) {
    throw new Error(`ERROR: Docker resource references do not match sandbox ${sandboxId}`);
  }
}
