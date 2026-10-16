import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ToolRegistry, type ToolExecutionSpec, type ToolInvocation } from "@crossover/kernel";
import { verifyPluginProxyCredential } from "@crossover/security";
import { z } from "zod";
import { browserNavigateParams } from "./browser-plugin.js";
import {
  DockerToolRunner,
  resolveAwsRegionalHosts,
  type PluginDockerInvoker,
} from "./plugin-runner.js";
import {
  PLUGIN_RESOURCE_MAX_AGE_MS,
  PLUGIN_SWEEP_INTERVAL_MS,
  PluginResourceSweeper,
} from "./plugin-runner-docker.js";

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
    awsRegionalEgress?: ToolExecutionSpec["awsRegionalEgress"];
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
      ...(options.awsRegionalEgress ? { awsRegionalEgress: options.awsRegionalEgress } : {}),
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
  it("rejects invalid browser URLs on the host before calling Docker", async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "browser.navigate",
      description: "Navigate to an HTTPS page",
      capability: "browser.navigate",
      tier: 2,
      input: browserNavigateParams,
      idempotent: true,
      execution: {
        image: `crossover-browser-plugin@sha256:${"a".repeat(64)}`,
        command: ["node", "/app/plugins/browser/worker.mjs"],
        egressHosts: [],
        roomEgressAllowlist: true,
      },
    });
    const invoke = vi.fn<PluginDockerInvoker>(async () => ({ code: 0, stdout: "", stderr: "" }));
    const roomEgressHosts = vi.fn(async () => ["browser-fixture.test"]);
    const runner = new DockerToolRunner({
      registry: tools,
      invoke,
      roomEgressHosts,
      sweepResources: false,
    });
    const invalidInvocation: ToolInvocation = {
      ...invocation,
      tool: "browser.navigate",
      capability: "browser.navigate",
      args: { url: "http://browser-fixture.test/" },
    };

    await expect(runner.run(invalidInvocation, new AbortController().signal)).rejects.toMatchObject(
      {
        name: "ToolProviderError",
        options: { retryable: false, code: "VALIDATION" },
      },
    );
    expect(roomEgressHosts).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("derives only the invocation region's AWS service endpoints", () => {
    expect(
      resolveAwsRegionalHosts(
        { ...invocation, args: { region: "us-east-1" } },
        { regionFrom: "args.region", services: ["lambda"] },
      ),
    ).toEqual(["lambda.us-east-1.amazonaws.com"]);
    expect(
      resolveAwsRegionalHosts(
        { ...invocation, scope: "arn:aws-cn:logs:cn-north-1:123456789012:log-group:app" },
        { regionFrom: "scope.logsArn", services: ["logs"] },
      ),
    ).toEqual(["logs.cn-north-1.amazonaws.com.cn"]);
    expect(() =>
      resolveAwsRegionalHosts(
        { ...invocation, args: { region: "evil.example.com" } },
        { regionFrom: "args.region", services: ["lambda"] },
      ),
    ).toThrow(/scope is invalid/);
  });

  it("places only the ARN's CloudWatch regional endpoint in the proxy claim", async () => {
    let proxyToken = "";
    const invoke: PluginDockerInvoker = async (_binary, args) => {
      if (args[0] === "run") {
        const envFile = args[args.indexOf("--env-file") + 1]!;
        const environment = Object.fromEntries(
          (await readFile(envFile, "utf8"))
            .trimEnd()
            .split("\n")
            .map((entry) => {
              const separator = entry.indexOf("=");
              return [entry.slice(0, separator), entry.slice(separator + 1)];
            }),
        );
        proxyToken = decodeURIComponent(new URL(environment.HTTPS_PROXY!).password);
        return { code: 0, stdout: '{"result":{}}', stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const awsInvocation: ToolInvocation = {
      ...invocation,
      tool: "aws.read_logs",
      capability: "aws.read_logs:arn:aws:logs:us-east-1:123456789012:log-group:app",
      scope: "arn:aws:logs:us-east-1:123456789012:log-group:app",
      args: { log_group_arn: "arn:aws:logs:us-east-1:123456789012:log-group:app" },
    };
    const tools = new ToolRegistry();
    tools.register({
      name: "aws.read_logs",
      description: "Read a CloudWatch log group",
      capability: "aws.read_logs",
      tier: 0,
      input: z.object({ log_group_arn: z.string() }),
      scope: (args) => args.log_group_arn,
      idempotent: true,
      execution: {
        image: `busybox:1.36.1-musl@sha256:${"a".repeat(64)}`,
        command: ["node", "dist/worker.js"],
        egressHosts: [],
        awsRegionalEgress: { regionFrom: "scope.logsArn", services: ["logs"] },
        integrations: [{ provider: "aws" }],
      },
    });
    const runner = new DockerToolRunner({
      registry: tools,
      egressProxyContainer: "crossover-egress-proxy",
      egressProxySecret: SECRET,
      invoke,
    });
    await runner.run(awsInvocation, new AbortController().signal);
    expect(verifyPluginProxyCredential(proxyToken, SECRET)?.hosts).toEqual([
      "logs.us-east-1.amazonaws.com",
    ]);
  });

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

  it("preserves the failing Docker network removal details as the cleanup cause", async () => {
    const invoke: PluginDockerInvoker = async (_binary, args) => {
      if (args[0] === "run") return { code: 0, stdout: '{"result":{}}', stderr: "" };
      if (args[0] === "network" && args[1] === "rm")
        return { code: 1, timedOut: false, stdout: "", stderr: "boom" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const runner = new DockerToolRunner({
      registry: registry(),
      egressProxyContainer: "crossover-egress-proxy",
      egressProxySecret: SECRET,
      invoke,
      sweepResources: false,
    });

    await expect(runner.run(invocation, new AbortController().signal)).rejects.toMatchObject({
      message: "Plugin runner cleanup failed",
      cause: {
        message: expect.stringContaining(
          'docker network rm failed (exit code: 1, timed out: false, stderr: "boom")',
        ),
      },
    });
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

  // Measured (T1529): idle 610 ms, 3x load 2973 ms; budget 7x.
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
  }, 25_000);

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
      expect(calls.map((args) => args[args.indexOf("--filter") + 1])).toEqual([
        "label=crossover.plugin-run=true",
        "label=crossover.plugin-run=true",
      ]);

      await vi.advanceTimersByTimeAsync(PLUGIN_SWEEP_INTERVAL_MS);
      expect(calls).toHaveLength(4);
    } finally {
      await sweeper.stop();
      vi.useRealTimers();
    }
  });

  it("allows tests to scope cleanup sweeps to a plugin-run label value", async () => {
    const calls: string[][] = [];
    const runner = new DockerToolRunner({
      registry: registry({ hosts: [] }),
      invoke: async (_binary, args) => {
        calls.push([...args]);
        return args[0] === "run"
          ? { code: 0, stdout: JSON.stringify({ result: { ok: true } }), stderr: "" }
          : { code: 0, stdout: "", stderr: "" };
      },
      pluginRunLabelValue: "test-run-42",
    });

    await runner.run(invocation, new AbortController().signal);
    await runner.sweepStaleResources();
    await runner.close();

    expect(calls.find((args) => args[0] === "run")).toContain("crossover.plugin-run=test-run-42");
    expect(
      calls
        .filter((args) => args.includes("--filter"))
        .map((args) => args[args.indexOf("--filter") + 1]),
    ).toEqual(["label=crossover.plugin-run=test-run-42", "label=crossover.plugin-run=test-run-42"]);
  });

  it("includes exit code, timeout status, and at most 500 stderr bytes for container cleanup", async () => {
    const resourceId = "abcdef123456";
    const stderr = `${"x".repeat(500)}truncated`;
    const invoke: PluginDockerInvoker = async (_binary, args) => {
      if (args[0] === "container" && args[1] === "ls")
        return { code: 0, stdout: `${resourceId}\n`, stderr: "" };
      if (args[0] === "container" && args[1] === "inspect")
        return { code: 0, stdout: `0\t1970-01-01T00:00:00Z\t${resourceId}\n`, stderr: "" };
      if (args[0] === "container" && args[1] === "rm")
        return { code: 17, stdout: "", stderr, timedOut: true };
      return { code: 0, stdout: "", stderr: "" };
    };
    const sweeper = new PluginResourceSweeper("docker", invoke);

    await expect(sweeper.sweepNow()).rejects.toThrow(
      `Docker container cleanup failed (exit code: 17, timed out: true, stderr: "${"x".repeat(500)}")`,
    );
  });

  it("includes Docker failure details when the network cleanup retry fails", async () => {
    const resourceId = "fedcba654321";
    const stderr = `${"n".repeat(500)}truncated`;
    let removalAttempts = 0;
    const invoke: PluginDockerInvoker = async (_binary, args) => {
      if (args[0] === "network" && args[1] === "ls")
        return { code: 0, stdout: `${resourceId}\n`, stderr: "" };
      if (args[0] === "network" && args[1] === "inspect")
        return { code: 0, stdout: `0\t1970-01-01T00:00:00Z\t${resourceId}\n`, stderr: "" };
      if (args[0] === "network" && args[1] === "rm") {
        removalAttempts++;
        return removalAttempts === 1
          ? { code: 1, stdout: "", stderr: "network has active endpoints" }
          : { code: 137, stdout: "", stderr, timedOut: true };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const sweeper = new PluginResourceSweeper("docker", invoke);

    await expect(sweeper.sweepNow()).rejects.toThrow(
      `Docker network cleanup failed (exit code: 137, timed out: true, stderr: "${"n".repeat(500)}")`,
    );
    expect(removalAttempts).toBe(2);
  });

  it("tolerates concurrent container removal and retries an active network after the container pass", async () => {
    const containerId = "a".repeat(12);
    const networkId = "b".repeat(12);
    const calls: string[][] = [];
    let networkRemovalAttempts = 0;
    const invoke: PluginDockerInvoker = async (_binary, args) => {
      calls.push([...args]);
      if (args[0] === "container" && args[1] === "ls") {
        return { code: 0, stdout: `${containerId}\n`, stderr: "" };
      }
      if (args[0] === "network" && args[1] === "ls") {
        return { code: 0, stdout: `${networkId}\n`, stderr: "" };
      }
      if (args[1] === "inspect") {
        const id = args.at(-1);
        return { code: 0, stdout: `0\t\t${id}\n`, stderr: "" };
      }
      if (args[0] === "container" && args[1] === "rm") {
        return {
          code: 1,
          stdout: "",
          stderr: `Error response from daemon: removal of container ${containerId} is already in progress`,
        };
      }
      if (args[0] === "network" && args[1] === "rm") {
        networkRemovalAttempts++;
        return networkRemovalAttempts === 1
          ? {
              code: 1,
              stdout: "",
              stderr: `Error response from daemon: network ${networkId} has active endpoints`,
            }
          : { code: 0, stdout: `${networkId}\n`, stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const sweeper = new PluginResourceSweeper("docker", invoke);

    await sweeper.sweepNow(PLUGIN_RESOURCE_MAX_AGE_MS + 1);

    const removalCalls = calls.filter(
      (args) =>
        (args[0] === "container" && args[1] === "rm") ||
        (args[0] === "network" && args[1] === "rm"),
    );
    expect(removalCalls).toEqual([
      ["container", "rm", "--force", containerId],
      ["network", "rm", networkId],
      ["network", "rm", networkId],
    ]);
    expect(networkRemovalAttempts).toBe(2);
  });

  it("continues inspecting stale IDs when another sweep removes one during batch inspection", async () => {
    const removedId = "c".repeat(12);
    const staleId = "d".repeat(12);
    const calls: string[][] = [];
    const invoke: PluginDockerInvoker = async (_binary, args) => {
      calls.push([...args]);
      if (args[0] === "container" && args[1] === "ls") {
        return { code: 0, stdout: `${removedId}\n${staleId}\n`, stderr: "" };
      }
      if (args[0] === "network" && args[1] === "ls") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "container" && args[1] === "inspect") {
        if (args.length > 5) {
          return {
            code: 1,
            stdout: "",
            stderr: `Error response from daemon: No such container: ${removedId}`,
          };
        }
        const id = args.at(-1);
        if (id === removedId) {
          return {
            code: 1,
            stdout: "",
            stderr: `Error response from daemon: No such container: ${removedId}`,
          };
        }
        return { code: 0, stdout: `0\t\t${id}\n`, stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const sweeper = new PluginResourceSweeper("docker", invoke);

    await sweeper.sweepNow(PLUGIN_RESOURCE_MAX_AGE_MS + 1);

    expect(calls).toContainEqual(["container", "rm", "--force", staleId]);
    expect(calls).not.toContainEqual(["container", "rm", "--force", removedId]);
  });
});
