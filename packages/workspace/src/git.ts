import { execFile } from "node:child_process";

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
