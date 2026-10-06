import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CrossoverError } from "@crossover/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as gitModule from "./git.js";
import { git, GitError } from "./git.js";
import { materialize } from "./materialize.js";
import type { Operation } from "./operations.js";
import { initRoomRepo } from "./repo.js";

const dirs: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "crossover-materialize-"));
  dirs.push(root);
  // Other test files also materialize commits concurrently; observe only this fixture's indexes.
  vi.stubEnv("TMPDIR", root);
  const repo = await initRoomRepo(root, "room_test");
  const options = { gitDir: repo, timeoutMs: 5000 };
  const base = (await git(["rev-parse", "refs/room/canonical"], options)).stdout.trim();
  const read = async (commit: string, path: string) =>
    (await git(["show", `${commit}:${path}`], options)).stdout;
  return { repo, base, options, read };
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("materialize", () => {
  const patch = (path = "file", before = "old", after = "new") =>
    `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-${before}\n+${after}\n`;

  it("applies patches in sequence with full-content operations and quoted filenames", async () => {
    const f = await fixture();
    const commit = await materialize(f.repo, f.base, [
      { type: "create", path: "file", content: "old\n" },
      { type: "modify", path: "file", patch: patch() },
      { type: "modify", path: "file", patch: patch("file", "new", "final") },
      { type: "rename", from: "file", to: "renamed" },
      { type: "modify", path: "renamed", patch: patch("renamed", "final", "renamed") },
      { type: "create", path: "tab\tname", content: "old\n" },
      {
        type: "modify",
        path: "tab\tname",
        patch: '--- "a/tab\\tname"\n+++ "b/tab\\tname"\n@@ -1 +1 @@\n-old\n+new\n',
      },
    ]);
    expect(await f.read(commit, "renamed")).toBe("renamed\n");
    expect(await f.read(commit, "tab\tname")).toBe("new\n");
  });

  it.each([
    patch("other"),
    patch().replace("--- a/file", "--- a/other"),
    patch().replace("--- a/file", "--- /dev/null").replace("@@ -1 +1 @@\n-old", "@@ -0,0 +1 @@"),
    patch()
      .replace("+++ b/file", "+++ /dev/null")
      .replace("@@ -1 +1 @@\n-old\n+new", "@@ -1 +0,0 @@\n-old"),
    "diff --git a/file b/file\nold mode 100644\nnew mode 100755\n",
    "diff --git a/file b/other\nsimilarity index 100%\nrename from file\nrename to other\n",
    patch() + patch("other"),
  ])("rejects patches that change paths or structure", async (input) => {
    const f = await fixture();
    const base = await materialize(f.repo, f.base, [
      { type: "create", path: "file", content: "old\n" },
    ]);
    const spy = vi.spyOn(gitModule, "git");
    await expect(
      materialize(f.repo, base, [{ type: "modify", path: "file", patch: input }]),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      details: { path: "file", reason: "patch_path_mismatch" },
    });
    expect(spy.mock.calls.some(([args]) => args.includes("--cached"))).toBe(false);
  });

  it("reports failed patch diagnostics and cleans temporary files", async () => {
    const f = await fixture();
    const base = await materialize(f.repo, f.base, [
      { type: "create", path: "file", content: "different\n" },
    ]);
    const before = (await readdir(tmpdir()))
      .filter((name) => name.startsWith("crossover-index-"))
      .sort();
    await expect(
      materialize(f.repo, base, [{ type: "modify", path: "file", patch: patch() }]),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      details: {
        path: "file",
        reason: "patch_failed",
        message: expect.stringContaining("patch does not apply"),
      },
    });
    expect(
      (await readdir(tmpdir())).filter((name) => name.startsWith("crossover-index-")).sort(),
    ).toEqual(before);
  });

  it("batches blob writes and releases directory prefixes after deletion", async () => {
    const f = await fixture();
    const spy = vi.spyOn(gitModule, "git");
    const commit = await materialize(f.repo, f.base, [
      { type: "create", path: "dir/a", content: "a" },
      { type: "create", path: "dir/b", content: "b" },
      { type: "delete", path: "dir/a" },
      { type: "delete", path: "dir/b" },
      { type: "create", path: "dir", content: "file now" },
    ]);
    expect(spy.mock.calls.filter(([args]) => args[0] === "hash-object")).toHaveLength(1);
    expect(await f.read(commit, "dir")).toBe("file now");
  });

  it("applies all text operations in order, preserving untouched files and canonical", async () => {
    const f = await fixture();
    const first = await materialize(f.repo, f.base, [
      { type: "create", path: "src/a.ts", content: "original\n" },
      { type: "create", path: "delete.txt", content: "delete" },
      { type: "create", path: "unchanged.txt", content: "keep" },
    ]);
    const second = await materialize(f.repo, first, [
      { type: "modify", path: "src/a.ts", content: "modified\n" },
      { type: "rename", from: "src/a.ts", to: "renamed.ts" },
      { type: "delete", path: "delete.txt" },
      { type: "create", path: "empty", content: "" },
    ]);
    expect(await f.read(second, "renamed.ts")).toBe("modified\n");
    expect(await f.read(second, "unchanged.txt")).toBe("keep");
    expect(await f.read(second, "empty")).toBe("");
    expect((await git(["ls-tree", "-r", "--name-only", second], f.options)).stdout).toBe(
      "empty\nrenamed.ts\nunchanged.txt\n",
    );
    expect((await git(["rev-parse", `${second}^`], f.options)).stdout.trim()).toBe(first);
    expect((await git(["rev-parse", "refs/room/canonical"], f.options)).stdout.trim()).toBe(f.base);
    expect(await readdir(f.repo)).not.toContain("index");
    expect((await git(["rev-parse", "--is-bare-repository"], f.options)).stdout.trim()).toBe(
      "true",
    );
  });

  it("handles normalized Unicode, tabs, newlines and option-like paths literally", async () => {
    const f = await fixture();
    const paths = ["cafe\u0301.txt", "tab\tfile", "line\nfile", "-option", "space name"];
    const commit = await materialize(
      f.repo,
      f.base,
      paths.map((path) => ({ type: "create", path, content: "UTF-8: café 🌱\n" })),
    );
    for (const path of paths) {
      expect(await f.read(commit, path.normalize("NFC"))).toBe("UTF-8: café 🌱\n");
    }
    const renamed = await materialize(f.repo, commit, [
      { type: "rename", from: "-option", to: "new", content: "" },
    ]);
    expect(await f.read(renamed, "new")).toBe("");
  });

  it.each<{ operation: Operation; path: string; reason: string }>([
    { operation: { type: "create", path: "a", content: "x" }, path: "a", reason: "exists" },
    {
      operation: { type: "modify", path: "missing", content: "x" },
      path: "missing",
      reason: "missing",
    },
    { operation: { type: "delete", path: "missing" }, path: "missing", reason: "missing" },
    {
      operation: { type: "rename", from: "missing", to: "new" },
      path: "missing",
      reason: "missing",
    },
    {
      operation: { type: "rename", from: "a", to: "b" },
      path: "b",
      reason: "rename_target_exists",
    },
    {
      operation: { type: "create", path: "a/child", content: "x" },
      path: "a/child",
      reason: "exists",
    },
    { operation: { type: "create", path: "dir", content: "x" }, path: "dir", reason: "exists" },
  ])("rejects $operation.type with $reason at $path", async ({ operation, path, reason }) => {
    const f = await fixture();
    const base = await materialize(f.repo, f.base, [
      { type: "create", path: "a", content: "a" },
      { type: "create", path: "b", content: "b" },
      { type: "create", path: "dir/file", content: "nested" },
    ]);
    const promise = materialize(f.repo, base, [operation]);
    await expect(promise).rejects.toBeInstanceOf(CrossoverError);
    await expect(promise).rejects.toMatchObject({ code: "VALIDATION", details: { path, reason } });
    expect(await f.read(base, "a")).toBe("a");
  });

  it("preserves executable modes across modify and rename", async () => {
    const f = await fixture();
    const blob = (
      await git(["hash-object", "-w", "--stdin"], { ...f.options, input: "run" })
    ).stdout.trim();
    const tree = (
      await git(["mktree"], { ...f.options, input: `100755 blob ${blob}\trun.sh\n` })
    ).stdout.trim();
    const base = (
      await git(["commit-tree", tree, "-p", f.base], {
        ...f.options,
        input: "Executable\n",
        env: {
          GIT_AUTHOR_NAME: "Test",
          GIT_AUTHOR_EMAIL: "test@example.com",
          GIT_COMMITTER_NAME: "Test",
          GIT_COMMITTER_EMAIL: "test@example.com",
        },
      })
    ).stdout.trim();
    const commit = await materialize(f.repo, base, [
      { type: "modify", path: "run.sh", content: "updated" },
      { type: "rename", from: "run.sh", to: "renamed.sh" },
    ]);
    expect((await git(["ls-tree", commit], f.options)).stdout).toMatch(/^100755 blob /);
  });

  it.each(["160000", "120000"])("handles content replacement on mode %s", async (mode) => {
    const f = await fixture();
    const sha =
      mode === "160000"
        ? f.base
        : (
            await git(["hash-object", "-w", "--stdin"], { ...f.options, input: "target" })
          ).stdout.trim();
    const tree = (
      await git(["mktree"], {
        ...f.options,
        input: `${mode} ${mode === "160000" ? "commit" : "blob"} ${sha}\tentry\n`,
      })
    ).stdout.trim();
    const base = (
      await git(["commit-tree", tree, "-p", f.base], {
        ...f.options,
        input: "Non-regular entry\n",
        env: {
          GIT_AUTHOR_NAME: "Test",
          GIT_AUTHOR_EMAIL: "test@example.com",
          GIT_COMMITTER_NAME: "Test",
          GIT_COMMITTER_EMAIL: "test@example.com",
        },
      })
    ).stdout.trim();
    for (const operation of [
      { type: "modify", path: "entry", content: "replacement" },
      { type: "rename", from: "entry", to: "new", content: "replacement" },
    ] satisfies Operation[]) {
      if (mode === "160000") {
        await expect(materialize(f.repo, base, [operation])).rejects.toMatchObject({
          code: "VALIDATION",
          details: { path: "entry", reason: "not_a_file" },
        });
      } else {
        const modified = await materialize(f.repo, base, [operation]);
        expect(await f.read(modified, operation.type === "rename" ? "new" : "entry")).toBe(
          "replacement",
        );
        expect((await git(["ls-tree", modified], f.options)).stdout).toMatch(/^120000 blob /);
      }
    }
    const renamed = await materialize(f.repo, base, [{ type: "rename", from: "entry", to: "new" }]);
    expect((await git(["ls-tree", renamed], f.options)).stdout).toBe(
      `${mode} ${mode === "160000" ? "commit" : "blob"} ${sha}\tnew\n`,
    );
  });

  it("cleans temporary indexes on success, validation failure and Git failure", async () => {
    const f = await fixture();
    const indexes = async () =>
      (await readdir(tmpdir())).filter((name) => name.startsWith("crossover-index-")).sort();
    const before = await indexes();
    await materialize(f.repo, f.base, []);
    expect(await indexes()).toEqual(before);
    await expect(
      materialize(f.repo, f.base, [
        { type: "create", path: "added", content: "candidate" },
        { type: "delete", path: "missing" },
      ]),
    ).rejects.toBeInstanceOf(CrossoverError);
    expect(await indexes()).toEqual(before);
    await expect(materialize(f.repo, "bad-revision", [])).rejects.toBeInstanceOf(GitError);
    expect(await indexes()).toEqual(before);
  });

  it("isolates simultaneous materializations based on the same commit", async () => {
    const f = await fixture();
    const [a, b] = await Promise.all([
      materialize(f.repo, f.base, [{ type: "create", path: "file", content: "a" }]),
      materialize(f.repo, f.base, [{ type: "create", path: "file", content: "b" }]),
    ]);
    expect(await f.read(a, "file")).toBe("a");
    expect(await f.read(b, "file")).toBe("b");
  });

  it("validates every path, including rename targets, before materializing", async () => {
    const f = await fixture();
    await expect(
      materialize(f.repo, f.base, [{ type: "rename", from: "a", to: "../escape" }]),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });
});
