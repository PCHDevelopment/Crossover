import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { git } from "./git.js";
import * as gitModule from "./git.js";
import { materialize } from "./materialize.js";
import { initRoomRepo } from "./repo.js";
import { runSearch, type SearchMatch } from "./search-runner.js";
import { refreshSearchTree, withSearchTree } from "./search-tree.js";

async function commitFixture(
  repo: string,
  parent: string,
  remove: string[],
  add: { path: string; mode: string; content: string }[],
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "crossover-search-commit-"));
  const options = {
    gitDir: repo,
    timeoutMs: 10_000,
    env: {
      GIT_INDEX_FILE: join(dir, "index"),
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  };
  try {
    await git(["read-tree", parent], options);
    for (const path of remove) {
      await git(["update-index", "-z", "--index-info"], {
        ...options,
        input: `0 ${"0".repeat(40)}\t${path}\0`,
      });
    }
    for (const entry of add) {
      const oid = (
        await git(["hash-object", "-w", "--stdin"], { ...options, input: entry.content })
      ).stdout.trim();
      await git(
        ["update-index", "--add", "--cacheinfo", `${entry.mode},${oid},${entry.path}`],
        options,
      );
    }
    const tree = (await git(["write-tree"], options)).stdout.trim();
    return (
      await git(["commit-tree", tree, "-p", parent], { ...options, input: "search fixture\n" })
    ).stdout.trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

it("refreshes only changed paths while preserving untouched files", async () => {
  const root = await mkdtemp(join(tmpdir(), "crossover-search-incremental-"));
  try {
    const repo = await initRoomRepo(root, "room_test");
    const initial = (
      await git(["rev-parse", "refs/room/canonical"], {
        gitDir: repo,
        timeoutMs: 10_000,
      })
    ).stdout.trim();
    await withSearchTree(repo, initial, async () => {});
    const first = await materialize(repo, initial, [
      { type: "create", path: "nested/a [1].txt", content: "first" },
      { type: "create", path: "untouched.txt", content: "preserve" },
    ]);
    await refreshSearchTree(repo, first, initial);
    const second = await materialize(repo, first, [
      { type: "delete", path: "nested/a [1].txt" },
      { type: "create", path: "nested/new.txt", content: "second" },
      { type: "modify", path: "untouched.txt", content: "preserve updated" },
    ]);
    const calls: string[][] = [];
    const runGit = gitModule.git;
    const spy = vi.spyOn(gitModule, "git").mockImplementation((...args) => {
      calls.push([...args[0]]);
      return runGit(...args);
    });
    try {
      await refreshSearchTree(repo, second, first);
      const batchRead = calls.filter((args) => args[0] === "cat-file");
      expect(batchRead).toHaveLength(1);
      expect(batchRead[0]).toContain("--batch");
      expect(calls.some((args) => args[0] === "checkout-index")).toBe(false);
    } finally {
      spy.mockRestore();
    }
    await withSearchTree(repo, second, async (tree) => {
      await expect(readFile(join(tree, "nested/new.txt"), "utf8")).resolves.toBe("second");
      await expect(readFile(join(tree, "untouched.txt"), "utf8")).resolves.toBe("preserve updated");
      await expect(stat(join(tree, "nested/a [1].txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
    const third = await materialize(repo, second, [{ type: "delete", path: "nested/new.txt" }]);
    await refreshSearchTree(repo, third, second);
    await withSearchTree(repo, third, async (tree) => {
      await expect(stat(join(tree, "nested"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rebuilds stale or missing caches without leaving files from the old tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "crossover-search-stale-"));
  try {
    const repo = await initRoomRepo(root, "room_test");
    const initial = (
      await git(["rev-parse", "refs/room/canonical"], { gitDir: repo, timeoutMs: 10_000 })
    ).stdout.trim();
    const target = await materialize(repo, initial, [
      { type: "create", path: "fresh.txt", content: "current tree" },
    ]);
    const cache = `${repo}.search`;
    const tree = join(cache, "tree");
    await withSearchTree(repo, initial, async () => {});
    await writeFile(join(tree, "leftover.txt"), "stale");
    await writeFile(join(cache, "commit"), "some-other-commit");
    await refreshSearchTree(repo, target, initial);
    await withSearchTree(repo, target, async (currentTree) => {
      await expect(readFile(join(currentTree, "fresh.txt"), "utf8")).resolves.toBe("current tree");
      await expect(stat(join(currentTree, "leftover.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
    await rm(tree, { recursive: true, force: true });
    await refreshSearchTree(repo, target, initial);
    await withSearchTree(repo, target, async (currentTree) => {
      await expect(readFile(join(currentTree, "fresh.txt"), "utf8")).resolves.toBe("current tree");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("safely refreshes symlink-to-directory and executable mode changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "crossover-search-types-"));
  try {
    const repo = await initRoomRepo(root, "room_test");
    const initial = (
      await git(["rev-parse", "refs/room/canonical"], { gitDir: repo, timeoutMs: 10_000 })
    ).stdout.trim();
    const outside = join(root, "outside");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(outside));
    const first = await commitFixture(
      repo,
      initial,
      [],
      [
        { path: "a", mode: "120000", content: outside },
        { path: "mode.txt", mode: "100644", content: "mode" },
      ],
    );
    const second = await commitFixture(
      repo,
      first,
      ["a", "mode.txt"],
      [
        { path: "a/inside.txt", mode: "100644", content: "inside" },
        { path: "mode.txt", mode: "100755", content: "mode" },
      ],
    );
    await withSearchTree(repo, first, async () => {});
    await refreshSearchTree(repo, second, first);
    await withSearchTree(repo, second, async (tree) => {
      await expect(readFile(join(tree, "a/inside.txt"), "utf8")).resolves.toBe("inside");
      await expect(stat(join(outside, "inside.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      expect((await stat(join(tree, "mode.txt"))).mode & 0o777).toBe(0o755);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("falls back to a full rebuild after a partial incremental update", async () => {
  const root = await mkdtemp(join(tmpdir(), "crossover-search-fallback-"));
  try {
    const repo = await initRoomRepo(root, "room_test");
    const initial = (
      await git(["rev-parse", "refs/room/canonical"], { gitDir: repo, timeoutMs: 10_000 })
    ).stdout.trim();
    const first = await materialize(repo, initial, [
      { type: "create", path: "old.txt", content: "old" },
    ]);
    const second = await materialize(repo, first, [
      { type: "delete", path: "old.txt" },
      { type: "create", path: "new.txt", content: "new" },
    ]);
    await withSearchTree(repo, first, async () => {});
    const runGit = gitModule.git;
    let failedBatch = false;
    const spy = vi.spyOn(gitModule, "git").mockImplementation((...args) => {
      if (!failedBatch && args[0][0] === "cat-file") {
        failedBatch = true;
        return Promise.reject(new Error("forced partial-update failure"));
      }
      return runGit(...args);
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await refreshSearchTree(repo, second, first);
      expect(failedBatch).toBe(true);
      expect(spy.mock.calls.some(([args]) => args.includes("checkout-index"))).toBe(true);
      expect(warning).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
      warning.mockRestore();
    }
    await withSearchTree(repo, second, async (tree) => {
      await expect(readFile(join(tree, "new.txt"), "utf8")).resolves.toBe("new");
      await expect(stat(join(tree, "old.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("serializes cache refreshes with readers, replaces deleted files and repairs missing cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "crossover-search-tree-"));
  try {
    const repo = await initRoomRepo(root, "room_test");
    const initial = (
      await git(["rev-parse", "refs/room/canonical"], {
        gitDir: repo,
        timeoutMs: 10_000,
      })
    ).stdout.trim();
    const first = await materialize(repo, initial, [
      { type: "create", path: "old", content: "one" },
    ]);
    const second = await materialize(repo, first, [
      { type: "delete", path: "old" },
      { type: "create", path: "new", content: "two" },
    ]);
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reader = withSearchTree(repo, first, async (tree) => {
      entered();
      await gate;
      expect(await readFile(join(tree, "old"), "utf8")).toBe("one");
    });
    await started;
    const writer = withSearchTree(repo, second, async (tree) => {
      expect(await readFile(join(tree, "new"), "utf8")).toBe("two");
      await expect(stat(join(tree, "old"))).rejects.toMatchObject({ code: "ENOENT" });
    });
    release();
    await Promise.all([reader, writer]);
    await rm(join(`${repo}.search`, "tree"), { recursive: true });
    await withSearchTree(repo, second, async (tree) => {
      expect(await readFile(join(tree, "new"), "utf8")).toBe("two");
    });
    await expect(
      withSearchTree(repo, first, async () => {
        throw new Error("Reader failed");
      }),
    ).rejects.toThrow("Reader failed");
    await withSearchTree(repo, second, async () => {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("streams literal/regex/case/glob results, skips symlinks/binaries, bounds matches and rejects bad queries", async () => {
  const root = await mkdtemp(join(tmpdir(), "crossover-search-runner-"));
  try {
    const { writeFile, symlink } = await import("node:fs/promises");
    await writeFile(join(root, "a[1].txt"), "literal.*\nLITERAL.*\nother\n");
    await writeFile(join(root, ".hidden"), "literal.*\n");
    await writeFile(join(root, "binary"), "literal.*\0binary");
    await symlink("a[1].txt", join(root, "link"));
    const options = { query: "literal.*", regex: false, case_sensitive: true };
    const collect = async (params = options) => {
      const matches: SearchMatch[] = [];
      const result = await runSearch(root, params, async (match) => {
        matches.push(match);
        return true;
      });
      return { matches, ...result };
    };
    const literal = await collect();
    expect(literal.matches.map((match) => match.path).sort()).toEqual([".hidden", "a[1].txt"]);
    expect((await collect({ ...options, case_sensitive: false })).matches).toHaveLength(3);
    expect((await collect({ ...options, query: "^other$", regex: true })).matches).toEqual([
      { path: "a[1].txt", line: 3, text: "other" },
    ]);
    expect((await collect({ ...options, query: "no match" })).matches).toEqual([]);
    const glob: SearchMatch[] = [];
    await runSearch(root, { ...options, glob: "*.txt" }, async (match) => {
      glob.push(match);
      return true;
    });
    expect(glob).toEqual([{ path: "a[1].txt", line: 1, text: "literal.*" }]);
    expect(await runSearch(root, options, async () => false)).toEqual({ truncated: true });
    await expect(collect({ ...options, query: "[", regex: true })).rejects.toMatchObject({
      code: "VALIDATION",
      details: { reason: "invalid_search" },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
