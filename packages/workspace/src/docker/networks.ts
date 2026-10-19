import type { DockerModuleContext } from "./context.js";
import { safeSandboxId } from "./containers.js";
import { mustSucceed } from "./invoke.js";

type ProxyNetworkContext = Pick<DockerModuleContext, "invoke" | "egressProxyContainer">;
type GitNetworkContext = Pick<
  DockerModuleContext,
  "invoke" | "gitInternalContainer" | "gitInternalNetwork"
>;

/** Isolate each sandbox and expose only the operator's allowlist proxy on its internal network. */
export async function ensureProxyNetwork(
  ctx: ProxyNetworkContext,
  sandboxId: string,
): Promise<void> {
  const name = sandboxNetworkName(sandboxId);
  let inspected = await inspectProxyNetwork(ctx, name);
  if (!inspected) {
    try {
      await mustSucceed(
        ctx.invoke,
        ["network", "create", "--internal", "--label", "crossover.sandbox=true", name],
        "ERROR: isolated sandbox network creation failed",
      );
    } catch (error) {
      if (!(await inspectProxyNetwork(ctx, name))) throw error;
    }
    inspected = await inspectProxyNetwork(ctx, name);
  }
  if (!inspected?.internal)
    throw new Error(`ERROR: Docker sandbox network ${name} is not internal`);
  if (inspected.proxyConnected) return;

  try {
    await mustSucceed(
      ctx.invoke,
      ["network", "connect", name, ctx.egressProxyContainer!],
      "ERROR: egress proxy connection failed",
    );
  } catch (error) {
    if (!(await inspectProxyNetwork(ctx, name))?.proxyConnected) throw error;
  }
}

/** Attach only the trusted Git server and one-shot fetchers to the private network. */
export async function ensureGitNetwork(ctx: GitNetworkContext): Promise<void> {
  let inspected = await inspectGitNetwork(ctx);
  if (!inspected) {
    try {
      await mustSucceed(
        ctx.invoke,
        [
          "network",
          "create",
          "--internal",
          "--label",
          "crossover.git=true",
          ctx.gitInternalNetwork,
        ],
        "ERROR: internal Git network creation failed",
      );
    } catch (error) {
      if (!(await inspectGitNetwork(ctx))) throw error;
    }
    inspected = await inspectGitNetwork(ctx);
  }
  if (!inspected?.internal)
    throw new Error(`ERROR: Docker network ${ctx.gitInternalNetwork} is not internal`);
  if (inspected.serverConnected) return;
  try {
    await mustSucceed(
      ctx.invoke,
      ["network", "connect", ctx.gitInternalNetwork, ctx.gitInternalContainer!],
      "ERROR: internal Git server network connection failed",
    );
  } catch (error) {
    if (!(await inspectGitNetwork(ctx))?.serverConnected) throw error;
  }
}

export async function inspectGitNetwork(ctx: GitNetworkContext): Promise<{
  internal: boolean;
  serverConnected: boolean;
} | null> {
  const inspected = await ctx.invoke([
    "network",
    "inspect",
    "--format",
    "{{.Internal}}|{{json .Containers}}",
    ctx.gitInternalNetwork,
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
    (container) => container?.Name === ctx.gitInternalContainer,
  );
  return { internal: inspected.stdout.slice(0, separator).trim() === "true", serverConnected };
}

export async function removeFetcher(
  ctx: Pick<DockerModuleContext, "invoke">,
  name: string,
): Promise<void> {
  const removed = await ctx.invoke(["container", "rm", "--force", name]);
  if (removed.code === 0) return;
  const message = removed.stderr.toLowerCase();
  if (message.includes("no such container") || message.includes("no such object")) return;
  throw new Error(`ERROR: Git fetcher cleanup failed: ${removed.stderr.trim()}`);
}

export async function inspectProxyNetwork(
  ctx: ProxyNetworkContext,
  name: string,
): Promise<{ internal: boolean; proxyConnected: boolean } | null> {
  const inspected = await ctx.invoke([
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
    (container) => container?.Name === ctx.egressProxyContainer,
  );
  return {
    internal: inspected.stdout.slice(0, separator).trim() === "true",
    proxyConnected: attached,
  };
}

export function sandboxNetworkName(sandboxId: string): string {
  return `crossover-net-${safeSandboxId(sandboxId)}`;
}

export function gitFetcherName(sandboxId: string): string {
  return `crossover-git-fetch-${safeSandboxId(sandboxId)}`;
}
