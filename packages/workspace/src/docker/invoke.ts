import { execFile, spawn } from "node:child_process";

export interface DockerInvocationOptions {
  timeoutMs?: number;
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
  input?: string | Buffer;
  /** Stream stdout to the caller; returning false stops the child process. */
  onStdout?: (chunk: string) => boolean;
}

export interface DockerInvocationResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type DockerInvoker = (
  args: readonly string[],
  options?: DockerInvocationOptions,
) => Promise<DockerInvocationResult>;

export async function mustSucceed(
  invoke: DockerInvoker,
  args: readonly string[],
  message: string,
): Promise<string> {
  const result = await invoke(args);
  if (result.code !== 0) throw new Error(`${message}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

export interface DockerExecutionDriverOptions {
  dockerBinary?: string;
  /** Docker Engine Unix socket used for host-side resource stats. */
  dockerSocketPath?: string;
  image?: string;
  /** Required with hard enforcement; passed directly as Docker --opt values. */
  volumeDriver?: string;
  volumeOptions?: Readonly<Record<string, string>>;
  /** Optional Docker runtime such as gVisor's `runsc`. */
  runtime?: string;
  /** Operator-provisioned allowlist proxy container; sandboxes get a private internal network. */
  egressProxyContainer?: string;
  egressProxyPort?: number;
  /** Shared HMAC secret used to mint a credential scoped to each sandbox ID. */
  egressProxySecret?: string;
  /** Name of the server container attached to the private crossover-git network. */
  gitInternalContainer?: string;
  /** Name of the private network shared by the server and one-shot fetchers. */
  gitInternalNetwork?: string;
  gitInternalPort?: number;
  /** HMAC secret for five-minute, sandbox-scoped workspace fetch credentials. */
  gitInternalTokenSecret?: string;
  gitFetcherImage?: string;
  /** Test seam; production callers should use the Docker CLI. */
  invoke?: DockerInvoker;
}

export function invokeDocker(
  binary: string,
  args: readonly string[],
  options: DockerInvocationOptions = {},
): Promise<DockerInvocationResult> {
  if (options.onStdout || options.input !== undefined)
    return invokeDockerStreaming(binary, args, options, options.onStdout ?? (() => true));

  return new Promise<DockerInvocationResult>((resolve) => {
    execFile(
      binary,
      [...args],
      {
        encoding: "utf8",
        timeout: options.timeoutMs ?? 20_000,
        maxBuffer: options.maxBuffer ?? 1024 * 1024,
        ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
      },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
  });
}

function invokeDockerStreaming(
  binary: string,
  args: readonly string[],
  options: DockerInvocationOptions,
  onStdout: (chunk: string) => boolean,
): Promise<DockerInvocationResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [...args], {
      env: options.env ? { ...process.env, ...options.env } : process.env,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const timeoutMs = options.timeoutMs ?? 20_000;
    const maxStderrBytes = options.maxBuffer ?? 1024 * 1024;
    let stderr = "";
    let stderrBytes = 0;
    let stoppedEarly = false;
    let callbackError: unknown;
    let timedOut = false;
    let settled = false;
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
    }, timeoutMs);

    const stdout = child.stdout;
    const stderrStream = child.stderr;
    if (!stdout || !stderrStream) {
      settled = true;
      clearTimeout(timeout);
      reject(new Error("Docker process streams are unavailable"));
      return;
    }
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => {
      if (stoppedEarly || callbackError !== undefined) return;
      try {
        if (!onStdout(chunk)) {
          stoppedEarly = true;
          terminate();
        }
      } catch (error) {
        callbackError = error;
        terminate();
      }
    });

    stderrStream.setEncoding("utf8");
    stderrStream.on("data", (chunk: string) => {
      if (stderrBytes >= maxStderrBytes) return;
      const bytes = Buffer.from(chunk);
      const saved = bytes.subarray(0, maxStderrBytes - stderrBytes);
      stderr += saved.toString("utf8");
      stderrBytes += saved.length;
    });
    if (child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(options.input);
    }

    child.once("error", (error) => {
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (callbackError !== undefined) {
        reject(callbackError);
        return;
      }
      resolve({
        code: stoppedEarly ? 0 : (code ?? (timedOut ? 124 : 1)),
        stdout: "",
        stderr,
      });
    });
  });
}
