import { execFile, spawn } from "node:child_process";

export interface GitOptions {
  cwd?: string;
  gitDir?: string;
  input?: string | Buffer;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  encoding?: "utf8" | "buffer";
  maxBuffer?: number;
}

export interface GitResult<T extends string | Buffer = string> {
  stdout: T;
  stderr: T;
}

export interface GitStreamResult {
  exitCode: number | null;
  stderr: string;
  truncated: boolean;
}

export class GitError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string,
    readonly timedOut = false,
    readonly signal: NodeJS.Signals | null = null,
    options?: ErrorOptions,
    readonly stdout: string | Buffer = "",
  ) {
    super(message, options);
    this.name = "GitError";
  }
}

/** Run the internal Git engine without a shell (§9.1, D1). */
export function git(
  args: readonly string[],
  options: GitOptions & { encoding: "buffer" },
): Promise<GitResult<Buffer>>;
export function git(
  args: readonly string[],
  options: GitOptions & { encoding?: "utf8" },
): Promise<GitResult>;
export function git(
  args: readonly string[],
  options: GitOptions,
): Promise<GitResult<string | Buffer>>;
export function git(
  args: readonly string[],
  options: GitOptions,
): Promise<GitResult<string | Buffer>> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be a positive safe integer");
  }
  const gitArgs =
    options.gitDir === undefined ? [...args] : [`--git-dir=${options.gitDir}`, ...args];
  const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
  );
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      gitArgs,
      {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        env: {
          ...inheritedEnv,
          ...options.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_NOSYSTEM: "1",
        },
        encoding: options.encoding === "buffer" ? "buffer" : "utf8",
        timeout: options.timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new GitError(
              error.killed ? "Git process was killed" : "Git command failed",
              typeof error.code === "number" ? error.code : null,
              typeof stderr === "string" ? stderr : stderr.toString("utf8"),
              error.killed && error.signal === "SIGKILL",
              error.signal ?? null,
              { cause: error },
              stdout,
            ),
          );
          return;
        }
        resolve({ stdout, stderr });
      },
    );
    // EPIPE is reported by the process callback when Git exits before consuming stdin.
    child.stdin?.on("error", () => {});
    child.stdin?.end(options.input);
  });
}

/** Stream a Git command's stdout with the same environment hardening as `git()`. */
export async function gitStream(
  args: readonly string[],
  options: GitOptions,
  onChunk: (chunk: Buffer) => Promise<boolean> | boolean,
): Promise<GitStreamResult> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)
    throw new RangeError("timeoutMs must be a positive safe integer");
  const maxOutput = options.maxBuffer ?? 32 * 1024 * 1024;
  if (!Number.isSafeInteger(maxOutput) || maxOutput <= 0)
    throw new RangeError("maxBuffer must be a positive safe integer");
  const gitArgs =
    options.gitDir === undefined ? [...args] : [`--git-dir=${options.gitDir}`, ...args];
  const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
  );
  const child = spawn("git", gitArgs, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: {
      ...inheritedEnv,
      ...options.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let timedOut = false;
  let truncated = false;
  let outputBytes = 0;
  let stderr = "";
  let callbackError: unknown;
  let rejectTimeout: (reason: Error) => void = () => {};
  const timeoutError = new Error("Git command timed out");
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  // The timeout can fire while stdout is being read, before the callback race.
  void timeoutPromise.catch(() => {});
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
    rejectTimeout(timeoutError);
  }, options.timeoutMs);
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    if (stderr.length < 8192) stderr += chunk.slice(0, 8192 - stderr.length);
  });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    },
  );
  void closed.catch(() => {});
  try {
    for await (const raw of child.stdout) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
      const remaining = maxOutput - outputBytes;
      const accepted = chunk.subarray(0, Math.max(0, remaining));
      outputBytes += accepted.length;
      let shouldContinue = true;
      if (accepted.length) {
        try {
          shouldContinue = await Promise.race([onChunk(accepted), timeoutPromise]);
        } catch (error) {
          if (error !== timeoutError) callbackError = error;
          child.kill("SIGKILL");
          throw error;
        }
      }
      if (!shouldContinue) {
        truncated = true;
        child.kill("SIGKILL");
        break;
      }
      if (accepted.length !== chunk.length) {
        truncated = true;
        child.kill("SIGKILL");
        break;
      }
    }
    const { code, signal } = await closed;
    if (timedOut) throw new GitError("Git command timed out", null, stderr, true, signal);
    if (!truncated && code !== 0 && code !== 1)
      throw new GitError("Git command failed", code, stderr, false, signal);
    return { exitCode: code, stderr, truncated };
  } catch (error) {
    if (callbackError !== undefined) throw callbackError;
    if (timedOut) {
      const { signal } = await closed;
      throw new GitError("Git command timed out", null, stderr, true, signal);
    }
    if (error instanceof GitError) throw error;
    throw new GitError("Git command failed", null, stderr, timedOut, null, { cause: error });
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");
    await closed.catch(() => {});
  }
}

/** Fail startup when the merge-tree engine is unavailable (D1). */
export async function assertGitVersion(options: GitOptions = { timeoutMs: 10_000 }): Promise<void> {
  const { stdout, stderr } = await git(["--version"], { ...options, encoding: "utf8" });
  const match = /^git version (\d+)\.(\d+)(?:\.|\s|$)/.exec(stdout.trim());
  const major = Number(match?.[1]);
  const minor = Number(match?.[2]);
  if (!match || major < 2 || (major === 2 && minor < 40)) {
    throw new GitError("Git >= 2.40 is required", 0, stderr);
  }
}
