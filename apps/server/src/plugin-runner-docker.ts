import { spawn } from "node:child_process";

export const PLUGIN_RUN_LABEL = "crossover.plugin-run";
export const PLUGIN_RUN_CREATED_AT_LABEL = "crossover.plugin-run-created-at";
export const PLUGIN_SWEEP_INTERVAL_MS = 60 * 60_000;
// A run can spend up to 20s creating its network, another 20s connecting the proxy, and 60s
// executing. The 120s age limit leaves cleanup time while remaining bounded after a crash.
export const PLUGIN_RESOURCE_MAX_AGE_MS = 120_000;

export interface PluginDockerResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  aborted?: boolean;
  outputOverflow?: boolean;
}

export interface PluginDockerOptions {
  timeoutMs: number;
  maxOutputBytes: number;
  maxStderrBytes: number;
  input?: string;
  signal?: AbortSignal;
}

export type PluginDockerInvoker = (
  binary: string,
  args: readonly string[],
  options: PluginDockerOptions,
) => Promise<PluginDockerResult>;

const SWEEP_OUTPUT_LIMIT = 256 * 1024;
const SWEEP_TIMEOUT_MS = 10_000;
const NETWORK_RETRY_DELAY_MS = 250;

/** Removes only runner-labelled Docker resources that have exceeded the bounded run lifetime. */
export class PluginResourceSweeper {
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;

  constructor(
    private readonly dockerBinary: string,
    private readonly invoke: PluginDockerInvoker,
  ) {}

  start(): void {
    if (this.timer) return;
    this.runAndWarn();
    this.timer = setInterval(() => this.runAndWarn(), PLUGIN_SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  async sweepNow(now = Date.now()): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.sweep(now).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight?.catch(() => undefined);
  }

  private runAndWarn(): void {
    void this.sweepNow().catch((error: unknown) => {
      const detail = error instanceof Error ? `: ${error.message}` : "";
      process.emitWarning(
        `Could not sweep stale plugin Docker resources${detail}`,
        "PluginRunnerWarning",
      );
    });
  }

  private async sweep(now: number): Promise<void> {
    const cutoff = now - PLUGIN_RESOURCE_MAX_AGE_MS;
    const [containers, networks] = await Promise.all([
      this.staleIds("container", cutoff),
      this.staleIds("network", cutoff),
    ]);
    for (const id of containers) await this.remove("container", id, true);
    for (const id of networks) await this.remove("network", id, false);
  }

  private async staleIds(kind: "container" | "network", cutoff: number): Promise<string[]> {
    const resourceArgs = kind === "container" ? ["container", "ls", "--all"] : ["network", "ls"];
    const list = await this.invoke(
      this.dockerBinary,
      [...resourceArgs, "--quiet", "--filter", `label=${PLUGIN_RUN_LABEL}=true`],
      sweepOptions(),
    );
    if (list.code !== 0) throw new Error("Docker resource listing failed");
    const ids = list.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^[a-f0-9]{12,64}$/i.test(line));
    if (ids.length === 0) return [];

    const template =
      kind === "container"
        ? '{{ index .Config.Labels "crossover.plugin-run-created-at" }}\t{{.Created}}\t{{.Id}}'
        : '{{ index .Labels "crossover.plugin-run-created-at" }}\t{{.Created}}\t{{.Id}}';
    const inspected = await this.invoke(
      this.dockerBinary,
      [kind, "inspect", "--format", template, ...ids],
      sweepOptions(),
    );
    if (inspected.code !== 0) {
      if (!isMissingDockerResource(inspected.stderr))
        throw new Error("Docker resource inspection failed");
      // Another sweeper may remove one listed ID during the batch inspect. Inspect individually
      // so that missing IDs don't prevent this pass from cleaning the remaining stale resources.
      const individual = await Promise.all(
        ids.map(async (id) => {
          const result = await this.invoke(
            this.dockerBinary,
            [kind, "inspect", "--format", template, id],
            sweepOptions(),
          );
          if (result.code !== 0) {
            if (isMissingDockerResource(result.stderr)) return [];
            throw new Error("Docker resource inspection failed");
          }
          return staleResourceIds(result.stdout, cutoff);
        }),
      );
      return individual.flat();
    }

    return staleResourceIds(inspected.stdout, cutoff);
  }

  private async remove(kind: "container" | "network", id: string, force: boolean): Promise<void> {
    const args =
      kind === "container"
        ? ["container", "rm", ...(force ? ["--force"] : []), id]
        : ["network", "rm", id];
    const result = await this.invoke(this.dockerBinary, args, sweepOptions());
    if (isSuccessfulCleanup(result)) return;
    if (kind === "network" && hasActiveDockerNetworkEndpoints(result.stderr)) {
      // A concurrent container removal may still be completing after reporting "already in
      // progress". Let Docker finish detaching endpoints before the single network retry.
      await new Promise((resolve) => setTimeout(resolve, NETWORK_RETRY_DELAY_MS));
      const retry = await this.invoke(this.dockerBinary, args, sweepOptions());
      if (isSuccessfulCleanup(retry)) return;
    }
    throw new Error(`Docker ${kind} cleanup failed`);
  }
}

function isSuccessfulCleanup(result: PluginDockerResult): boolean {
  return (
    result.code === 0 ||
    isMissingDockerResource(result.stderr) ||
    isDockerRemovalInProgress(result.stderr)
  );
}

export function isMissingDockerResource(stderr: string): boolean {
  const message = stderr.toLowerCase();
  return (
    message.includes("no such container") ||
    message.includes("no such network") ||
    message.includes("not found")
  );
}

function isDockerRemovalInProgress(stderr: string): boolean {
  return stderr.toLowerCase().includes("already in progress");
}

function hasActiveDockerNetworkEndpoints(stderr: string): boolean {
  return stderr.toLowerCase().includes("has active endpoints");
}

function staleResourceIds(output: string, cutoff: number): string[] {
  const stale: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const [createdLabel, createdDate, id] = line.split("\t");
    if (!id || !/^[a-f0-9]{12,64}$/i.test(id)) continue;
    const labeledTime = createdLabel ? Number(createdLabel) : Number.NaN;
    const createdAt = Number.isSafeInteger(labeledTime)
      ? labeledTime
      : Date.parse(createdDate ?? "");
    if (Number.isFinite(createdAt) && createdAt <= cutoff) stale.push(id);
  }
  return stale;
}

function sweepOptions(): PluginDockerOptions {
  return {
    timeoutMs: SWEEP_TIMEOUT_MS,
    maxOutputBytes: SWEEP_OUTPUT_LIMIT,
    maxStderrBytes: 8 * 1024,
  };
}

export function invokeDocker(
  binary: string,
  args: readonly string[],
  options: PluginDockerOptions,
): Promise<PluginDockerResult> {
  return new Promise((resolve) => {
    // Plugin values are supplied to `docker run` through a private env file. The Docker CLI
    // inherits only the server's own environment, so a credential cannot reconfigure the daemon.
    const child = spawn(binary, [...args], {
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputOverflow = false;
    let timedOut = false;
    let aborted = false;
    let exitCode: number | null = null;
    let spawnError = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const terminate = () => {
      if (child.kill("SIGTERM")) {
        forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
        forceKillTimer.unref();
      }
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);
    const onAbort = () => {
      aborted = true;
      terminate();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();

    child.stdout?.on("data", (chunk: Buffer) => {
      const remaining = options.maxOutputBytes - stdoutBytes;
      if (chunk.length > remaining) {
        outputOverflow = true;
        if (remaining > 0) stdout.push(chunk.subarray(0, remaining));
        stdoutBytes = options.maxOutputBytes;
        terminate();
        return;
      }
      stdout.push(chunk);
      stdoutBytes += chunk.length;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const remaining = options.maxStderrBytes - stderrBytes;
      if (remaining <= 0) return;
      const saved = chunk.subarray(0, remaining);
      stderr.push(saved);
      stderrBytes += saved.length;
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(options.input);
    child.on("error", () => {
      spawnError = true;
    });
    child.on("exit", (code) => {
      exitCode = code;
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({
        code: spawnError ? 127 : (exitCode ?? code),
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
        aborted,
        outputOverflow,
      });
    });
  });
}
