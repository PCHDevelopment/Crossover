import { isAbsolute } from "node:path";
import { createSandboxReadToken, SANDBOX_READ_TOKEN_MAX_TTL_MS } from "@crossover/security";
import type { SandboxCpuUsage, SandboxLimits, SandboxResources } from "../execution.js";
import { sandboxResources } from "./containers.js";
import * as dockerContainers from "./containers.js";
import type { DockerModuleContext } from "./context.js";
import { dockerSocketPath, readDockerCpuUsageUsec } from "./engine-api.js";
import { mustSucceed } from "./invoke.js";
import * as dockerNetworks from "./networks.js";
import { gitFetcherName, sandboxNetworkName } from "./networks.js";
import * as dockerVolumes from "./volumes.js";

const FETCH_TIMEOUT_MS = 4 * 60 * 1000;

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

export function assertResources(sandboxId: string, resources: SandboxResources): void {
  const expected = sandboxResources(sandboxId);
  if (
    resources.volume_ref !== expected.volume_ref ||
    resources.container_ref !== expected.container_ref
  ) {
    throw new Error(`ERROR: Docker resource references do not match sandbox ${sandboxId}`);
  }
}

export async function materialize(
  ctx: Pick<
    DockerModuleContext,
    | "invoke"
    | "gitInternalContainer"
    | "gitInternalTokenSecret"
    | "gitInternalPort"
    | "gitInternalNetwork"
    | "runtime"
    | "gitFetcherImage"
  >,
  input: {
    sandbox_id: string;
    room_id: string;
    participant_id: string;
    resources: SandboxResources;
    workspace: { repo_path: string; revision: number };
  },
): Promise<void> {
  if (!ctx.gitInternalContainer || !ctx.gitInternalTokenSecret)
    throw new Error("Internal Git fetch is not configured");
  assertResources(input.sandbox_id, input.resources);
  if (!isAbsolute(input.workspace.repo_path) || input.workspace.repo_path.includes("\0"))
    throw new Error("Workspace reference repository path must be absolute");
  if (!Number.isSafeInteger(input.workspace.revision) || input.workspace.revision < 0)
    throw new Error("Workspace revision must be a nonnegative safe integer");

  await dockerNetworks.ensureGitNetwork(ctx);
  const now = Date.now();
  const token = createSandboxReadToken(
    {
      room_id: input.room_id,
      participant_id: input.participant_id,
      sandbox_id: input.sandbox_id,
      revision: input.workspace.revision,
      expires_at: now + SANDBOX_READ_TOKEN_MAX_TTL_MS,
    },
    ctx.gitInternalTokenSecret,
    now,
  );
  const containerName = gitFetcherName(input.sandbox_id);
  const remote = `http://${ctx.gitInternalContainer}:${ctx.gitInternalPort}/git/${encodeURIComponent(input.room_id)}/${encodeURIComponent(input.sandbox_id)}/${input.workspace.revision}`;
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
    `--network=${ctx.gitInternalNetwork}`,
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
  if (ctx.runtime) args.push("--runtime", ctx.runtime);
  args.push(ctx.gitFetcherImage);

  await dockerNetworks.removeFetcher(ctx, containerName);
  try {
    const result = await ctx.invoke(args, {
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
    await dockerNetworks
      .removeFetcher(ctx, containerName)
      .catch((error: unknown) =>
        console.error("[execution] failed to remove Git fetcher container", error),
      );
  }
}
