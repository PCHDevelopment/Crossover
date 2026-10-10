import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  ToolProviderError,
  type ToolInvocation,
  type ToolOutput,
  type ToolExecutionSpec,
  type ToolRegistry,
  type ToolRunner,
} from "@crossover/kernel";
import { createPluginProxyCredential } from "@crossover/security";
import {
  invokeDocker,
  isMissingDockerResource,
  PLUGIN_RUN_CREATED_AT_LABEL,
  PLUGIN_RUN_LABEL,
  PluginResourceSweeper,
  type PluginDockerInvoker,
} from "./plugin-runner-docker.js";

export type {
  PluginDockerInvoker,
  PluginDockerOptions,
  PluginDockerResult,
} from "./plugin-runner-docker.js";

const DEFAULT_TIMEOUT_MS = 55_000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;
const MAX_CREDENTIALS = 16;
const MAX_CREDENTIAL_BYTES = 16 * 1024;
const SAFE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const ENV_RESERVED = new Set([
  "HOME",
  "PATH",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "NODE_OPTIONS",
  "CROSSOVER_TOOL_REQUEST",
]);

export interface PluginCredentialLease {
  environment: Readonly<Record<string, string>>;
  revoke?: () => Promise<void>;
}

export type PluginCredentialProvider = (
  invocation: ToolInvocation,
  execution: ToolExecutionSpec,
) => Promise<Readonly<Record<string, string>> | PluginCredentialLease>;

export interface DockerToolRunnerOptions {
  registry: ToolRegistry;
  dockerBinary?: string;
  runtime?: string;
  egressProxyContainer?: string;
  egressProxyPort?: number;
  egressProxySecret?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  credentials?: PluginCredentialProvider;
  invoke?: PluginDockerInvoker;
  sweepResources?: boolean;
}

/** Run each plugin call in a throwaway, resource-limited container. */
export class DockerToolRunner implements ToolRunner {
  private readonly dockerBinary: string;
  private readonly runtime: string | undefined;
  private readonly egressProxyContainer: string | undefined;
  private readonly egressProxyPort: number;
  private readonly egressProxySecret: string | undefined;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly credentials: PluginCredentialProvider;
  private readonly invoke: PluginDockerInvoker;
  private readonly resourceSweeper: PluginResourceSweeper;

  constructor(private readonly options: DockerToolRunnerOptions) {
    this.dockerBinary = options.dockerBinary ?? "docker";
    this.runtime = options.runtime?.trim() || undefined;
    this.egressProxyContainer = options.egressProxyContainer?.trim() || undefined;
    this.egressProxyPort = options.egressProxyPort ?? 3128;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
    this.credentials = options.credentials ?? (async () => ({}));
    this.invoke = options.invoke ?? invokeDocker;

    if (options.runtime !== undefined && !this.runtime)
      throw new Error("SANDBOX_RUNTIME must be a nonempty Docker runtime name");
    if (this.egressProxyContainer && !/^[a-z0-9][a-z0-9_.-]*$/.test(this.egressProxyContainer))
      throw new Error("SANDBOX_EGRESS_PROXY_CONTAINER must be a Docker container name");
    if (
      !Number.isSafeInteger(this.egressProxyPort) ||
      this.egressProxyPort < 1 ||
      this.egressProxyPort > 65_535
    ) {
      throw new Error("SANDBOX_EGRESS_PROXY_PORT must be a port from 1 to 65535");
    }
    if (this.egressProxyContainer && !options.egressProxySecret)
      throw new Error(
        "SANDBOX_EGRESS_PROXY_SECRET is required with SANDBOX_EGRESS_PROXY_CONTAINER",
      );
    if (!this.egressProxyContainer && options.egressProxySecret)
      throw new Error("SANDBOX_EGRESS_PROXY_SECRET requires SANDBOX_EGRESS_PROXY_CONTAINER");
    if (!this.egressProxyContainer && options.egressProxyPort !== undefined)
      throw new Error("SANDBOX_EGRESS_PROXY_PORT requires SANDBOX_EGRESS_PROXY_CONTAINER");
    if (options.egressProxySecret && Buffer.byteLength(options.egressProxySecret) < 32)
      throw new Error("SANDBOX_EGRESS_PROXY_SECRET must be at least 32 bytes");
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000)
      throw new Error("Plugin runner timeout must be from 1 to 60000ms");
    if (
      !Number.isSafeInteger(this.maxOutputBytes) ||
      this.maxOutputBytes < 1 ||
      this.maxOutputBytes > MAX_OUTPUT_BYTES
    ) {
      throw new Error(`Plugin runner output limit must be from 1 to ${MAX_OUTPUT_BYTES} bytes`);
    }

    const shouldSweep = options.sweepResources ?? options.invoke === undefined;
    this.resourceSweeper = new PluginResourceSweeper(this.dockerBinary, this.invoke);
    if (shouldSweep) this.resourceSweeper.start();
  }

  async close(): Promise<void> {
    await this.resourceSweeper?.stop();
  }

  async sweepStaleResources(now = Date.now()): Promise<void> {
    await this.resourceSweeper.sweepNow(now);
  }

  async run(invocation: ToolInvocation, signal: AbortSignal): Promise<ToolOutput> {
    const definition = this.options.registry.get(invocation.tool);
    const execution = definition?.execution;
    if (!definition || !execution) throw new Error("Plugin runtime is not configured");
    if (signal.aborted) throw new Error("Plugin invocation was aborted");
    const outputLimit = Math.min(
      execution.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      this.maxOutputBytes,
    );

    const hosts = normalizeHosts(execution.egressHosts);
    const runId = randomBytes(12).toString("hex");
    const containerName = `crossover-plugin-${runId}`;
    const networkName = hosts.length > 0 ? `crossover-plugin-net-${runId}` : undefined;
    let networkCreated = false;
    let proxyConnected = false;
    let environmentDirectory: string | undefined;
    let thrown: unknown;
    let output: ToolOutput | undefined;
    let credentials: Readonly<Record<string, string>>;
    let lease: PluginCredentialLease | undefined;

    try {
      try {
        const supplied = await this.credentials(invocation, execution);
        if (isCredentialLease(supplied)) {
          lease = supplied;
          credentials = validateCredentialEnvironment(supplied.environment);
        } else {
          credentials = validateCredentialEnvironment(supplied);
        }
      } catch {
        throw new Error("Plugin credential provisioning failed");
      }
      if (networkName) {
        if (!this.egressProxyContainer || !this.options.egressProxySecret)
          throw new Error("Plugin egress proxy is not configured");
        await this.mustSucceed([
          "network",
          "create",
          "--internal",
          "--label",
          `${PLUGIN_RUN_LABEL}=true`,
          "--label",
          `${PLUGIN_RUN_CREATED_AT_LABEL}=${Date.now()}`,
          networkName,
        ]);
        networkCreated = true;
        await this.mustSucceed(["network", "connect", networkName, this.egressProxyContainer]);
        proxyConnected = true;
      }

      const environment: Record<string, string> = {
        HOME: "/tmp",
        PATH: SAFE_PATH,
        ...credentials,
      };
      const sensitiveValues = [...Object.values(credentials)];
      if (networkName) {
        const proxyCredential = createPluginProxyCredential(
          {
            invocationId: invocation.invocation_id,
            roomId: invocation.room_id,
            participantId: invocation.participant_id,
            hosts,
            expiresAt: Date.now() + this.timeoutMs + 30_000,
          },
          this.options.egressProxySecret!,
        );
        const proxyUrl = `http://${encodeURIComponent("plugin")}:${encodeURIComponent(proxyCredential)}@${this.egressProxyContainer}:${this.egressProxyPort}`;
        sensitiveValues.push(proxyCredential, `plugin:${proxyCredential}`, proxyUrl);
        Object.assign(environment, {
          HTTP_PROXY: proxyUrl,
          HTTPS_PROXY: proxyUrl,
          ALL_PROXY: proxyUrl,
          NO_PROXY: "localhost,127.0.0.1,::1",
          http_proxy: proxyUrl,
          https_proxy: proxyUrl,
          all_proxy: proxyUrl,
          no_proxy: "localhost,127.0.0.1,::1",
        });
      }

      const args = [
        "run",
        "--init",
        "--interactive",
        "--pull=never",
        "--name",
        containerName,
        "--label",
        `${PLUGIN_RUN_LABEL}=true`,
        "--label",
        `${PLUGIN_RUN_CREATED_AT_LABEL}=${Date.now()}`,
        `--network=${networkName ?? "none"}`,
        "--read-only",
        "--user=1000:1000",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--pids-limit=64",
        "--cpus=1",
        "--memory=256m",
        "--memory-swap=256m",
        "--tmpfs",
        "/tmp:rw,nosuid,size=64m,uid=1000,gid=1000",
      ];
      if (this.runtime) args.push("--runtime", this.runtime);
      environmentDirectory = await mkdtemp(join(tmpdir(), "crossover-plugin-env-"));
      const envFile = join(environmentDirectory, "environment");
      await writeFile(envFile, serializeEnvironment(environment), { flag: "wx", mode: 0o600 });
      args.push("--env-file", envFile);
      args.push("--workdir", "/tmp", execution.image, ...execution.command);

      const result = await this.invoke(this.dockerBinary, args, {
        timeoutMs: this.timeoutMs,
        maxOutputBytes: outputLimit,
        maxStderrBytes: MAX_STDERR_BYTES,
        input: `${JSON.stringify({ invocation })}\n`,
        signal,
      });
      if (result.timedOut) {
        if (definition.idempotent)
          throw new ToolProviderError("Plugin invocation timed out", { retryable: true });
        throw new Error("Plugin invocation timed out");
      }
      if (result.aborted || signal.aborted) throw new Error("Plugin invocation was aborted");
      if (result.outputOverflow) throw new Error("Plugin output exceeded the size limit");
      if (result.code !== 0) {
        rejectCredentialOutput(result.stdout, sensitiveValues);
        throw parsePluginError(
          result.stdout,
          definition.idempotent,
          definition.name.split(".")[0] || "plugin",
        );
      }
      rejectCredentialOutput(result.stdout, sensitiveValues);
      output = parsePluginOutput(result.stdout, outputLimit);
    } catch (error) {
      thrown = error;
    } finally {
      let cleanupError: Error | undefined;
      try {
        await this.cleanup({
          containerName,
          ...(networkName ? { networkName } : {}),
          networkCreated,
          proxyConnected,
        });
      } catch {
        cleanupError = new Error("Plugin runner cleanup failed");
      }
      if (environmentDirectory) {
        try {
          await rm(environmentDirectory, { recursive: true, force: true });
        } catch {
          cleanupError ??= new Error("Plugin runner environment cleanup failed");
        }
      }
      if (lease?.revoke) {
        try {
          await lease.revoke();
        } catch {
          cleanupError ??= new Error("Plugin credential revocation failed");
        }
      }
      if (cleanupError && !thrown) thrown = cleanupError;
    }
    if (thrown) throw thrown;
    return output!;
  }

  private async mustSucceed(args: readonly string[]): Promise<void> {
    const result = await this.invoke(this.dockerBinary, args, {
      timeoutMs: 20_000,
      maxOutputBytes: 8 * 1024,
      maxStderrBytes: MAX_STDERR_BYTES,
    });
    if (result.code !== 0) throw new Error("Plugin runner setup failed");
  }

  private async cleanup(input: {
    containerName: string;
    networkName?: string;
    networkCreated: boolean;
    proxyConnected: boolean;
  }): Promise<void> {
    let failed = false;
    const remove = await this.invoke(
      this.dockerBinary,
      ["container", "rm", "--force", input.containerName],
      { timeoutMs: 10_000, maxOutputBytes: 8 * 1024, maxStderrBytes: MAX_STDERR_BYTES },
    );
    if (remove.code !== 0 && !isMissingDockerResource(remove.stderr)) failed = true;

    if (input.networkName && input.networkCreated) {
      if (input.proxyConnected) {
        const disconnected = await this.invoke(
          this.dockerBinary,
          ["network", "disconnect", "--force", input.networkName, this.egressProxyContainer!],
          { timeoutMs: 10_000, maxOutputBytes: 8 * 1024, maxStderrBytes: MAX_STDERR_BYTES },
        );
        if (disconnected.code !== 0 && !isMissingDockerResource(disconnected.stderr)) failed = true;
      }
      const removed = await this.invoke(this.dockerBinary, ["network", "rm", input.networkName], {
        timeoutMs: 10_000,
        maxOutputBytes: 8 * 1024,
        maxStderrBytes: MAX_STDERR_BYTES,
      });
      if (removed.code !== 0 && !isMissingDockerResource(removed.stderr)) failed = true;
    }
    if (failed) throw new Error("Plugin runner cleanup failed");
  }
}

function normalizeHosts(input: readonly string[]): string[] {
  if (input.length > 100) throw new Error("Plugin host declaration exceeds the limit");
  return [...new Set(input.map(normalizeHostPattern))].sort();
}

function normalizeHostPattern(input: string): string {
  const wildcard = input.startsWith("*.");
  const source = (wildcard ? input.slice(2) : input).replace(/\.$/, "");
  if (!source || source.length > 253 || /[/:?#@\s\\]/.test(source) || isIP(source))
    throw new Error("Plugin host declaration is invalid");
  let host: string;
  try {
    const url = new URL(`https://${source}`);
    if (url.port || url.username || url.password || url.pathname !== "/")
      throw new Error("invalid host");
    host = url.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    throw new Error("Plugin host declaration is invalid");
  }
  const labels = host.split(".");
  if (
    labels.length < 2 ||
    labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    throw new Error("Plugin host declaration is invalid");
  }
  return `${wildcard ? "*." : ""}${host}`;
}

function isCredentialLease(
  value: Readonly<Record<string, string>> | PluginCredentialLease,
): value is PluginCredentialLease {
  return typeof value === "object" && value !== null && Object.hasOwn(value, "environment");
}

function validateCredentialEnvironment(
  input: Readonly<Record<string, string>>,
): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("invalid credential environment");
  const entries = Object.entries(input);
  if (entries.length > MAX_CREDENTIALS) throw new Error("too many credentials");
  const output: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (
      !/^[A-Z][A-Z0-9_]{0,127}$/.test(name) ||
      ENV_RESERVED.has(name) ||
      typeof value !== "string" ||
      Buffer.byteLength(value) > MAX_CREDENTIAL_BYTES ||
      /[\0\r\n]/.test(value)
    ) {
      throw new Error("invalid credential environment");
    }
    output[name] = value;
  }
  return output;
}

function rejectCredentialOutput(output: string, values: readonly string[]): void {
  const candidates = values.flatMap((value) =>
    value
      ? [
          value,
          encodeURIComponent(value),
          Buffer.from(value).toString("base64"),
          Buffer.from(value).toString("base64url"),
        ]
      : [],
  );
  if (candidates.some((value) => output.includes(value)))
    throw new Error("Plugin output contained a credential");
}

function parsePluginOutput(output: string, maxBytes: number): ToolOutput {
  if (Buffer.byteLength(output) > maxBytes)
    throw new Error("Plugin output exceeded the size limit");
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.trim()) as unknown;
  } catch {
    throw new Error("Plugin output was invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !("result" in parsed))
    throw new Error("Plugin output was invalid");
  return { result: (parsed as { result: unknown }).result ?? null };
}

function parsePluginError(
  output: string,
  idempotent: boolean,
  provider: string,
): ToolProviderError {
  const fallback = () =>
    new ToolProviderError("Plugin execution failed", { retryable: idempotent });
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.trim()) as unknown;
  } catch {
    return fallback();
  }
  if (!parsed || typeof parsed !== "object" || !("error" in parsed)) return fallback();
  const error = (parsed as { error?: unknown }).error;
  if (!error || typeof error !== "object") return fallback();
  const record = error as { code?: unknown; retryable?: unknown; retry_after?: unknown };
  const codes = {
    not_found: { code: "NOT_FOUND" as const, message: "Plugin resource not found" },
    forbidden: { code: "FORBIDDEN" as const, message: "Plugin access denied" },
    rate_limited: { code: "RATE_LIMITED" as const, message: "Plugin rate limit reached" },
    validation: { code: "VALIDATION" as const, message: "Plugin rejected the request" },
    unavailable: { code: "PROVIDER_UNAVAILABLE" as const, message: "Plugin service unavailable" },
  } as const;
  if (typeof record.code !== "string" || !Object.hasOwn(codes, record.code)) return fallback();
  const mapped = codes[record.code as keyof typeof codes];
  const retryable = record.code === "rate_limited" || (record.retryable === true && idempotent);
  const retryAfter =
    typeof record.retry_after === "number" &&
    Number.isSafeInteger(record.retry_after) &&
    record.retry_after >= 0 &&
    record.retry_after <= 86_400
      ? record.retry_after
      : undefined;
  return new ToolProviderError(mapped.message, {
    code: mapped.code,
    retryable,
    details: {
      provider,
      provider_code: record.code,
      ...(record.code === "rate_limited" && retryAfter !== undefined
        ? { retry_after: retryAfter }
        : {}),
    },
  });
}

function serializeEnvironment(environment: Readonly<Record<string, string>>): string {
  return `${Object.entries(environment)
    .map(([name, value]) => `${name}=${value}`)
    .join("\n")}\n`;
}
