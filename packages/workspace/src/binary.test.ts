import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyConflicts } from "./conflicts.js";
import { git } from "./git.js";
import { materialize } from "./materialize.js";
import { merge } from "./merge.js";
import type { Operation } from "./operations.js";
import { initRoomRepo } from "./repo.js";
import { BINARY_SIZE, readMergeBlob } from "./binary.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(content: string) {
  const root = await mkdtemp(join(tmpdir(), "crossover-binary-test-"));
  dirs.push(root);
  const repo = await initRoomRepo(root, "room_test");
  const options = { gitDir: repo, timeoutMs: 10_000 };
  const empty = (await git(["rev-parse", "refs/room/canonical"], options)).stdout.trim();
  const base = await materialize(repo, empty, [{ type: "create", path: "file", content }]);
  const change = (content: string, parent = base) =>
    materialize(repo, parent, [{ type: "modify", path: "file", content }]);
  return { repo, base, empty, options, change };
}

async function binaryConflict(
  f: Awaited<ReturnType<typeof fixture>>,
  head: string,
  candidate: string,
  base = f.base,
) {
  const result = await merge(f.repo, base, head, candidate);
  expect(result.clean).toBe(false);
  if (result.clean) throw new Error("Expected binary conflict");
  expect(await classifyConflicts(f.repo, result)).toMatchObject([
    { path: "file", kind: "BINARY", hunks: [] },
  ]);
  expect((await git(["rev-parse", "refs/room/canonical"], f.options)).stdout.trim()).toBe(f.empty);
  return result;
}

describe("binary and large file policy", () => {
  it("rejects identical concurrent binary edits even when Git would merge cleanly", async () => {
    const f = await fixture("old\0data");
    const changed = await f.change("new\0data");
    const result = await binaryConflict(f, changed, changed);
    expect(result.conflicts.files[0]?.stages.map((entry) => entry.stage)).toEqual([1, 2, 3]);
  });

  it("forces non-overlapping edits of a large text file to BINARY", async () => {
    const middle = "a".repeat(5 * 1024 * 1024) + "\n";
    const f = await fixture("first\n" + middle + "last\n");
    await binaryConflict(
      f,
      await f.change("head\n" + middle + "last\n"),
      await f.change("first\n" + middle + "candidate\n"),
    );
  });

  it("allows one-sided binary edits and fast-forwards", async () => {
    const f = await fixture("old\0data");
    const changed = await f.change("new\0data");
    const unchanged = await f.change("old\0data");
    for (const [head, candidate] of [
      [f.base, changed],
      [changed, unchanged],
      [unchanged, changed],
    ]) {
      const result = await merge(f.repo, f.base, head!, candidate!);
      expect(result.clean).toBe(true);
      expect((await git(["show", `${result.tree}:file`], f.options)).stdout).toBe("new\0data");
    }
  });

  it("classifies concurrent binary add/add and modify/delete", async () => {
    const f = await fixture("old\0data");
    await binaryConflict(f, f.base, f.base, f.empty);
    const deleted = await materialize(f.repo, f.base, [{ type: "delete", path: "file" }]);
    await binaryConflict(f, deleted, await f.change("new\0data"));
  });

  it.each<Operation>([
    { type: "create", path: "large", content: "é".repeat(13 * 1024 * 1024) },
    { type: "modify", path: "file", content: "x".repeat(25 * 1024 * 1024 + 1) },
    { type: "rename", from: "file", to: "large", content: "x".repeat(25 * 1024 * 1024 + 1) },
  ])("rejects oversized UTF-8 submitted content for $type", async (operation) => {
    const f = await fixture("old\n");
    await expect(materialize(f.repo, f.base, [operation])).rejects.toMatchObject({
      code: "VALIDATION",
      details: { reason: "file_too_large" },
    });
  });

  it("rejects a patch whose resulting blob crosses the size limit", async () => {
    const content = "x".repeat(25 * 1024 * 1024 - 7) + "\nlast\n";
    const f = await fixture(content);
    const patch = "--- a/file\n+++ b/file\n@@ -2 +2,2 @@\n last\n+more\n";
    await expect(
      materialize(f.repo, f.base, [{ type: "modify", path: "file", patch }]),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      details: { path: "file", reason: "file_too_large" },
    });
  });

  it("uses strict size and first-8-KiB binary boundaries", async () => {
    const f = await fixture("small");
    for (const [content, binary] of [
      [Buffer.alloc(BINARY_SIZE, 120), false],
      [Buffer.alloc(BINARY_SIZE + 1, 120), true],
      [Buffer.concat([Buffer.alloc(8191, 120), Buffer.from([0])]), true],
      [Buffer.concat([Buffer.alloc(8192, 120), Buffer.from([0])]), false],
    ] as const) {
      const oid = (
        await git(["hash-object", "-w", "--stdin"], { ...f.options, input: content })
      ).stdout.trim();
      expect((await readMergeBlob(f.repo, oid)).binary).toBe(binary);
    }
  });

  it("retains native text conflicts alongside a forced binary conflict", async () => {
    const f = await fixture("old\0data");
    const base = await materialize(f.repo, f.base, [
      { type: "create", path: "text", content: "old\n" },
    ]);
    const branch = (content: string) =>
      materialize(f.repo, base, [
        { type: "modify", path: "file", content: "identical\0data" },
        { type: "modify", path: "text", content },
      ]);
    const result = await merge(f.repo, base, await branch("head\n"), await branch("candidate\n"));
    if (result.clean) throw new Error("Expected conflicts");
    const classified = await classifyConflicts(f.repo, result);
    expect(classified).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "file", kind: "BINARY" }),
        expect.objectContaining({ path: "text", kind: "CONTENT" }),
      ]),
    );
  });

  it("preserves untouched oversized imported files", async () => {
    const f = await fixture("old");
    const oid = (
      await git(["hash-object", "-w", "--stdin"], {
        ...f.options,
        input: Buffer.alloc(25 * 1024 * 1024 + 1, 120),
      })
    ).stdout.trim();
    const tree = (
      await git(["mktree", "-z"], { ...f.options, input: `100644 blob ${oid}\tfile\0` })
    ).stdout.trim();
    const imported = (
      await git(["commit-tree", tree, "-p", f.base], {
        ...f.options,
        input: "Import\n",
        env: {
          GIT_AUTHOR_NAME: "Test",
          GIT_AUTHOR_EMAIL: "test@example.test",
          GIT_COMMITTER_NAME: "Test",
          GIT_COMMITTER_EMAIL: "test@example.test",
        },
      })
    ).stdout.trim();
    const commit = await materialize(f.repo, imported, [
      { type: "create", path: "small", content: "x" },
    ]);
    expect((await git(["rev-parse", `${commit}:file`], f.options)).stdout.trim()).toBe(oid);
    await expect(
      materialize(f.repo, imported, [{ type: "rename", from: "file", to: "moved" }]),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      details: { path: "moved", reason: "file_too_large" },
    });
  });
});
