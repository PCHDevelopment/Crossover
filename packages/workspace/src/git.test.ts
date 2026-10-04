import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertGitVersion, git, GitError } from "./git.js";

const dirs: string[] = [];
async function fixture(source: string) {
  const dir = await mkdtemp(join(tmpdir(), "crossover-git-"));
  dirs.push(dir);
  await writeFile(join(dir, "git"), `#!${process.execPath}\n${source}\n`, { mode: 0o755 });
  return { dir, env: { PATH: dir } };
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("git", () => {
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
    const f = await fixture('process.stderr.write("bad revision"); process.exit(7);');
    await expect(git(["status"], { env: f.env, timeoutMs: 5000 })).rejects.toMatchObject({
      name: "GitError",
      exitCode: 7,
      stderr: "bad revision",
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
  it.each(["2.38.0", "2.51.1", "3.0.0", "2.39.3 (Apple Git-145)"])(
    "accepts %s",
    async (version) => {
      const f = await fixture(
        `process.stdout.write(${JSON.stringify("git version ")} + ${JSON.stringify(version)});`,
      );
      await expect(assertGitVersion({ env: f.env, timeoutMs: 5000 })).resolves.toBeUndefined();
    },
  );
  it.each(["2.37.9", "1.99.0", "unrecognized"])("rejects %s", async (version) => {
    const f = await fixture(
      `process.stdout.write(${JSON.stringify("git version ")} + ${JSON.stringify(version)});`,
    );
    await expect(assertGitVersion({ env: f.env, timeoutMs: 5000 })).rejects.toBeInstanceOf(
      GitError,
    );
  });
});
