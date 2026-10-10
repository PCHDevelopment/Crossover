import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ToolRegistry, type ToolExecutionSpec, type ToolInvocation } from "@crossover/kernel";
import { verifyPluginProxyCredential } from "@crossover/security";
import { z } from "zod";
import { DockerToolRunner, type PluginDockerInvoker } from "./plugin-runner.js";
import { PLUGIN_SWEEP_INTERVAL_MS, PluginResourceSweeper } from "./plugin-runner-docker.js";

const SECRET = "plugin-proxy-secret-with-at-least-32-bytes";
const TOKEN = "short-lived-provider-token";

function registry(
  options: {
    hosts?: readonly string[];
    idempotent?: boolean;
    integrations?: ToolExecutionSpec["integrations"];
    maxOutputBytes?: number;
    pidsLimit?: number;
    name?: string;
    capability?: string;
    roomEgressAllowlist?: boolean;
  } = {},
) {
  const tools = new ToolRegistry();
  tools.register({
    name: options.name ?? "github.read_repository",
    description: "Read one repository",
    capability: options.capability ?? "github.read_repository",
    tier: 0,
    input: z.object({ repo: z.string() }),
    scope: (args) => args.repo,
    idempotent: options.idempotent ?? true,
    execution: {
      image: `busybox:1.36.1-musl@sha256:${"a".repeat(64)}`,
      command: ["node", "dist/worker.js"],
      egressHosts: options.hosts ?? ["API.GITHUB.COM."],
      ...(options.roomEgressAllowlist ? { roomEgressAllowlist: true } : {}),
      ...(options.pidsLimit === undefined ? {} : { pidsLimit: options.pidsLimit }),
      ...(options.integrations ? { integrations: options.integrations } : {}),
      ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
    },
  });
  return tools;
}

const invocation: ToolInvocation = {
  tool: "github.read_repository",
  args: { repo: "acme/widgets" },
  capability: "github.read_repository:acme/widgets",
  scope: "acme/widgets",
  room_id: "room_01J8D9M8T2B7K4V5W6X3Y2Z1AB",
  participant_id: "part_01J8D9M8T2B7K4V5W6X3Y2Z1AB",
  invocation_id: "cmd_01J8D9M8T2B7K4V5W6X3Y2Z1AB",
};

describe("DockerToolRunner", () => {
  it("runs each invocation in a bounded container with scoped egress and only selected credentials", async () => {
    const calls: { args: readonly string[]; options: Parameters<PluginDockerInvoker>[2] }[] = [];
    let environmentContents = "";
    let environmentMode = 0;
    let environmentFile = "";
    const invoke: PluginDockerInvoker = async (_binary, args, options) => {
      calls.push({ args, options });
      if (args[0] === "run") {
        const envFileIndex = args.indexOf("--env-file");
        environmentFile = args[envFileIndex + 1]!;
        const [contents, fileStat] = await Promise.all([
          readFile(environmentFile, "utf8"),
          stat(environmentFile),
        ]);
        environmentContents = contents;
        environmentMode = fileStat.mode & 0o777;
      }
      return args[0] === "run"
        ? { code: 0, stdout: '{"result":{"ok":true}}', stderr: "" }
        : { code: 0, stdout: "", stderr: "" };
    };
    const runner = new DockerToolRunner({
      registry: registry(),
      egressProxyContainer: "crossover-egress-proxy",
      egressProxySecret: SECRET,
      credentials: async () => ({ GITHUB_TOKEN: TOKEN }),
      invoke,
    });

    await expect(runner.run(invocation, new AbortController().signal)).resolves.toEqual({
      result: { ok: true },
    });

    const networkCreate = calls.find(
      (call) => call.args[0] === "network" && call.args[1] === "create",
    );
    expect(networkCreate?.args).toContain("--internal");
    expect(networkCreate?.args).toContain("--label");
    expect(calls.some((call) => call.args[0] === "network" && call.args[1] === "connect")).toBe(
      true,
    );
    const run = calls.find((call) => call.args[0] === "run")!;
    expect(run.args).toEqual(
      expect.arrayContaining([
        "--read-only",
        "--pull=never",
        "--user=1000:1000",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--pids-limit=64",
        "--cpus=1",
        "--memory=256m",
        "--memory-swap=256m",
        "--env-file",
      ]),
    );
    expect(run.args.join(" ")).not.toContain(TOKEN);
    expect(run.args).not.toContain("--env=DATABASE_URL");
    expect(run.options).not.toHaveProperty("env");
    expect(environmentContents).toContain(`GITHUB_TOKEN=${TOKEN}\n`);
    expect(environmentMode).toBe(0o600);
    await expect(readFile(environmentFile)).rejects.toMatchObject({ code: "ENOENT" });
    const env = Object.fromEntries(
      environmentContents
        .trimEnd()
        .split("\n")
        .map((entry) => {
          const separator = entry.indexOf("=");
          return [entry.slice(0, separator), entry.slice(separator + 1)];
        }),
    );
    const proxyUrl = new URL(env.HTTPS_PROXY!);
    const proxyToken = decodeURIComponent(proxyUrl.password);
    expect(verifyPluginProxyCredential(proxyToken, SECRET)).toMatchObject({
      invocationId: invocation.invocation_id,
      roomId: invocation.room_id,
      participantId: invocation.participant_id,
      hosts: ["api.github.com"],
    });
    expect(calls.some((call) => call.args[0] === "container" && call.args[1] === "rm")).toBe(true);
    expect(calls.some((call) => call.args[0] === "network" && call.args[1] === "disconnect")).toBe(
      true,
    );
    expect(calls.some((call) => call.args[0] === "network" && call.args[1] === "rm")).toBe(true);
  });

  it("fails with a stable validation error before starting Docker when the room host list is empty", async () => {
    const calls: { args: readonly string[]; options: Parameters<PluginDockerInvoker>[2] }[] = [];
    const invoke: PluginDockerInvoker = async (_binary, args, options) => {
      calls.push({ args, options });
      return args[0] === "run"
        ? { code: 0, stdout: '{"result":{"ok":true}}', stderr: "" }
        : { code: 0, stdout: "", stderr: "" };
    };
    const roomEgressHosts = vi.fn(async () => [] as string[]);
    const runner = new DockerToolRunner({
      registry: registry({ hosts: [], roomEgressAllowlist: true, pidsLimit: 256 }),
      egressProxyContainer: "crossover-egress-proxy",
      egressProxySecret: SECRET,
      roomEgressHosts,
      invoke,
    });

    await expect(runner.run(invocation, new AbortController().signal)).rejects.toMatchObject({
      name: "ToolProviderError",
      message: "egress not configured",
      options: { retryable: false, code: "VALIDATION" },
    });
    expect(roomEgressHosts).toHaveBeenCalledTimes(1);
    expect(roomEgressHosts).toHaveBeenCalledWith(invocation);
    expect(calls).toEqual([]);
  });

  it("maps a sanitized worker rate-limit response to a retryable stable provider error", async () => {
    const invoke: PluginDockerInvoker = async (_binary, args) =>
      args[0] === "run"
        ? {
            code: 1,
            stdout: JSON.stringify({
              error: { code: "rate_limited", retryable: true, retry_after: 12 },
            }),
            stderr: "",
          }
        : { code: 0, stdout: "", stderr: "" };
    const runner = new DockerToolRunner({
      registry: registry({ hosts: [] }),
      credentials: async () => ({ GITHUB_TOKEN: TOKEN }),
      invoke,
      sweepResources: false,
    });

    await expect(runner.run(invocation, new AbortController().signal)).rejects.toMatchObject({
      name: "ToolProviderError",
      options: {
        code: "RATE_LIMITED",
        retryable: true,
        details: { provider: "github", provider_code: "rate_limited", retry_after: 12 },
      },
    });
  });

  it("maps generic provider errors using the tool namespace", async () => {
    const invoke: PluginDockerInvoker = async (_binary, args) =>
      args[0] === "run"
        ? {
            code: 1,
            stdout: JSON.stringify({
              error: { code: "rate_limited", retryable: true, retry_after: 12 },
            }),
            stderr: "",
          }
        : { code: 0, stdout: "", stderr: "" };
    const runner = new DockerToolRunner({
      registry: registry({
        hosts: [],
        name: "calendar.list_events",
        capability: "calendar.list_events",
      }),
      credentials: async () => ({ GITHUB_TOKEN: TOKEN }),
      invoke,
      sweepResources: false,
    });
    const calendarInvocation = {
      ...invocation,
      tool: "calendar.list_events",
      capability: "calendar.list_events:acme/widgets",
    } satisfies ToolInvocation;

    await expect(
      runner.run(calendarInvocation, new AbortController().signal),
    ).rejects.toMatchObject({
      name: "ToolProviderError",
      message: "Plugin rate limit reached",
      options: {
        code: "RATE_LIMITED",
        retryable: true,
        details: { provider: "calendar", provider_code: "rate_limited", retry_after: 12 },
      },
    });
  });

  it("honors a tool-specific output bound below the platform's 256 KiB cap", async () => {
    const value = "x".repeat(180 * 1024);
    let runLimit = 0;
    const invoke: PluginDockerInvoker = async (_binary, args, options) => {
      if (args[0] === "run") {
        runLimit = options.maxOutputBytes;
        return { code: 0, stdout: JSON.stringify({ result: { content: value } }), stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const runner = new DockerToolRunner({
      registry: registry({ hosts: [], maxOutputBytes: 200 * 1024 }),
      invoke,
      sweepResources: false,
    });

    await expect(runner.run(invocation, new AbortController().signal)).resolves.toEqual({
      result: { content: value },
    });
    expect(runLimit).toBe(200 * 1024);
  });

  it("keeps Docker CLI settings in the server environment, not plugin credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "crossover-plugin-cli-env-"));
    const docker = join(root, "docker");
    const record = join(root, "record.json");
    const serverDockerHost = "unix:///server-docker.sock";
    const previousDockerHost = process.env["DOCKER_HOST"];
    const previousRecord = process.env["CROSSOVER_TEST_RECORD"];
    try {
      await writeFile(
        docker,
        `#!/usr/bin/env node\nconst fs=require("node:fs");const path=require("node:path");const args=process.argv.slice(2);if(args[0]==="run"){const file=args[args.indexOf("--env-file")+1];fs.writeFileSync(process.env.CROSSOVER_TEST_RECORD,JSON.stringify({dockerHost:process.env.DOCKER_HOST??null,token:process.env.GITHUB_TOKEN??null,env:fs.readFileSync(file,"utf8"),mode:fs.statSync(file).mode&0o777,directoryMode:fs.statSync(path.dirname(file)).mode&0o777}));process.stdout.write('{"result":{}}')}\n`,
      );
      await chmod(docker, 0o700);
      process.env["DOCKER_HOST"] = serverDockerHost;
      process.env["CROSSOVER_TEST_RECORD"] = record;
      const runner = new DockerToolRunner({
        registry: registry({ hosts: [] }),
        dockerBinary: docker,
        sweepResources: false,
        credentials: async () => ({
          DOCKER_HOST: "tcp://plugin-controlled.invalid:2375",
          GITHUB_TOKEN: TOKEN,
        }),
      });

      await expect(runner.run(invocation, new AbortController().signal)).resolves.toEqual({
        result: {},
      });

      const observed = JSON.parse(await readFile(record, "utf8")) as {
        dockerHost: string | null;
        token: string | null;
        env: string;
        mode: number;
        directoryMode: number;
      };
      expect(observed.dockerHost).toBe(serverDockerHost);
      expect(observed.token).toBeNull();
      expect(observed.env).toContain("DOCKER_HOST=tcp://plugin-controlled.invalid:2375\n");
      expect(observed.env).toContain(`GITHUB_TOKEN=${TOKEN}\n`);
      expect(observed.mode).toBe(0o600);
      expect(observed.directoryMode).toBe(0o700);
    } finally {
      if (previousDockerHost === undefined) delete process.env["DOCKER_HOST"];
      else process.env["DOCKER_HOST"] = previousDockerHost;
      if (previousRecord === undefined) delete process.env["CROSSOVER_TEST_RECORD"];
      else process.env["CROSSOVER_TEST_RECORD"] = previousRecord;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("kills and removes a hung container when the per-run timeout expires", async () => {
    const calls: string[][] = [];
    let environmentFile = "";
    const invoke: PluginDockerInvoker = async (_binary, args, _options) => {
      calls.push([...args]);
      if (args[0] === "run") environmentFile = args[args.indexOf("--env-file") + 1]!;
      if (args[0] === "run") return { code: 124, stdout: "", stderr: "", timedOut: true };
      return { code: 0, stdout: "", stderr: "" };
    };
    const runner = new DockerToolRunner({
      registry: registry(),
      egressProxyContainer: "crossover-egress-proxy",
      egressProxySecret: SECRET,
      timeoutMs: 10,
      invoke,
    });

    await expect(runner.run(invocation, new AbortController().signal)).rejects.toThrow(/timed out/);
    expect(
      calls.some((args) => args[0] === "container" && args[1] === "rm" && args[2] === "--force"),
    ).toBe(true);
    await expect(readFile(environmentFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses credentials that could override runtime or proxy settings", async () => {
    const runner = new DockerToolRunner({
      registry: registry({ hosts: [] }),
      credentials: async () => ({ HTTPS_PROXY: "http://attacker" }),
      invoke: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
    });
    await expect(runner.run(invocation, new AbortController().signal)).rejects.toThrow(
      /credential provisioning failed/,
    );
  });

  it("refuses environment-file values that could create extra variables", async () => {
    const runner = new DockerToolRunner({
      registry: registry({ hosts: [] }),
      credentials: async () => ({ GITHUB_TOKEN: "first\nDOCKER_HOST=tcp://attacker" }),
      invoke: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
    });
    await expect(runner.run(invocation, new AbortController().signal)).rejects.toThrow(
      /credential provisioning failed/,
    );
  });

  it("bounds credential values by UTF-8 byte length", async () => {
    const runner = new DockerToolRunner({
      registry: registry({ hosts: [] }),
      credentials: async () => ({ GITHUB_TOKEN: "é".repeat(8193) }),
      invoke: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
    });
    await expect(runner.run(invocation, new AbortController().signal)).rejects.toThrow(
      /credential provisioning failed/,
    );
  });

  it("does not return provider credentials echoed by a plugin", async () => {
    const runner = new DockerToolRunner({
      registry: registry({ hosts: [] }),
      credentials: async () => ({ GITHUB_TOKEN: TOKEN }),
      invoke: async () => ({
        code: 0,
        stdout: JSON.stringify({ result: Buffer.from(TOKEN).toString("base64") }),
        stderr: "",
      }),
    });
    await expect(runner.run(invocation, new AbortController().signal)).rejects.toThrow(
      /contained a credential/,
    );
  });

  it("passes declared integrations to the broker and revokes its lease after failure", async () => {
    const revoke = vi.fn(async () => undefined);
    const credentials = vi.fn(async () => ({ environment: { GITHUB_TOKEN: TOKEN }, revoke }));
    const runner = new DockerToolRunner({
      registry: registry({
        hosts: [],
        integrations: [{ provider: "github", permissions: { contents: "read" } }],
      }),
      credentials,
      invoke: async (_binary, args) =>
        args[0] === "run"
          ? { code: 1, stdout: "", stderr: "" }
          : { code: 0, stdout: "", stderr: "" },
    });

    await expect(runner.run(invocation, new AbortController().signal)).rejects.toThrow(
      /Plugin execution failed/,
    );
    expect(credentials).toHaveBeenCalledWith(
      invocation,
      expect.objectContaining({
        integrations: [{ provider: "github", permissions: { contents: "read" } }],
      }),
    );
    expect(revoke).toHaveBeenCalledOnce();
  });

  it("rejects oversized output and still removes the invocation container", async () => {
    const calls: string[][] = [];
    const runner = new DockerToolRunner({
      registry: registry({ hosts: [] }),
      maxOutputBytes: 32,
      invoke: async (_binary, args) => {
        calls.push([...args]);
        return args[0] === "run"
          ? { code: 0, stdout: JSON.stringify({ result: "x".repeat(64) }), stderr: "" }
          : { code: 0, stdout: "", stderr: "" };
      },
    });

    await expect(runner.run(invocation, new AbortController().signal)).rejects.toThrow(
      /size limit/,
    );
    expect(
      calls.some((args) => args[0] === "container" && args[1] === "rm" && args[2] === "--force"),
    ).toBe(true);
  });

  it("sweeps labeled resources on startup and every hour", async () => {
    vi.useFakeTimers();
    const calls: string[][] = [];
    const invoke: PluginDockerInvoker = async (_binary, args) => {
      calls.push([...args]);
      return { code: 0, stdout: "", stderr: "" };
    };
    const sweeper = new PluginResourceSweeper("docker", invoke);
    try {
      sweeper.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toHaveLength(2);
      expect(calls.map((args) => args.slice(0, 2))).toEqual([
        ["container", "ls"],
        ["network", "ls"],
      ]);

      await vi.advanceTimersByTimeAsync(PLUGIN_SWEEP_INTERVAL_MS);
      expect(calls).toHaveLength(4);
    } finally {
      await sweeper.stop();
      vi.useRealTimers();
    }
  });
});
