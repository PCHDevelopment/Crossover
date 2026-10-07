import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { newId } from "@crossover/protocol";
import { createSandboxProxyCredential } from "@crossover/security";
import { DockerExecutionDriver, type DockerInvoker } from "./docker-execution-driver.js";

const hardOptions = {
  volumeDriver: "local",
  volumeOptions: { type: "none", device: "/srv/sandbox", o: "bind,pquota" },
};

function missingResources(args: readonly string[]) {
  if (args[0] === "volume" && args[1] === "inspect")
    return { code: 1, stdout: "", stderr: "Error: no such volume: sandbox" };
  if (args[0] === "container" && args[1] === "inspect")
    return {
      code: 1,
      stdout: "",
      stderr: "Error response from daemon: No such container: sandbox",
    };
  return { code: 0, stdout: "", stderr: "" };
}

describe("DockerExecutionDriver", () => {
  it("creates a hard-quota volume and container with deterministic names", async () => {
    const calls: string[][] = [];
    let containerExists = false;
    let containerRunning = false;
    const invoke: DockerInvoker = async (args) => {
      calls.push([...args]);
      if (args[0] === "container" && args[1] === "inspect")
        return containerExists
          ? { code: 0, stdout: String(containerRunning), stderr: "" }
          : {
              code: 1,
              stdout: "",
              stderr: "Error response from daemon: No such container: sandbox",
            };
      if (args[0] === "container" && args[1] === "create") containerExists = true;
      if (args[0] === "container" && args[1] === "start") containerRunning = true;
      return missingResources(args);
    };
    const driver = new DockerExecutionDriver({ invoke, ...hardOptions });
    const sandboxId = newId("sandbox");
    const resources = await driver.create({
      sandbox_id: sandboxId,
      room_id: newId("room"),
      participant_id: newId("part"),
      limits: { disk_enforcement: "hard" },
    });
    const create = calls.find((args) => args[0] === "container" && args[1] === "create")!;
    const volume = calls.find((args) => args[0] === "volume" && args[1] === "create")!;
    const initialize = calls.find((args) => args[0] === "run")!;
    const expectedName = `crossover-sbx-${sandboxId.toLowerCase()}`;

    expect(resources).toEqual({ volume_ref: expectedName, container_ref: expectedName });
    expect(create).toContain("--cpus=2");
    expect(create).toContain("--memory=4g");
    expect(create).toContain("--network=none");
    expect(create).toContain("--user=1000:1000");
    expect(create).toContain("--cap-drop=ALL");
    expect(create).toContain("--security-opt=no-new-privileges");
    expect(create).toContain("--pids-limit=256");
    expect(create).toContain("--storage-opt=size=20G");
    expect(create).toContain(
      `type=volume,source=${resources.volume_ref},target=/workspace,volume-nocopy`,
    );
    expect(initialize).toEqual([
      "run",
      "--rm",
      "--network=none",
      "--user=0:0",
      "--mount",
      `type=volume,source=${resources.volume_ref},target=/workspace,volume-nocopy`,
      "--entrypoint",
      "/bin/chown",
      "node:22-bookworm-slim",
      "1000:1000",
      "/workspace",
    ]);
    expect(volume).toEqual([
      "volume",
      "create",
      "--driver",
      "local",
      "--opt",
      "type=none",
      "--opt",
      "device=/srv/sandbox",
      "--opt",
      "o=bind,pquota",
      resources.volume_ref,
    ]);
    expect(calls.some((args) => args[0] === "container" && args[1] === "start")).toBe(false);

    await driver.start({ sandbox_id: sandboxId, resources });
    expect(calls.some((args) => args[0] === "container" && args[1] === "start")).toBe(true);
  });

  it("adopts matching resources and rejects a prior container without the hard cap", async () => {
    const sandboxId = newId("sandbox");
    const resources = {
      volume_ref: `crossover-sbx-${sandboxId.toLowerCase()}`,
      container_ref: `crossover-sbx-${sandboxId.toLowerCase()}`,
    };
    const adopted = new DockerExecutionDriver({
      ...hardOptions,
      invoke: async (args) => {
        if (args[0] === "volume" && args[1] === "inspect")
          return {
            code: 0,
            stdout: 'local|{"type":"none","device":"/srv/sandbox","o":"bind,pquota"}',
            stderr: "",
          };
        if (args[0] === "container" && args[1] === "inspect" && args[3] === "{{.State.Running}}")
          return { code: 0, stdout: "false", stderr: "" };
        if (
          args[0] === "container" &&
          args[1] === "inspect" &&
          args[3] === "{{.Config.User}}|{{.HostConfig.NetworkMode}}|{{.HostConfig.Runtime}}"
        )
          return { code: 0, stdout: "1000:1000|none|", stderr: "" };
        if (args[0] === "container" && args[1] === "inspect")
          return { code: 0, stdout: '{"size":"20G"}', stderr: "" };
        return { code: 1, stdout: "", stderr: "unexpected Docker invocation" };
      },
    });
    await expect(
      adopted.create({
        sandbox_id: sandboxId,
        room_id: newId("room"),
        participant_id: newId("part"),
        limits: { disk_enforcement: "hard" },
      }),
    ).resolves.toEqual(resources);

    const unsafe = new DockerExecutionDriver({
      ...hardOptions,
      invoke: async (args) => {
        if (args[0] === "volume" && args[1] === "inspect")
          return {
            code: 0,
            stdout: 'local|{"type":"none","device":"/srv/sandbox","o":"bind,pquota"}',
            stderr: "",
          };
        if (args[0] === "container" && args[1] === "inspect" && args[3] === "{{.State.Running}}")
          return { code: 0, stdout: "false", stderr: "" };
        if (
          args[0] === "container" &&
          args[1] === "inspect" &&
          args[3] === "{{.Config.User}}|{{.HostConfig.NetworkMode}}|{{.HostConfig.Runtime}}"
        )
          return { code: 0, stdout: "1000:1000|none|", stderr: "" };
        if (args[0] === "container" && args[1] === "inspect")
          return { code: 0, stdout: "{}", stderr: "" };
        return { code: 1, stdout: "", stderr: "unexpected Docker invocation" };
      },
    });
    await expect(
      unsafe.create({
        sandbox_id: sandboxId,
        room_id: newId("room"),
        participant_id: newId("part"),
        limits: { disk_enforcement: "hard" },
      }),
    ).rejects.toThrow("does not enforce its 20 GB writable-layer cap");
  });

  it("rejects an existing sandbox container that predates the isolation defaults", async () => {
    const calls: string[][] = [];
    const driver = new DockerExecutionDriver({
      invoke: async (args) => {
        calls.push([...args]);
        if (args[0] === "volume" && args[1] === "inspect")
          return { code: 0, stdout: "local|{}", stderr: "" };
        if (args[0] === "container" && args[1] === "inspect" && args[3] === "{{.State.Running}}")
          return { code: 0, stdout: "false", stderr: "" };
        if (
          args[0] === "container" &&
          args[1] === "inspect" &&
          args[3] === "{{.Config.User}}|{{.HostConfig.NetworkMode}}|{{.HostConfig.Runtime}}"
        )
          return { code: 0, stdout: "0|bridge|", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });

    await expect(
      driver.create({
        sandbox_id: newId("sandbox"),
        room_id: newId("room"),
        participant_id: newId("part"),
        limits: { disk_enforcement: "soft" },
      }),
    ).rejects.toThrow("does not enforce non-root and network isolation");
    expect(calls.some((args) => args[0] === "container" && args[1] === "create")).toBe(false);
  });

  it("uses the configured Docker runtime for sandbox and volume setup", async () => {
    const calls: string[][] = [];
    const driver = new DockerExecutionDriver({
      runtime: "runsc",
      invoke: async (args) => {
        calls.push([...args]);
        return missingResources(args);
      },
    });
    await driver.create({
      sandbox_id: newId("sandbox"),
      room_id: newId("room"),
      participant_id: newId("part"),
      limits: { disk_enforcement: "soft" },
    });

    for (const invocation of [
      calls.find((args) => args[0] === "run")!,
      calls.find((args) => args[0] === "container" && args[1] === "create")!,
    ]) {
      const runtimeIndex = invocation.indexOf("--runtime");
      expect(invocation[runtimeIndex + 1]).toBe("runsc");
    }
  });

  it("attaches proxy-enabled sandboxes to an isolated per-sandbox network", async () => {
    const calls: string[][] = [];
    let networkExists = false;
    let proxyConnected = false;
    let containerExists = false;
    const driver = new DockerExecutionDriver({
      egressProxyContainer: "crossover-egress-proxy",
      egressProxyPort: 3128,
      egressProxySecret: "0123456789abcdef0123456789abcdef",
      invoke: async (args) => {
        calls.push([...args]);
        if (args[0] === "network" && args[1] === "inspect") {
          if (!networkExists)
            return {
              code: 1,
              stdout: "",
              stderr: "Error response from daemon: network crossover-net-test not found",
            };
          return {
            code: 0,
            stdout: `true|${JSON.stringify(proxyConnected ? { proxy: { Name: "crossover-egress-proxy" } } : {})}`,
            stderr: "",
          };
        }
        if (args[0] === "network" && args[1] === "create") networkExists = true;
        if (args[0] === "network" && args[1] === "connect") proxyConnected = true;
        if (args[0] === "container" && args[1] === "inspect")
          return containerExists
            ? { code: 0, stdout: "false", stderr: "" }
            : { code: 1, stdout: "", stderr: "Error response from daemon: No such container" };
        if (args[0] === "container" && args[1] === "create") containerExists = true;
        return missingResources(args);
      },
    });
    const sandboxId = newId("sandbox");
    const resources = await driver.create({
      sandbox_id: sandboxId,
      room_id: newId("room"),
      participant_id: newId("part"),
      limits: { disk_enforcement: "soft" },
    });
    const network = `crossover-net-${sandboxId.toLowerCase()}`;
    const create = calls.find((args) => args[0] === "container" && args[1] === "create")!;
    const sandboxEnvironment = create.flatMap((value, index) =>
      create[index - 1] === "--env" ? [value] : [],
    );

    expect(calls.find((args) => args[0] === "network" && args[1] === "create")).toEqual([
      "network",
      "create",
      "--internal",
      "--label",
      "crossover.sandbox=true",
      network,
    ]);
    expect(calls.find((args) => args[0] === "network" && args[1] === "connect")).toEqual([
      "network",
      "connect",
      network,
      "crossover-egress-proxy",
    ]);
    expect(create).toContain(`--network=${network}`);
    const proxyUrl = `http://${sandboxId}:${createSandboxProxyCredential(sandboxId, "0123456789abcdef0123456789abcdef")}@crossover-egress-proxy:3128`;
    expect(create).toContain(`HTTP_PROXY=${proxyUrl}`);
    expect(create).toContain(`HTTPS_PROXY=${proxyUrl}`);
    expect(create).toContain("NO_PROXY=localhost,127.0.0.1,::1");
    expect(sandboxEnvironment.map((entry) => entry.slice(0, entry.indexOf("="))).sort()).toEqual([
      "ALL_PROXY",
      "HOME",
      "HTTPS_PROXY",
      "HTTP_PROXY",
      "NO_PROXY",
      "all_proxy",
      "http_proxy",
      "https_proxy",
      "no_proxy",
    ]);
    expect(sandboxEnvironment.join("\n")).not.toContain("0123456789abcdef0123456789abcdef");

    await driver.destroy({ sandbox_id: sandboxId, resources });
    expect(calls).toContainEqual([
      "network",
      "disconnect",
      "--force",
      network,
      "crossover-egress-proxy",
    ]);
    expect(calls).toContainEqual(["network", "rm", network]);
  });

  it("uses soft mode without Docker quotas and fails closed when hard volume configuration is absent", async () => {
    const calls: string[][] = [];
    const invoke: DockerInvoker = async (args) => {
      calls.push([...args]);
      return missingResources(args);
    };
    const soft = new DockerExecutionDriver({ invoke });
    const sandboxId = newId("sandbox");
    const resources = await soft.create({
      sandbox_id: sandboxId,
      room_id: newId("room"),
      participant_id: newId("part"),
      limits: { disk_enforcement: "soft" },
    });
    const volume = calls.find((args) => args[0] === "volume" && args[1] === "create")!;
    const container = calls.find((args) => args[0] === "container" && args[1] === "create")!;
    expect(volume).toHaveLength(3);
    expect(container).not.toContain("--storage-opt=size=20G");

    const before = calls.length;
    await expect(
      soft.create({
        sandbox_id: newId("sandbox"),
        room_id: newId("room"),
        participant_id: newId("part"),
        limits: { disk_enforcement: "hard" },
      }),
    ).rejects.toThrow("ERROR: SANDBOX_DISK_ENFORCEMENT=hard requires SANDBOX_VOLUME_DRIVER");
    expect(calls).toHaveLength(before);

    await expect(soft.start({ sandbox_id: newId("sandbox"), resources })).rejects.toThrow(
      "resource references do not match sandbox",
    );
  });

  it("fails closed with clear errors when Docker rejects either hard quota", async () => {
    const input = {
      sandbox_id: newId("sandbox"),
      room_id: newId("room"),
      participant_id: newId("part"),
      limits: { disk_enforcement: "hard" as const },
    };
    const rejectedVolume = new DockerExecutionDriver({
      ...hardOptions,
      invoke: async (args) => {
        if (args[0] === "volume" && args[1] === "inspect")
          return { code: 1, stdout: "", stderr: "Error: no such volume: sandbox" };
        if (args[0] === "volume" && args[1] === "create")
          return { code: 1, stdout: "", stderr: "driver does not support quota" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    await expect(rejectedVolume.create(input)).rejects.toThrow(
      "ERROR: hard-enforced workspace volume creation failed: driver does not support quota",
    );

    const rejectedContainer = new DockerExecutionDriver({
      ...hardOptions,
      invoke: async (args) => {
        if (args[0] === "volume" && args[1] === "inspect")
          return { code: 1, stdout: "", stderr: "Error: no such volume: sandbox" };
        if (args[0] === "container" && args[1] === "inspect")
          return {
            code: 1,
            stdout: "",
            stderr: "Error response from daemon: No such container: sandbox",
          };
        if (args[0] === "container" && args[1] === "create")
          return { code: 1, stdout: "", stderr: "storage option is unsupported" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    await expect(rejectedContainer.create(input)).rejects.toThrow(
      "ERROR: hard-enforced sandbox container creation failed: storage option is unsupported",
    );
  });

  const dockerImageAvailable = (() => {
    try {
      execFileSync("docker", ["image", "inspect", "node:22-bookworm-slim"], {
        stdio: "ignore",
        timeout: 1000,
      });
      return true;
    } catch {
      return false;
    }
  })();
  const skipDockerIntegration = !dockerImageAvailable && !process.env["CI"];

  it.skipIf(skipDockerIntegration)(
    "creates, hibernates, resumes and removes a soft-mode Docker sandbox",
    async () => {
      const driver = new DockerExecutionDriver();
      const sandboxId = newId("sandbox");
      const resources = await driver.create({
        sandbox_id: sandboxId,
        room_id: newId("room"),
        participant_id: newId("part"),
        limits: { disk_enforcement: "soft" },
      });
      try {
        await driver.start({ sandbox_id: sandboxId, resources });
        execFileSync("docker", [
          "exec",
          resources.container_ref,
          "sh",
          "-c",
          "touch /workspace/.nonroot",
        ]);
        const probe =
          "const net=require('node:net');const socket=net.createConnection({host:process.argv[1],port:80});const timer=setTimeout(()=>{socket.destroy();process.exit(0)},1500);socket.once('connect',()=>{clearTimeout(timer);process.exit(1)});socket.once('error',()=>{clearTimeout(timer);process.exit(0)});";
        for (const host of ["example.com", "169.254.169.254"])
          execFileSync("docker", ["exec", resources.container_ref, "node", "-e", probe, host], {
            stdio: "ignore",
            timeout: 5000,
          });
        const environment = execFileSync("docker", ["exec", resources.container_ref, "env"], {
          encoding: "utf8",
          timeout: 5000,
        });
        expect(environment).not.toMatch(/(?:TOKEN|SECRET|PASSWORD|API_KEY)=/i);
        await driver.stop({ sandbox_id: sandboxId, resources });
        await driver.start({ sandbox_id: sandboxId, resources });
      } finally {
        await driver.destroy({ sandbox_id: sandboxId, resources });
      }
    },
    15_000,
  );
});
