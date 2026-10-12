import { execFile } from "node:child_process";
import { isIP } from "node:net";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function inspectContainerNetworks(containerName: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "docker",
    ["container", "inspect", "--format", "{{json .NetworkSettings.Networks}}", containerName],
    { encoding: "utf8", timeout: 5_000, maxBuffer: 1024 * 1024 },
  );
  return stdout.trim();
}

/** Resolve a configured container name to the address reachable on the private Git network. */
export async function resolveGitInternalListenHost(
  configuredHost: string,
  containerName: string,
  networkName: string,
  inspectNetworks: (containerName: string) => Promise<string> = inspectContainerNetworks,
): Promise<string> {
  if (isIP(configuredHost)) return configuredHost;

  let networks: Record<string, { IPAddress?: unknown }>;
  try {
    networks = JSON.parse(await inspectNetworks(containerName)) as Record<
      string,
      { IPAddress?: unknown }
    >;
  } catch (cause) {
    throw new Error(
      `Could not inspect Docker container ${containerName} to resolve GIT_INTERNAL_HOST`,
      { cause },
    );
  }

  const address = networks?.[networkName]?.IPAddress;
  if (typeof address !== "string" || isIP(address) !== 4)
    throw new Error(
      `Docker container ${containerName} is not attached to ${networkName} with an IPv4 address`,
    );
  return address;
}
