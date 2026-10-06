import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertGitVersion, git, GitError } from "./git.js";

const dirs: string[] = [];
async function fixture(source: string) {
  const dir = await mkdtemp(join(tmpdir(), "crossover-git-"));
  dirs.push(dir);
  await writeFile(join(dir, "git"), `#!${process.execPath}\n${source}\n`, { mode: 0o755 });
  return { dir, env: { PATH: dir } };
}
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("git", () => {
  it("round-trips non-UTF-8 blob bytes in buffer mode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crossover-binary-"));
    dirs.push(dir);
    const repo = join(dir, "room.git");
    await git(["init", "--bare", repo], { timeoutMs: 5000 });
    const bytes = Buffer.from([0, 255, 254, 128, 195, 40, 10]);
    const { stdout } = await git(["hash-object", "-w", "--stdin"], {
      gitDir: repo,
      input: bytes,
      timeoutMs: 5000,
    });
    const result = await git(["cat-file", "blob", stdout.trim()], {
      gitDir: repo,
      encoding: "buffer",
      timeoutMs: 5000,
    });
    expect(result.stdout).toEqual(bytes);
    expect(Buffer.isBuffer(result.stderr)).toBe(true);
  });

  it("drops inherited Git settings while retaining explicit overrides", async () => {
    vi.stubEnv("GIT_DIR", "/untrusted/repo");
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", "core.hooksPath");
    vi.stubEnv("GIT_CONFIG_VALUE_0", "/untrusted/hooks");
    vi.stubEnv("GIT_FUTURE_SETTING", "untrusted");
    const f = await fixture(
      'process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("GIT_")))));',
    );
    const result = await git([], {
      env: { ...f.env, GIT_INDEX_FILE: "/explicit/index", GIT_CONFIG_NOSYSTEM: "0" },
      timeoutMs: 5000,
    });
    expect(JSON.parse(result.stdout)).toEqual({
      GIT_INDEX_FILE: "/explicit/index",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    });
  });

  it("keeps error diagnostics as text in buffer mode", async () => {
    const f = await fixture(
      'process.stdout.write(Buffer.from([0, 255])); process.stderr.write("bad blob"); process.exit(7);',
    );
    await expect(
      git([], { env: f.env, encoding: "buffer", timeoutMs: 5000 }),
    ).rejects.toMatchObject({ exitCode: 7, stderr: "bad blob", stdout: Buffer.from([0, 255]) });
  });

  it("runs Git with stdin and an explicit bare repository", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crossover-repo-"));
    dirs.push(dir);
    const repo = join(dir, "room.git");
    await git(["init", "--bare", repo], { cwd: dir, timeoutMs: 5000 });
    const result = await git(["hash-object", "-w", "--stdin"], {
      gitDir: repo,
      input: "hello\n",
      timeoutMs: 5000,
    });
    expect(result.stdout.trim()).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
    expect(
      (await git(["cat-file", "blob", result.stdout.trim()], { gitDir: repo, timeoutMs: 5000 }))
        .stdout,
    ).toBe("hello\n");
  });

  it("passes arguments literally and preserves cwd and env overrides", async () => {
    const f = await fixture(
      "process.stdout.write(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),value:process.env.TEST_VALUE}));",
    );
    const args = ["$(touch injected)", "; echo injected", "spaces here"];
    const result = await git(args, {
      cwd: f.dir,
      env: { ...f.env, TEST_VALUE: "ok" },
      timeoutMs: 5000,
    });
    expect(JSON.parse(result.stdout)).toEqual({ args, cwd: f.dir, value: "ok" });
  });

  it("retains the exit code and stderr in a typed error", async () => {
    const f = await fixture(
      'process.stdout.write("conflict output"); process.stderr.write("bad revision"); process.exit(7);',
    );
    await expect(git(["status"], { env: f.env, timeoutMs: 5000 })).rejects.toMatchObject({
      name: "GitError",
      exitCode: 7,
      stderr: "bad revision",
      stdout: "conflict output",
      timedOut: false,
    });
  });

  it("kills a hung process on timeout", async () => {
    const f = await fixture(
      'require("node:fs").writeFileSync(process.env.PID_FILE, String(process.pid)); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);',
    );
    const pidFile = join(f.dir, "pid");
    await expect(
      git([], { env: { ...f.env, PID_FILE: pidFile }, timeoutMs: 500 }),
    ).rejects.toMatchObject({ name: "GitError", timedOut: true, signal: "SIGKILL" });
    const pid = Number(await readFile(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });
});

describe("assertGitVersion", () => {
  it.each(["2.40.0", "2.51.1", "3.0.0", "2.40.3 (Apple Git-145)"])(
    "accepts %s",
    async (version) => {
      const f = await fixture(
        `process.stdout.write(${JSON.stringify("git version ")} + ${JSON.stringify(version)});`,
      );
      await expect(assertGitVersion({ env: f.env, timeoutMs: 5000 })).resolves.toBeUndefined();
    },
  );
  it.each(["2.39.9", "2.38.0", "1.99.0", "unrecognized"])("rejects %s", async (version) => {
    const f = await fixture(
      `process.stdout.write(${JSON.stringify("git version ")} + ${JSON.stringify(version)});`,
    );
    await expect(assertGitVersion({ env: f.env, timeoutMs: 5000 })).rejects.toBeInstanceOf(
      GitError,
    );
  });
});
