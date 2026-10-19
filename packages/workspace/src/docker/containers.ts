import { createSandboxProxyCredential } from "@crossover/security";
import { SANDBOX_VCPU_COUNT, type SandboxResources } from "../execution.js";
import type { DockerModuleContext } from "./context.js";
import { mustSucceed } from "./invoke.js";
import { initializeWorkspaceVolume } from "./volumes.js";

type ContainerContext = Pick<
  DockerModuleContext,
  "invoke" | "egressProxyContainer" | "egressProxySecret" | "egressProxyPort" | "runtime" | "image"
>;

export async function ensureContainer(
  ctx: ContainerContext,
  input: { sandbox_id: string; room_id: string; participant_id: string },
  resources: SandboxResources,
  hard: boolean,
  network: string,
): Promise<void> {
  const existing = await inspectContainer(ctx, resources.container_ref);
  if (existing) {
    await assertIsolation(ctx, resources.container_ref, network);
    if (hard) await assertHardContainer(ctx, resources.container_ref);
    return;
  }
  await initializeWorkspaceVolume(ctx, resources.volume_ref);
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
    `--cpus=${SANDBOX_VCPU_COUNT}`,
    "--memory=4g",
    "--tmpfs",
    "/tmp:rw,nosuid,size=512m",
  ];
  if (ctx.egressProxyContainer) {
    const credential = createSandboxProxyCredential(input.sandbox_id, ctx.egressProxySecret!);
    const proxyUrl = `http://${encodeURIComponent(input.sandbox_id)}:${encodeURIComponent(credential)}@${ctx.egressProxyContainer}:${ctx.egressProxyPort}`;
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
  if (ctx.runtime) args.push("--runtime", ctx.runtime);
  if (hard) args.push("--storage-opt=size=20G");
  args.push(
    "--mount",
    `type=volume,source=${resources.volume_ref},target=/workspace,volume-nocopy`,
    "--workdir",
    "/workspace",
    ctx.image,
    "sleep",
    "infinity",
  );
  try {
    await mustSucceed(
      ctx.invoke,
      args,
      hard
        ? "ERROR: hard-enforced sandbox container creation failed"
        : "ERROR: sandbox container creation failed",
    );
  } catch (error) {
    if (!(await inspectContainer(ctx, resources.container_ref))) throw error;
    await assertIsolation(ctx, resources.container_ref, network);
    if (hard) await assertHardContainer(ctx, resources.container_ref);
  }
}

/** Reject resources created before the default-deny and unprivileged defaults were enforced. */
export async function assertIsolation(
  ctx: Pick<DockerModuleContext, "invoke" | "runtime">,
  name: string,
  expectedNetwork: string,
): Promise<void> {
  const inspected = await ctx.invoke([
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
    (ctx.runtime && runtime !== ctx.runtime)
  )
    throw new Error(
      `ERROR: existing Docker sandbox container ${name} does not enforce non-root and network isolation`,
    );
}

export async function inspectContainer(
  ctx: Pick<DockerModuleContext, "invoke">,
  name: string,
): Promise<{ running: boolean } | null> {
  const inspected = await ctx.invoke([
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

export async function assertHardContainer(
  ctx: Pick<DockerModuleContext, "invoke">,
  name: string,
): Promise<void> {
  const inspected = await ctx.invoke([
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

export function sandboxResources(sandboxId: string): SandboxResources {
  const safeId = safeSandboxId(sandboxId);
  const name = `crossover-sbx-${safeId}`;
  return { volume_ref: name, container_ref: name };
}

export function safeSandboxId(sandboxId: string): string {
  return sandboxId.toLowerCase().replaceAll(/[^a-z0-9_.-]/g, "-");
}
