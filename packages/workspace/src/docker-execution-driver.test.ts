import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { newId } from "@crossover/protocol";
import { DockerExecutionDriver, type DockerInvoker } from "./docker-execution-driver.js";

const hardOptions = {
  volumeDriver: "local",
  volumeOptions: { type: "none", device: "/srv/sandbox", o: "bind,pquota" },
};

function missingResources(args: readonly string[]) {
  if (args[0] === "volume" && args[1] === "inspect")
    return { code: 1, stdout: "", stderr: "Error: no such volume: sandbox" };
  if (args[0] === "container" && args[1] === "inspect")
    return { code: 1, stdout: "", stderr: "Error: No such object: sandbox" };
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
          : { code: 1, stdout: "", stderr: "Error: No such object: sandbox" };
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
    const expectedName = `crossover-sbx-${sandboxId.toLowerCase()}`;

    expect(resources).toEqual({ volume_ref: expectedName, container_ref: expectedName });
    expect(create).toContain("--cpus=2");
    expect(create).toContain("--memory=4g");
    expect(create).toContain("--storage-opt=size=20G");
    expect(create).toContain(`type=volume,source=${resources.volume_ref},target=/workspace`);
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
          return { code: 1, stdout: "", stderr: "Error: No such object: sandbox" };
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

  it.skipIf(!dockerImageAvailable)(
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
        await driver.stop({ sandbox_id: sandboxId, resources });
        await driver.start({ sandbox_id: sandboxId, resources });
      } finally {
        await driver.destroy({ sandbox_id: sandboxId, resources });
      }
    },
  );
});
