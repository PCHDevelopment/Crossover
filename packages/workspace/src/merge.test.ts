import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as gitModule from "./git.js";
import { git, GitError } from "./git.js";
import { materialize } from "./materialize.js";
import { merge } from "./merge.js";
import { initRoomRepo } from "./repo.js";

const dirs: string[] = [];
async function fixture(path = "file.txt") {
  const root = await mkdtemp(join(tmpdir(), "crossover-merge-"));
  dirs.push(root);
  const repo = await initRoomRepo(root, "room_test");
  const options = { gitDir: repo, timeoutMs: 5000 };
  const canonical = (await git(["rev-parse", "refs/room/canonical"], options)).stdout.trim();
  const base = await materialize(repo, canonical, [
    { type: "create", path, content: "one\ntwo\nthree\nfour\nfive\n" },
  ]);
  const edit = (content: string, parent = base) =>
    materialize(repo, parent, [{ type: "modify", path, content }]);
  return { repo, options, canonical, base, edit, path };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("merge", () => {
  it("fast-forwards to the candidate tree without invoking merge-tree", async () => {
    const f = await fixture();
    const candidate = await f.edit("candidate\n");
    const spy = vi.spyOn(gitModule, "git");
    const result = await merge(f.repo, f.base, f.base, candidate);
    expect(result).toEqual({
      clean: true,
      tree: (await git(["rev-parse", `${candidate}^{tree}`], f.options)).stdout.trim(),
    });
    expect(spy.mock.calls.some(([args]) => args[0] === "merge-tree")).toBe(false);
  });

  it("merges non-overlapping edits to one file without changing canonical or the index", async () => {
    const f = await fixture();
    const head = await f.edit("HEAD\ntwo\nthree\nfour\nfive\n");
    const candidate = await f.edit("one\ntwo\nthree\nfour\nCANDIDATE\n");
    const result = await merge(f.repo, f.base, head, candidate);
    expect(result.clean).toBe(true);
    expect((await git(["show", `${result.tree}:${f.path}`], f.options)).stdout).toBe(
      "HEAD\ntwo\nthree\nfour\nCANDIDATE\n",
    );
    expect((await git(["rev-parse", "refs/room/canonical"], f.options)).stdout.trim()).toBe(
      f.canonical,
    );
    expect(await readdir(f.repo)).not.toContain("index");
  });

  it.each(["file.txt", "tab\tname", "line\nname", "café.txt"])(
    "preserves stages and messages for same-line conflicts in %s",
    async (path) => {
      const f = await fixture(path);
      const head = await f.edit("HEAD\ntwo\nthree\nfour\nfive\n");
      const candidate = await f.edit("CANDIDATE\ntwo\nthree\nfour\nfive\n");
      const result = await merge(f.repo, f.base, head, candidate);
      expect(result.clean).toBe(false);
      if (result.clean) throw new Error("Expected a conflict");
      const expectedOids = await Promise.all(
        [f.base, head, candidate].map(async (commit) =>
          (await git(["rev-parse", `${commit}:${path}`], f.options)).stdout.trim(),
        ),
      );
      expect(result.conflicts.files).toEqual([
        {
          path,
          stages: expectedOids.map((oid, index) => ({ mode: "100644", oid, stage: index + 1 })),
        },
      ]);
      expect(result.conflicts.messages).toContainEqual({
        paths: [path],
        type: "CONFLICT (contents)",
        message: expect.any(String),
      });
      expect((await git(["show", `${result.tree}:${path}`], f.options)).stdout).toContain(
        "<<<<<<<",
      );
      expect((await git(["rev-parse", "refs/room/canonical"], f.options)).stdout.trim()).toBe(
        f.canonical,
      );
    },
  );

  it("uses the supplied base even when the commits have a newer common ancestor", async () => {
    const f = await fixture();
    const shared = await f.edit("shared\ntwo\nthree\nfour\nfive\n");
    const head = await f.edit("head\ntwo\nthree\nfour\nfive\n", shared);
    // Against shared this is unchanged; against the explicit old base both sides edited line 1.
    const result = await merge(f.repo, f.base, head, shared);
    expect(result.clean).toBe(false);
  });

  it("preserves modify/delete conflict stages and messages", async () => {
    const f = await fixture();
    const head = await materialize(f.repo, f.base, [{ type: "delete", path: f.path }]);
    const candidate = await f.edit("candidate\n");
    const result = await merge(f.repo, f.base, head, candidate);
    if (result.clean) throw new Error("Expected a conflict");
    expect(result.conflicts.files[0]?.stages.map((entry) => entry.stage)).toEqual([1, 3]);
    expect(
      result.conflicts.messages.some((entry) => entry.type === "CONFLICT (modify/delete)"),
    ).toBe(true);
  });

  it("throws GitError for invalid revisions rather than reporting a conflict", async () => {
    const f = await fixture();
    await expect(merge(f.repo, f.base, "--bad-option", f.base)).rejects.toBeInstanceOf(GitError);
  });

  it("keeps exit-1 conflicts with no stage entries and propagates other engine failures", async () => {
    const f = await fixture();
    const head = await f.edit("head\n");
    const realGit = gitModule.git;
    const spy = vi.spyOn(gitModule, "git").mockImplementation(async (args, options) => {
      if (args[0] === "merge-tree")
        throw new GitError(
          "conflict",
          1,
          "",
          false,
          null,
          undefined,
          `${f.base}\0\0` + "1\0directory\0CONFLICT (directory rename)\0details\0",
        );
      return realGit(args, options);
    });
    const result = await merge(f.repo, f.base, head, f.base);
    expect(result).toMatchObject({
      clean: false,
      conflicts: {
        files: [],
        messages: [
          { paths: ["directory"], type: "CONFLICT (directory rename)", message: "details" },
        ],
      },
    });
    spy.mockImplementation(async (args, options) => {
      if (args[0] === "merge-tree") throw new GitError("engine failed", 128, "fatal");
      return realGit(args, options);
    });
    await expect(merge(f.repo, f.base, head, f.base)).rejects.toMatchObject({
      exitCode: 128,
      stderr: "fatal",
    });
  });
});
