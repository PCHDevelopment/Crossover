import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { git } from "./git.js";
import { materialize } from "./materialize.js";
import type { Operation } from "./operations.js";
import { initRoomRepo } from "./repo.js";
import { ignoredWorkspacePaths, validateIntroducedPaths } from "./ignore.js";
import * as gitModule from "./git.js";
import { GitError } from "./git.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "crossover-ignore-test-"));
  dirs.push(root);
  vi.stubEnv("TMPDIR", root);
  const repo = await initRoomRepo(root, "room_test");
  const options = { gitDir: repo, timeoutMs: 5000 };
  const canonical = (await git(["rev-parse", "refs/room/canonical"], options)).stdout.trim();
  const base = await materialize(
    repo,
    canonical,
    Object.entries(files).map(([path, content]) => ({
      type: "create",
      path,
      content,
    })),
  );
  return { root, repo, base, canonical, options };
}

async function rejected(
  f: Awaited<ReturnType<typeof fixture>>,
  operation: Operation,
  path: string,
) {
  const before = await readdir(f.root);
  await expect(materialize(f.repo, f.base, [operation])).rejects.toMatchObject({
    code: "VALIDATION",
    details: { path, reason: "ignored" },
  });
  expect(await readdir(f.root)).toEqual(before);
  expect((await git(["rev-parse", "refs/room/canonical"], f.options)).stdout.trim()).toBe(
    f.canonical,
  );
}

describe("workspace ignore rules", () => {
  // Measured (T1529): idle n/a, 3x load 2822 ms; budget 7x.
  it("respects nested negations, root anchoring, globstars and directory exclusions", async () => {
    const f = await fixture({
      ".gitignore": "*.log\n/root-only\ncache/\n**/generated/*.txt\n",
      "sub/.gitignore": "!keep.log\n",
    });
    for (const path of [
      "drop.log",
      "sub/drop.log",
      "root-only",
      "cache/new",
      "sub/generated/a.txt",
    ]) {
      await rejected(f, { type: "create", path, content: "x" }, path);
    }
    const commit = await materialize(f.repo, f.base, [
      { type: "create", path: "sub/keep.log", content: "kept" },
      { type: "create", path: "sub/root-only", content: "nested" },
    ]);
    expect((await git(["show", `${commit}:sub/keep.log`], f.options)).stdout).toBe("kept");
  }, 20_000);

  it("does not reinclude files beneath an excluded parent directory", async () => {
    const f = await fixture({ ".gitignore": "logs/\n", "logs/.gitignore": "!keep.log\n" });
    await rejected(f, { type: "create", path: "logs/keep.log", content: "x" }, "logs/keep.log");
  });

  it.each<Operation>([
    { type: "modify", path: "tracked.log", content: "new" },
    { type: "delete", path: "tracked.log" },
    { type: "rename", from: "tracked.log", to: "renamed.txt" },
  ])("allows operations on tracked ignored paths: %j", async (operation) => {
    const f = await fixture({
      ".gitignore": "*.log\n",
      "tracked.log": "old",
      "allowed.txt": "old",
    });
    await expect(materialize(f.repo, f.base, [operation])).resolves.toMatch(/^[a-f0-9]{40}$/);
  });

  it("rejects ignored rename destinations", async () => {
    const f = await fixture({ ".gitignore": "*.log\n", "allowed.txt": "old" });
    await rejected(f, { type: "rename", from: "allowed.txt", to: "new.log" }, "new.log");
  });

  // Measured (T1529): idle n/a, 3x load 3060 ms; budget 7x.
  it("treats .roomignore as additional root rules below .gitignore negations", async () => {
    const f = await fixture({
      ".roomignore": "*.log\nprivate/\n",
      ".gitignore": "!root.log\n",
      "sub/.gitignore": "!keep.log\n",
    });
    for (const path of ["drop.log", "sub/drop.log", "private/file.txt"]) {
      await rejected(f, { type: "create", path, content: "x" }, path);
    }
    await materialize(f.repo, f.base, [
      { type: "create", path: "root.log", content: "x" },
      { type: "create", path: "sub/keep.log", content: "x" },
    ]);
  }, 25_000);

  it("uses the base snapshot even when operations remove an ignore rule", async () => {
    const f = await fixture({ ".gitignore": "*.log\n" });
    await expect(
      materialize(f.repo, f.base, [
        { type: "modify", path: ".gitignore", content: "" },
        { type: "create", path: "new.log", content: "x" },
      ]),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      details: { path: "new.log", reason: "ignored" },
    });
    const unignored = await materialize(f.repo, f.base, [
      { type: "modify", path: ".gitignore", content: "" },
    ]);
    await materialize(f.repo, unignored, [{ type: "create", path: "new.log", content: "x" }]);
  });

  it("filters sandbox additions using only ignore files from the canonical base tree", async () => {
    const f = await fixture({ ".gitignore": "*.generated\n", ".roomignore": "private/\n" });
    const listing = await git(["ls-tree", "-rz", "--full-tree", f.base], f.options);
    const entries = new Map<string, { mode: string; sha: string }>();
    for (const record of listing.stdout.split("\0")) {
      if (!record) continue;
      const tab = record.indexOf("\t");
      const [mode, , sha] = record.slice(0, tab).split(" ");
      entries.set(record.slice(tab + 1), { mode: mode!, sha: sha! });
    }
    const sandbox = join(f.root, "sandbox");
    await mkdir(sandbox);
    // These working-copy rules would allow both paths, but are never passed to the checker.
    await writeFile(join(sandbox, ".gitignore"), "!*.generated\n");
    await writeFile(join(sandbox, ".roomignore"), "!private/\n");

    await expect(
      ignoredWorkspacePaths(f.repo, entries, [
        "allowed.txt",
        "blocked.generated",
        "private/new.txt",
      ]),
    ).resolves.toEqual(new Set(["blocked.generated", "private/new.txt"]));
  });

  it("handles literal escapes and unusual filenames without line parsing", async () => {
    const f = await fixture({ ".gitignore": "\\#secret\n\\!secret\n*.tmp\n" });
    for (const path of ["#secret", "!secret", "tab\tname.tmp", "line\nname.tmp", "é.tmp"]) {
      await rejected(f, { type: "create", path, content: "x" }, path);
    }
  });

  it("does not inherit host excludes or repository-local excludes", async () => {
    const f = await fixture({ ".gitignore": "*.log\n" });
    await mkdir(join(f.root, "git"));
    const config = join(f.root, "git", "config");
    const excludes = join(f.root, "global-ignore");
    await writeFile(excludes, "*.txt\n");
    await writeFile(config, `[core]\nexcludesFile = ${excludes}\n`);
    await writeFile(join(f.root, "git", "ignore"), "*.txt\n");
    vi.stubEnv("GIT_CONFIG_GLOBAL", config);
    vi.stubEnv("XDG_CONFIG_HOME", f.root);
    await git(["config", "core.excludesFile", excludes], f.options);
    const commit = await materialize(f.repo, f.base, [
      { type: "create", path: "allowed.txt", content: "x" },
    ]);
    expect((await git(["show", `${commit}:allowed.txt`], f.options)).stdout).toBe("x");
  });

  it("does not interpret symlink ignore blobs as rules", async () => {
    await validateIntroducedPaths(
      "unused",
      new Map([
        [".gitignore", { mode: "120000", sha: "unused" }],
        [".roomignore", { mode: "120000", sha: "unused" }],
      ]),
      ["new.log"],
    );
  });

  it("propagates Git engine failures and cleans temporary files", async () => {
    const f = await fixture({ ".gitignore": "*.log\n" });
    const original = gitModule.git;
    const failure = new GitError("engine failure", 128, "fatal");
    vi.spyOn(gitModule, "git").mockImplementation(async (args, options) => {
      if (args.includes("check-ignore")) throw failure;
      return original(args, options);
    });
    const before = await readdir(f.root);
    await expect(
      materialize(f.repo, f.base, [{ type: "create", path: "new.txt", content: "x" }]),
    ).rejects.toBe(failure);
    expect(await readdir(f.root)).toEqual(before);
  });
});
