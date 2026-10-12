import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CrossoverError, newId } from "@crossover/protocol";
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

async function startDockerSandbox(driver: DockerExecutionDriver) {
  const sandboxId = newId("sandbox");
  const resources = await driver.create({
    sandbox_id: sandboxId,
    room_id: newId("room"),
    participant_id: newId("part"),
    limits: { disk_enforcement: "soft" },
  });
  return driver.start({ sandbox_id: sandboxId, resources }).then(() => ({ sandboxId, resources }));
}

function expectMissing(container: string, path: string) {
  expect(() => execFileSync("docker", ["exec", container, "test", "-e", path])).toThrow();
}

describe("DockerExecutionDriver", () => {
  it("passes command text on stdin, keeps it out of Docker argv, and reports output failures distinctly", async () => {
    const root = await mkdtemp(join(tmpdir(), "crossover-docker-exec-stdin-"));
    try {
      const argsPath = join(root, "args");
      const inputPath = join(root, "input");
      const execId = newId("exec");
      const command = "printf 'private argv text'";
      const docker = join(root, "docker");
      await writeFile(
        docker,
        `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsPath}'\ncat > '${inputPath}'\nprintf 'CROSSOVER_EXEC_PGID:${execId}:123\\n' >&2\nprintf 'output'\n`,
      );
      await chmod(docker, 0o700);
      const driver = new DockerExecutionDriver({ dockerBinary: docker });
      const sandboxId = newId("sandbox");
      const name = `crossover-sbx-${sandboxId.toLowerCase()}`;
      const run = await driver.exec({
        sandbox_id: sandboxId,
        resources: { volume_ref: name, container_ref: name },
        exec_id: execId,
        command,
        cwd: "/workspace",
        timeoutMs: 10_000,
        onOutput: async () => {
          throw new Error("injected output callback failure");
        },
      });

      await expect(run.finished).resolves.toMatchObject({
        reason: "output_failed",
        exit_code: null,
      });
      const args = await readFile(argsPath, "utf8");
      expect(args).not.toContain(command);
      expect(await readFile(inputPath, "utf8")).toBe(Buffer.from(command).toString("base64"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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
      truncated: false,
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

  it("isolates snapshot reads and installs behind a bounded no-network helper", async () => {
    const calls: Array<{ args: string[]; input: string }> = [];
    let unprunedError: string | undefined;
    const driver = new DockerExecutionDriver({
      invoke: async (args, options) => {
        const input = String(options?.input ?? "");
        calls.push({ args: [...args], input });
        const request = JSON.parse(input) as {
          action: string;
          unprune_directories?: string[];
        };
        if (request.action === "inventory" && request.unprune_directories) {
          if (unprunedError)
            return { code: 1, stdout: JSON.stringify({ error: unprunedError }), stderr: "" };
          return {
            code: 0,
            stdout: JSON.stringify({
              entries: [
                {
                  path: Buffer.from("node_modules/new.txt").toString("base64"),
                  mode: "100644",
                  sha: null,
                  size: 0,
                },
              ],
              pruned_directories: [],
            }),
            stderr: "",
          };
        }
        return {
          code: 0,
          stdout:
            request.action === "inventory"
              ? JSON.stringify({
                  entries: [
                    {
                      path: Buffer.from("src/a.txt").toString("base64"),
                      mode: "100644",
                      sha: null,
                      size: 0,
                    },
                  ],
                  pruned_directories: [Buffer.from("node_modules").toString("base64")],
                })
              : JSON.stringify({ installed: true }),
          stderr: "",
        };
      },
      image: "node:test-image",
    });
    const sandboxId = newId("sandbox");
    const suffix = sandboxId.toLowerCase();
    const resources = {
      volume_ref: `crossover-sbx-${suffix}`,
      container_ref: `crossover-sbx-${suffix}`,
    };

    await expect(
      driver.snapshotInventory({
        sandbox_id: sandboxId,
        resources,
        tracked_paths: ["src/a.txt"],
        object_format: "sha1",
        ignore_rules: [{ path: ".gitignore", patterns: ["node_modules/"] }],
      }),
    ).resolves.toMatchObject([{ path: "src/a.txt", mode: "100644", sha: null, size: 0 }]);
    await expect(
      driver.snapshotInventory({
        sandbox_id: sandboxId,
        resources,
        tracked_paths: [],
        object_format: "sha1",
        ignore_rules: [{ path: ".gitignore", patterns: ["*.txt"] }],
      }),
    ).resolves.toMatchObject([{ path: "node_modules/new.txt" }]);
    unprunedError = "too_many_entries";
    await expect(
      driver.snapshotInventory({
        sandbox_id: sandboxId,
        resources,
        tracked_paths: [],
        object_format: "sha1",
        ignore_rules: [{ path: ".gitignore", patterns: ["*.txt"] }],
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      retryable: false,
      message: expect.stringContaining("node_modules"),
      details: { reason: "ignore_pruning_retry_failed", path: "node_modules" },
    });
    unprunedError = "changed_during_read";
    await expect(
      driver.snapshotInventory({
        sandbox_id: sandboxId,
        resources,
        tracked_paths: [],
        object_format: "sha1",
        ignore_rules: [{ path: ".gitignore", patterns: ["*.txt"] }],
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT_VERSION",
      retryable: true,
      details: { reason: "sandbox_changed_during_snapshot" },
    });
    unprunedError = undefined;
    await driver.updateSnapshot({
      sandbox_id: sandboxId,
      resources,
      files: [{ path: "src/a.txt", mode: "100644", content: Buffer.from("safe") }],
      delete_paths: ["old.txt"],
    });

    expect(calls).toHaveLength(8);
    const [read, mismatch, retry, , failedRetry, transientMismatch, transientRetry, install] =
      calls;
    expect(read!.args).toContain("--network=none");
    expect(read!.args).toContain("--read-only");
    expect(read!.args).toContain(
      `type=volume,source=crossover-sbx-${suffix},target=/workspace,readonly,volume-nocopy`,
    );
    expect(JSON.parse(read!.input)).toMatchObject({
      action: "inventory",
      tracked_paths: [Buffer.from("src/a.txt").toString("base64")],
      ignore_rules: [{ path: ".gitignore", patterns: ["node_modules/"] }],
    });
    expect(JSON.parse(mismatch!.input)).toMatchObject({
      ignore_rules: [{ path: ".gitignore", patterns: ["*.txt"] }],
    });
    expect(JSON.parse(retry!.input)).toMatchObject({
      unprune_directories: [Buffer.from("node_modules").toString("base64")],
    });
    expect(JSON.parse(failedRetry!.input)).toMatchObject({
      unprune_directories: [Buffer.from("node_modules").toString("base64")],
    });
    expect(JSON.parse(transientMismatch!.input)).toMatchObject({
      ignore_rules: [{ path: ".gitignore", patterns: ["*.txt"] }],
    });
    expect(JSON.parse(transientRetry!.input)).toMatchObject({
      unprune_directories: [Buffer.from("node_modules").toString("base64")],
    });
    expect(install!.args).toContain("--network=none");
    expect(install!.args).not.toContain(
      `type=volume,source=crossover-sbx-${suffix},target=/workspace,readonly,volume-nocopy`,
    );
    expect(JSON.parse(install!.input)).toMatchObject({
      action: "install",
      files: [
        {
          path: Buffer.from("src/a.txt").toString("base64"),
          content: Buffer.from("safe").toString("base64"),
        },
      ],
      delete_paths: [Buffer.from("old.txt").toString("base64")],
    });
  });

  it("reads one file through the bounded read-only snapshot helper", async () => {
    const sandboxId = newId("sandbox");
    const encodedPath = Buffer.from("src/hello.ts").toString("base64");
    const bytes = Buffer.from("export const hello = 'world';\n");
    let invocation: readonly string[] = [];
    let request = "";
    const driver = new DockerExecutionDriver({
      image: "node:test-image",
      invoke: async (args, options) => {
        invocation = args;
        request = String(options?.input ?? "");
        return {
          code: 0,
          stdout: JSON.stringify({
            file: {
              path: encodedPath,
              mode: "100644",
              size: bytes.length,
              content: bytes.toString("base64"),
            },
          }),
          stderr: "",
        };
      },
    });
    const suffix = sandboxId.toLowerCase();
    const resources = {
      volume_ref: `crossover-sbx-${suffix}`,
      container_ref: `crossover-sbx-${suffix}`,
    };

    await expect(
      driver.readFile({ sandbox_id: sandboxId, resources, path: "src/hello.ts", max_bytes: 1024 }),
    ).resolves.toEqual({ mode: "100644", content: bytes });
    expect(JSON.parse(request)).toMatchObject({
      action: "file_read",
      path: encodedPath,
      max_bytes: 1024,
    });
    expect(invocation).toContain("--network=none");
    expect(invocation).toContain("--read-only");
    expect(invocation).toContain(
      `type=volume,source=${resources.volume_ref},target=/workspace,readonly,volume-nocopy`,
    );
  });

  it("reports the actual size and limit when a bounded file read is too large", async () => {
    const sandboxId = newId("sandbox");
    const suffix = sandboxId.toLowerCase();
    const resources = {
      volume_ref: `crossover-sbx-${suffix}`,
      container_ref: `crossover-sbx-${suffix}`,
    };
    const driver = new DockerExecutionDriver({
      invoke: async () => ({
        code: 0,
        stdout: JSON.stringify({ error: "too_large", size: 1025, limit: 1024 }),
        stderr: "",
      }),
    });

    await expect(
      driver.readFile({ sandbox_id: sandboxId, resources, path: "large.bin", max_bytes: 1024 }),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      details: { reason: "file_too_large", size: 1025, limit: 1024 },
    });
  });

  it("streams status beyond 8 MiB and stops at the entry limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "crossover-status-stream-test-"));
    const fakeDocker = join(root, "docker.mjs");
    await writeFile(
      fakeDocker,
      [
        "#!/usr/bin/env node",
        'import { once } from "node:events";',
        'const longComponent = "x".repeat(180);',
        "for (let index = 0; index < 20_000; index++) {",
        '  const path = Array.from({ length: 6 }, (_, part) => index + "-" + part + "-" + longComponent).join("/");',
        '  if (!process.stdout.write("?? " + path + "\\0")) await once(process.stdout, "drain");',
        "}",
        "",
      ].join("\n"),
    );
    await chmod(fakeDocker, 0o755);

    try {
      const driver = new DockerExecutionDriver({ dockerBinary: fakeDocker });
      const sandboxId = newId("sandbox");
      const status = await driver.status({
        sandbox_id: sandboxId,
        resources: {
          volume_ref: `crossover-sbx-${sandboxId.toLowerCase()}`,
          container_ref: `crossover-sbx-${sandboxId.toLowerCase()}`,
        },
      });

      expect(status.added).toHaveLength(10_000);
      expect(status.truncated).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);

  it("treats the streamed byte backstop as truncation", async () => {
    const root = await mkdtemp(join(tmpdir(), "crossover-status-byte-cap-test-"));
    const fakeDocker = join(root, "docker.mjs");
    await writeFile(
      fakeDocker,
      [
        "#!/usr/bin/env node",
        'import { once } from "node:events";',
        'const longComponent = "x".repeat(240);',
        "for (let index = 0; index < 20_000; index++) {",
        '  const path = Array.from({ length: 8 }, (_, part) => index + "-" + part + "-" + longComponent).join("/");',
        '  if (!process.stdout.write("?? " + path + "\\0")) await once(process.stdout, "drain");',
        "}",
        "",
      ].join("\n"),
    );
    await chmod(fakeDocker, 0o755);

    try {
      const driver = new DockerExecutionDriver({ dockerBinary: fakeDocker });
      const sandboxId = newId("sandbox");
      const status = await driver.status({
        sandbox_id: sandboxId,
        resources: {
          volume_ref: `crossover-sbx-${sandboxId.toLowerCase()}`,
          container_ref: `crossover-sbx-${sandboxId.toLowerCase()}`,
        },
      });

      expect(status.added.length).toBeGreaterThan(0);
      expect(status.added.length).toBeLessThan(10_000);
      expect(status.truncated).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);

  it("returns a retryable generic error when Git status fails without exposing stderr", async () => {
    const driver = new DockerExecutionDriver({
      invoke: async () => ({ code: 128, stdout: "", stderr: "private helper details" }),
      gitFetcherImage: "crossover-git-fetcher:test",
    });
    const sandboxId = newId("sandbox");
    const error = await driver
      .status({
        sandbox_id: sandboxId,
        resources: {
          volume_ref: `crossover-sbx-${sandboxId.toLowerCase()}`,
          container_ref: `crossover-sbx-${sandboxId.toLowerCase()}`,
        },
      })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(CrossoverError);
    expect(error).toMatchObject({ code: "UNAVAILABLE", retryable: true });
    expect((error as Error).message).not.toContain("private helper details");
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

  it("accepts an existing local volume with null options in soft mode", async () => {
    const driver = new DockerExecutionDriver({
      invoke: async (args) => {
        if (args[0] === "volume" && args[1] === "inspect")
          return { code: 0, stdout: "local|null", stderr: "" };
        return missingResources(args);
      },
    });

    await expect(
      driver.create({
        sandbox_id: newId("sandbox"),
        room_id: newId("room"),
        participant_id: newId("part"),
        limits: { disk_enforcement: "soft" },
      }),
    ).resolves.toMatchObject({ volume_ref: expect.any(String), container_ref: expect.any(String) });
  });

  it("rejects an existing local volume with null options when hard options are required", async () => {
    const driver = new DockerExecutionDriver({
      ...hardOptions,
      invoke: async (args) => {
        if (args[0] === "volume" && args[1] === "inspect")
          return { code: 0, stdout: "local|null", stderr: "" };
        return missingResources(args);
      },
    });

    await expect(
      driver.create({
        sandbox_id: newId("sandbox"),
        room_id: newId("room"),
        participant_id: newId("part"),
        limits: { disk_enforcement: "hard" },
      }),
    ).rejects.toThrow("does not match SANDBOX_VOLUME_DRIVER and SANDBOX_VOLUME_OPTS");
  });

  it("rejects array-valued Docker volume options", async () => {
    const driver = new DockerExecutionDriver({
      invoke: async (args) => {
        if (args[0] === "volume" && args[1] === "inspect")
          return { code: 0, stdout: "local|[]", stderr: "" };
        return missingResources(args);
      },
    });

    await expect(
      driver.create({
        sandbox_id: newId("sandbox"),
        room_id: newId("room"),
        participant_id: newId("part"),
        limits: { disk_enforcement: "soft" },
      }),
    ).rejects.toThrow("ERROR: Docker returned invalid volume inspection data");
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
    "reuses and removes a real default Docker volume with null inspect options",
    async () => {
      const driver = new DockerExecutionDriver();
      const sandboxId = newId("sandbox");
      const name = `crossover-sbx-${sandboxId.toLowerCase()}`;
      let resources: Awaited<ReturnType<typeof driver.create>> | undefined;
      let destroyed = false;
      try {
        expect(
          execFileSync("docker", ["volume", "create", name], {
            encoding: "utf8",
            timeout: 20_000,
          }).trim(),
        ).toBe(name);
        expect(
          execFileSync(
            "docker",
            ["volume", "inspect", "--format", "{{.Driver}}|{{json .Options}}", name],
            { encoding: "utf8", timeout: 10_000 },
          ).trim(),
        ).toBe("local|null");

        resources = await driver.create({
          sandbox_id: sandboxId,
          room_id: newId("room"),
          participant_id: newId("part"),
          limits: { disk_enforcement: "soft" },
        });
        expect(resources.volume_ref).toBe(name);
        await driver.start({ sandbox_id: sandboxId, resources });

        let stdout = "";
        const execution = await driver.exec({
          sandbox_id: sandboxId,
          resources,
          exec_id: newId("exec"),
          command: "printf T1415-real-docker-smoke",
          cwd: "/workspace",
          timeoutMs: 10_000,
          onOutput: async (stream, chunk) => {
            if (stream === "stdout") stdout += chunk.toString("utf8");
          },
        });
        await expect(execution.finished).resolves.toMatchObject({ reason: "exit", exit_code: 0 });
        expect(stdout).toBe("T1415-real-docker-smoke");

        await driver.destroy({ sandbox_id: sandboxId, resources });
        destroyed = true;
        expect(() =>
          execFileSync("docker", ["volume", "inspect", name], { stdio: "ignore" }),
        ).toThrow();
        expect(() =>
          execFileSync("docker", ["container", "inspect", name], { stdio: "ignore" }),
        ).toThrow();
      } finally {
        if (!destroyed) {
          for (const args of [
            ["container", "rm", "--force", name],
            ["volume", "rm", "--force", name],
          ]) {
            try {
              execFileSync("docker", args, { stdio: "ignore", timeout: 10_000 });
            } catch {
              // Cleanup is best effort here so the original assertion remains visible.
            }
          }
        }
      }
    },
    30_000,
  );

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

  it.skipIf(skipDockerIntegration)(
    "snapshots and installs files from a real unprivileged sandbox volume",
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

        const sandboxBytes = Buffer.from([0x00, 0x01, 0x7f, 0xff, 0x0a]);
        const sandboxFiles = `
          const fs = require("node:fs");
          fs.writeFileSync("/workspace/text.txt", "written by uid 1000\\n");
          fs.writeFileSync("/workspace/binary.bin", Buffer.from([0, 1, 127, 255, 10]));
          fs.mkdirSync("/workspace/private", { recursive: true });
          fs.writeFileSync("/workspace/private/mode-600.txt", "owner-readable");
          fs.chmodSync("/workspace/private/mode-600.txt", 0o600);
          fs.writeFileSync("/workspace/.gitignore", "node_modules/\\n");
          fs.mkdirSync("/workspace/node_modules/pkg", { recursive: true });
          fs.writeFileSync("/workspace/node_modules/pkg/index.js", "ignored");
          fs.symlinkSync("text.txt", "/workspace/text-link");
          fs.writeFileSync("/workspace/delete-me.txt", "remove in install delta");
          process.stdout.write(JSON.stringify({
            uid: process.getuid(),
            mode600: fs.statSync("/workspace/private/mode-600.txt").mode & 0o777,
          }));
        `;
        const sandboxWrite = JSON.parse(
          execFileSync("docker", ["exec", resources.container_ref, "node", "-e", sandboxFiles], {
            encoding: "utf8",
            timeout: 10_000,
          }),
        ) as { uid: number; mode600: number };
        expect(sandboxWrite).toEqual({ uid: 1000, mode600: 0o600 });

        // Model a readable root-owned parent and file from a fresh volume alongside sandbox writes.
        execFileSync(
          "docker",
          [
            "run",
            "--rm",
            "--network=none",
            "--user=0:0",
            "--mount",
            `type=volume,source=${resources.volume_ref},target=/workspace,volume-nocopy`,
            "--entrypoint",
            "sh",
            "node:22-bookworm-slim",
            "-c",
            "mkdir -p /workspace/root-owned && printf 'readable as uid 1000\\n' > /workspace/root-owned/file.txt && chmod 0755 /workspace/root-owned && chmod 0644 /workspace/root-owned/file.txt",
          ],
          { stdio: "ignore", timeout: 20_000 },
        );
        const rootOwnership = JSON.parse(
          execFileSync(
            "docker",
            [
              "exec",
              resources.container_ref,
              "node",
              "-e",
              'const fs=require("node:fs");process.stdout.write(JSON.stringify({uid:process.getuid(),directory:fs.statSync("/workspace/root-owned").uid,file:fs.statSync("/workspace/root-owned/file.txt").uid}));',
            ],
            { encoding: "utf8", timeout: 10_000 },
          ),
        ) as { uid: number; directory: number; file: number };
        expect(rootOwnership).toEqual({ uid: 1000, directory: 0, file: 0 });

        const expected = new Map<string, Buffer>([
          ["text.txt", Buffer.from("written by uid 1000\n")],
          ["binary.bin", sandboxBytes],
          ["private/mode-600.txt", Buffer.from("owner-readable")],
          [".gitignore", Buffer.from("node_modules/\n")],
          ["text-link", Buffer.from("text.txt")],
          ["delete-me.txt", Buffer.from("remove in install delta")],
          ["root-owned/file.txt", Buffer.from("readable as uid 1000\n")],
        ]);
        const inventory = await driver.snapshotInventory({
          sandbox_id: sandboxId,
          resources,
          tracked_paths: [...expected.keys()],
          object_format: "sha1",
          ignore_rules: [{ path: ".gitignore", patterns: ["node_modules/"] }],
        });
        const inventoryByPath = new Map(inventory.map((file) => [file.path, file]));
        expect([...inventoryByPath.keys()].sort()).toEqual([...expected.keys()].sort());
        expect(inventoryByPath.has("node_modules/pkg/index.js")).toBe(false);
        expect(inventoryByPath.get("private/mode-600.txt")?.mode).toBe("100644");
        expect(inventoryByPath.get("root-owned/file.txt")?.mode).toBe("100644");
        expect(inventoryByPath.get("text-link")).toMatchObject({ mode: "120000" });

        const snapshot = await driver.readSnapshotFiles({
          sandbox_id: sandboxId,
          resources,
          files: inventory,
          object_format: "sha1",
          max_bytes: 1024 * 1024,
        });
        const readByPath = new Map(snapshot.map((file) => [file.path, file]));
        for (const [path, bytes] of expected) expect(readByPath.get(path)?.content).toEqual(bytes);

        const installedText = Buffer.from("installed through the helper\n");
        const installedBinary = Buffer.from([0x00, 0xfe, 0xff, 0x0a]);
        await driver.updateSnapshot({
          sandbox_id: sandboxId,
          resources,
          files: [
            { path: "installed.txt", mode: "100644", content: installedText },
            { path: "installed.bin", mode: "100644", content: installedBinary },
          ],
          delete_paths: ["delete-me.txt"],
        });
        const afterInstall = JSON.parse(
          execFileSync(
            "docker",
            [
              "exec",
              resources.container_ref,
              "node",
              "-e",
              'const fs=require("node:fs");process.stdout.write(JSON.stringify({uid:process.getuid(),text:fs.readFileSync("/workspace/installed.txt","utf8"),binary:fs.readFileSync("/workspace/installed.bin").toString("base64"),deleted:fs.existsSync("/workspace/delete-me.txt")}));',
            ],
            { encoding: "utf8", timeout: 10_000 },
          ),
        ) as { uid: number; text: string; binary: string; deleted: boolean };
        expect(afterInstall).toEqual({
          uid: 1000,
          text: installedText.toString("utf8"),
          binary: installedBinary.toString("base64"),
          deleted: false,
        });
      } finally {
        await driver.destroy({ sandbox_id: sandboxId, resources });
      }
    },
    120_000,
  );

  it.skipIf(skipDockerIntegration)(
    "ignores a tampered pid file and times out its process group",
    async () => {
      const driver = new DockerExecutionDriver();
      const { sandboxId, resources } = await startDockerSandbox(driver);
      try {
        const execId = newId("exec");
        const childEffect = `/tmp/crossover-child-${execId}`;
        const running = await driver.exec({
          sandbox_id: sandboxId,
          resources,
          exec_id: execId,
          command: `printf '99999999\\n' > /tmp/crossover-${execId}.pid; (sleep 1; touch ${childEffect}) & wait`,
          cwd: "/workspace",
          timeoutMs: 250,
          onOutput: async () => {},
        });
        await expect(running.finished).resolves.toMatchObject({ reason: "timed_out" });
        await new Promise((resolve) => setTimeout(resolve, 1_100));
        expectMissing(resources.container_ref, childEffect);
      } finally {
        await driver.destroy({ sandbox_id: sandboxId, resources });
      }
    },
    30_000,
  );
  it.skipIf(skipDockerIntegration)(
    "restarts the sandbox to kill a detached setsid child",
    async () => {
      const driver = new DockerExecutionDriver();
      const { sandboxId, resources } = await startDockerSandbox(driver);
      try {
        const execId = newId("exec");
        const ready = `/tmp/crossover-ready-${execId}`;
        const escaped = `/tmp/crossover-escaped-${execId}`;
        const { finished } = await driver.exec({
          sandbox_id: sandboxId,
          resources,
          exec_id: execId,
          command: `setsid sh -lc 'touch ${ready}; sleep 1; touch ${escaped}' >/dev/null 2>&1 & while [ ! -e ${ready} ]; do sleep .01; done`,
          cwd: "/workspace",
          timeoutMs: 60_000,
          onOutput: async () => {},
        });
        await expect(finished).resolves.toMatchObject({ reason: "exit", exit_code: 0 });
        await driver.restart({ sandbox_id: sandboxId, resources });
        await new Promise((resolve) => setTimeout(resolve, 1_100));
        expectMissing(resources.container_ref, escaped);
      } finally {
        await driver.destroy({ sandbox_id: sandboxId, resources });
      }
    },
    30_000,
  );
});
