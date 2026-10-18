import type { DockerModuleContext } from "./context.js";
import { mustSucceed } from "./invoke.js";

/** Create or reuse the default workspace volume. */
export async function ensureSoftVolume(
  ctx: Pick<DockerModuleContext, "invoke">,
  name: string,
): Promise<void> {
  const existing = await inspectVolume(ctx, name);
  if (existing) return;
  try {
    await mustSucceed(
      ctx.invoke,
      ["volume", "create", name],
      "ERROR: workspace volume creation failed",
    );
  } catch (error) {
    if (!(await inspectVolume(ctx, name))) throw error;
  }
}

/** Create or verify a volume with the configured hard limits. */
export async function ensureHardVolume(
  ctx: Pick<DockerModuleContext, "invoke" | "volumeDriver" | "volumeOptions">,
  name: string,
): Promise<void> {
  const existing = await inspectVolume(ctx, name);
  if (existing) {
    assertHardVolume(ctx, existing, name);
    return;
  }
  const args = ["volume", "create", "--driver", ctx.volumeDriver!];
  for (const [key, value] of Object.entries(ctx.volumeOptions))
    args.push("--opt", `${key}=${value}`);
  args.push(name);
  try {
    await mustSucceed(ctx.invoke, args, "ERROR: hard-enforced workspace volume creation failed");
  } catch (error) {
    const created = await inspectVolume(ctx, name);
    if (!created) throw error;
    assertHardVolume(ctx, created, name);
  }
}

/** Give the sandbox's unprivileged UID write access to the workspace volume root. */
export async function initializeWorkspaceVolume(
  ctx: Pick<DockerModuleContext, "invoke" | "runtime" | "image">,
  name: string,
): Promise<void> {
  const args = [
    "run",
    "--rm",
    "--network=none",
    "--user=0:0",
    "--mount",
    `type=volume,source=${name},target=/workspace,volume-nocopy`,
    ...(ctx.runtime ? ["--runtime", ctx.runtime] : []),
    "--entrypoint",
    "/bin/chown",
    ctx.image,
    "1000:1000",
    "/workspace",
  ];
  await mustSucceed(ctx.invoke, args, "ERROR: workspace volume ownership setup failed");
}

export async function inspectVolume(
  ctx: Pick<DockerModuleContext, "invoke">,
  name: string,
): Promise<{ driver: string; options: Record<string, string> } | null> {
  const inspected = await ctx.invoke([
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
    if (options === null) {
      return {
        driver: inspected.stdout.slice(0, separator).trim(),
        options: {},
      };
    }
    if (typeof options !== "object" || Array.isArray(options))
      throw new Error("volume options must be an object");
    return {
      driver: inspected.stdout.slice(0, separator).trim(),
      options: options as Record<string, string>,
    };
  } catch {
    throw new Error("ERROR: Docker returned invalid volume inspection data");
  }
}

export function assertHardVolume(
  ctx: Pick<DockerModuleContext, "volumeDriver" | "volumeOptions">,
  actual: { driver: string; options: Record<string, string> },
  name: string,
): void {
  const matches =
    actual.driver === ctx.volumeDriver &&
    Object.entries(ctx.volumeOptions).every(([key, value]) => actual.options[key] === value);
  if (!matches)
    throw new Error(
      `ERROR: existing Docker volume ${name} does not match SANDBOX_VOLUME_DRIVER and SANDBOX_VOLUME_OPTS`,
    );
}
