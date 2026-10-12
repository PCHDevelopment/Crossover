import { describe, expect, it, vi } from "vitest";
import { resolveGitInternalListenHost } from "./git-internal-listener.js";

describe("resolveGitInternalListenHost", () => {
  it("uses an explicitly configured IP without inspecting Docker", async () => {
    const inspectNetworks = vi.fn();
    await expect(
      resolveGitInternalListenHost(
        "172.30.0.2",
        "crossover-server",
        "crossover-git",
        inspectNetworks,
      ),
    ).resolves.toBe("172.30.0.2");
    expect(inspectNetworks).not.toHaveBeenCalled();
  });

  it("selects the address on the configured network instead of the first network", async () => {
    const inspectNetworks = vi.fn(async () =>
      JSON.stringify({
        bridge: { IPAddress: "172.17.0.4" },
        "crossover-git": { IPAddress: "172.22.0.4" },
      }),
    );
    await expect(
      resolveGitInternalListenHost(
        "crossover-server",
        "crossover-server",
        "crossover-git",
        inspectNetworks,
      ),
    ).resolves.toBe("172.22.0.4");
    expect(inspectNetworks).toHaveBeenCalledWith("crossover-server");
  });

  it("fails startup when the container has no IPv4 address on crossover-git", async () => {
    await expect(
      resolveGitInternalListenHost(
        "crossover-server",
        "crossover-server",
        "crossover-git",
        async () => JSON.stringify({ bridge: { IPAddress: "172.17.0.4" } }),
      ),
    ).rejects.toThrow(/not attached to crossover-git with an IPv4 address/);
  });

  it("uses the configured network name rather than a fixed Docker network", async () => {
    await expect(
      resolveGitInternalListenHost(
        "crossover-server",
        "crossover-server",
        "private-git",
        async () =>
          JSON.stringify({
            "crossover-git": { IPAddress: "172.22.0.4" },
            "private-git": { IPAddress: "172.23.0.4" },
          }),
      ),
    ).resolves.toBe("172.23.0.4");
  });
});
