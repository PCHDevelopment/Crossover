import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { newId } from "@crossover/protocol";
import { createSandboxProxyCredential, verifySandboxReadToken } from "@crossover/security";
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
  it("runs the fetcher on crossover-git with a short-lived token and hardening", async () => {
    const calls: Array<{ args: string[]; timeoutMs?: number; env?: NodeJS.ProcessEnv }> = [];
    const secret = "a sufficiently long internal Git signing secret";
    let networkExists = false;
    let serverConnected = false;
    const invoke: DockerInvoker = async (input, options) => {
      const args = [...input];
      calls.push({
        args,
        ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options?.env ? { env: options.env } : {}),
      });
      if (args[0] === "network" && args[1] === "inspect") {
        return networkExists
          ? {
              code: 0,
              stdout: `true|${JSON.stringify(serverConnected ? { endpoint: { Name: "crossover-server" } } : {})}`,
              stderr: "",
            }
          : { code: 1, stdout: "", stderr: "Error: no such network: crossover-git" };
      }
      if (args[0] === "network" && args[1] === "create") {
        networkExists = true;
        return { code: 0, stdout: "crossover-git", stderr: "" };
      }
      if (args[0] === "network" && args[1] === "connect") {
        serverConnected = true;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "container" && args[1] === "rm")
        return { code: 1, stdout: "", stderr: "Error: No such container" };
      if (args[0] === "run") return { code: 0, stdout: "", stderr: "" };
      return { code: 1, stdout: "", stderr: `unexpected Docker invocation: ${args.join(" ")}` };
    };
    const driver = new DockerExecutionDriver({
      invoke,
      gitInternalContainer: "crossover-server",
      gitInternalPort: 8081,
      gitInternalTokenSecret: secret,
      gitFetcherImage: "crossover-git-fetcher:test",
    });
    const sandboxId = newId("sandbox");
    const roomId = newId("room");
    const participantId = newId("part");
    const suffix = sandboxId.toLowerCase();

    await driver.materialize({
      sandbox_id: sandboxId,
      room_id: roomId,
      participant_id: participantId,
      resources: {
        volume_ref: `crossover-sbx-${suffix}`,
        container_ref: `crossover-sbx-${suffix}`,
      },
      workspace: { repo_path: `/workspace/${roomId}.git`, revision: 5 },
    });

    const run = calls.find(({ args }) => args[0] === "run")!;
    const connect = calls.find(({ args }) => args[0] === "network" && args[1] === "connect")!;
    const runArgs = run.args;
    const credential = run.env?.GIT_CONFIG_VALUE_0?.split("Bearer ")[1];
    expect(connect.args).toEqual(["network", "connect", "crossover-git", "crossover-server"]);
    expect(runArgs).toContain("--network=crossover-git");
    expect(runArgs).toContain("--read-only");
    expect(runArgs).toContain("GIT_CONFIG_VALUE_0");
    expect(runArgs.some((arg) => arg.includes(credential!))).toBe(false);
    expect(runArgs).toContain("--user=1000:1000");
    expect(runArgs).toContain("--cap-drop=ALL");
    expect(runArgs).toContain("--security-opt=no-new-privileges");
    expect(runArgs).toContain(
      `type=volume,source=crossover-sbx-${suffix},target=/workspace,volume-nocopy`,
    );
    expect(runArgs).toContain(
      `type=bind,source=/workspace/${roomId}.git,target=/reference.git,readonly`,
    );
    expect(runArgs).toContain(
      `GIT_REMOTE_URL=http://crossover-server:8081/git/${roomId}/${sandboxId}/5`,
    );
    expect(verifySandboxReadToken(credential!, secret)).toMatchObject({
      room_id: roomId,
      participant_id: participantId,
      sandbox_id: sandboxId,
      revision: 5,
    });
    expect(run.timeoutMs).toBeLessThanOrEqual(5 * 60 * 1000);
    expect(runArgs.at(-1)).toBe("crossover-git-fetcher:test");
  });

  it("reads status from the sandbox volume with an isolated Git helper", async () => {
    const calls: string[][] = [];
    const driver = new DockerExecutionDriver({
      invoke: async (args) => {
        calls.push([...args]);
        return {
          code: 0,
          stdout: " M src/changed.ts\0?? notes/new.md\0 D old.txt\0",
          stderr: "",
        };
      },
      gitFetcherImage: "crossover-git-fetcher:test",
    });
    const sandboxId = newId("sandbox");
    const suffix = sandboxId.toLowerCase();

    await expect(
      driver.status({
        sandbox_id: sandboxId,
        resources: {
          volume_ref: `crossover-sbx-${suffix}`,
          container_ref: `crossover-sbx-${suffix}`,
        },
      }),
    ).resolves.toEqual({
      modified: ["src/changed.ts"],
      added: ["notes/new.md"],
      deleted: ["old.txt"],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--network=none");
    expect(calls[0]).toContain("--read-only");
    expect(calls[0]).toContain("--cap-drop=ALL");
    expect(calls[0]).toContain("--security-opt=no-new-privileges");
    expect(calls[0]).toContain("--memory=512m");
    expect(calls[0]).toContain("--cpus=1");
    expect(calls[0]).toContain(
      `type=volume,source=crossover-sbx-${suffix},target=/workspace,readonly,volume-nocopy`,
    );
    expect(calls[0]).toContain("core.excludesFile=/workspace/.roomignore");
    expect(calls[0]).toContain("core.fsmonitor=false");
    expect(calls[0]).toContain("--no-renames");
    expect(calls[0]).toContain("crossover-git-fetcher:test");
  });

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
