import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyConflicts } from "./conflicts.js";
import { git } from "./git.js";
import { materialize } from "./materialize.js";
import { merge } from "./merge.js";
import type { Operation } from "./operations.js";
import { initRoomRepo } from "./repo.js";

const dirs: string[] = [];
async function fixture(content = "one\ntwo\nthree\nfour\nfive\n") {
  const root = await mkdtemp(join(tmpdir(), "crossover-classify-"));
  dirs.push(root);
  vi.stubEnv("TMPDIR", root);
  const repo = await initRoomRepo(root, "room_test");
  const options = { gitDir: repo, timeoutMs: 5000 };
  const empty = (await git(["rev-parse", "refs/room/canonical"], options)).stdout.trim();
  const base = await materialize(repo, empty, [{ type: "create", path: "file", content }]);
  const change = (operations: Operation[], parent = base) => materialize(repo, parent, operations);
  const classify = async (head: string, candidate: string, parent = base) => {
    const result = await merge(repo, parent, head, candidate);
    if (result.clean) throw new Error("Fixture must conflict");
    return classifyConflicts(repo, result);
  };
  return { root, repo, base, empty, options, change, classify };
}
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("classifyConflicts", () => {
  it("extracts CONTENT with candidate as ours and head as theirs", async () => {
    const f = await fixture();
    const head = await f.change([
      { type: "modify", path: "file", content: "one\nTHEIRS\nthree\nfour\nfive\n" },
    ]);
    const candidate = await f.change([
      { type: "modify", path: "file", content: "one\nOURS\nthree\nfour\nfive\n" },
    ]);
    const [file] = await f.classify(head, candidate);
    expect(file).toMatchObject({
      path: "file",
      kind: "CONTENT",
      hunks: [
        {
          base: "two\n",
          ours: "OURS\n",
          theirs: "THEIRS\n",
          baseRange: { start: 2, end: 3 },
          oursRange: { start: 2, end: 3 },
          theirsRange: { start: 2, end: 3 },
        },
      ],
    });
    expect((await readdir(f.root)).filter((name) => name.startsWith("crossover-hunks-"))).toEqual(
      [],
    );
    expect((await git(["rev-parse", "refs/room/canonical"], f.options)).stdout.trim()).toBe(
      f.empty,
    );
  });

  it("classifies MODIFY_DELETE and retains unfamiliar messages using stage fallback", async () => {
    const f = await fixture();
    const head = await f.change([{ type: "delete", path: "file" }]);
    const candidate = await f.change([{ type: "modify", path: "file", content: "candidate\n" }]);
    const result = await merge(f.repo, f.base, head, candidate);
    if (result.clean) throw new Error("Fixture must conflict");
    expect(await classifyConflicts(f.repo, result)).toMatchObject([
      { kind: "MODIFY_DELETE", hunks: [] },
    ]);
    const message = { paths: ["file"], type: "CONFLICT (future kind)", message: "raw diagnostic" };
    result.conflicts.messages = [message];
    expect(await classifyConflicts(f.repo, result)).toMatchObject([
      { kind: "MODIFY_DELETE", messages: [message] },
    ]);
  });

  it("classifies ADD_ADD with no base stage", async () => {
    const f = await fixture();
    const head = await f.change([{ type: "create", path: "new", content: "head\n" }], f.empty);
    const candidate = await f.change(
      [{ type: "create", path: "new", content: "candidate\n" }],
      f.empty,
    );
    expect(await f.classify(head, candidate, f.empty)).toMatchObject([
      { path: "new", kind: "ADD_ADD", hunks: [] },
    ]);
  });

  it("classifies all related RENAME paths", async () => {
    const f = await fixture();
    const head = await f.change([{ type: "rename", from: "file", to: "head-name" }]);
    const candidate = await f.change([{ type: "rename", from: "file", to: "candidate-name" }]);
    const files = await f.classify(head, candidate);
    expect(files.map((file) => file.path).sort()).toEqual(["candidate-name", "file", "head-name"]);
    expect(files.every((file) => file.kind === "RENAME" && file.hunks.length === 0)).toBe(true);
  });

  it("classifies BINARY from Git or NUL in any side", async () => {
    const f = await fixture("a\0b");
    const head = await f.change([{ type: "modify", path: "file", content: "h\0b" }]);
    const candidate = await f.change([{ type: "modify", path: "file", content: "c\0b" }]);
    const result = await merge(f.repo, f.base, head, candidate);
    if (result.clean) throw new Error("Fixture must conflict");
    expect(await classifyConflicts(f.repo, result)).toMatchObject([{ kind: "BINARY", hunks: [] }]);
    result.conflicts.messages = [];
    expect(await classifyConflicts(f.repo, result)).toMatchObject([{ kind: "BINARY", hunks: [] }]);
  });

  it("maps original line ranges across clean insertions before a conflict", async () => {
    const f = await fixture();
    const head = await f.change([
      { type: "modify", path: "file", content: "one\ntwo\nthree\nHEAD\nfive\n" },
    ]);
    const candidate = await f.change([
      { type: "modify", path: "file", content: "inserted\none\ntwo\nthree\nCANDIDATE\nfive\n" },
    ]);
    const [file] = await f.classify(head, candidate);
    expect(file?.hunks).toEqual([
      {
        base: "four\n",
        ours: "CANDIDATE\n",
        theirs: "HEAD\n",
        baseRange: { start: 4, end: 5 },
        oursRange: { start: 5, end: 6 },
        theirsRange: { start: 4, end: 5 },
      },
    ]);
  });

  it("preserves missing final newlines and source marker text", async () => {
    const f = await fixture("<<<<<<< literal\n||||||| literal\n=======\n>>>>>>> literal\nbase");
    const prefix = "<<<<<<< literal\n||||||| literal\n=======\n>>>>>>> literal\n";
    const head = await f.change([{ type: "modify", path: "file", content: prefix + "head" }]);
    const candidate = await f.change([
      { type: "modify", path: "file", content: prefix + "candidate" },
    ]);
    const [file] = await f.classify(head, candidate);
    expect(file?.hunks).toEqual([
      {
        base: "base",
        ours: "candidate",
        theirs: "head",
        baseRange: { start: 5, end: 6 },
        oursRange: { start: 5, end: 6 },
        theirsRange: { start: 5, end: 6 },
      },
    ]);
  });

  it("uses an empty half-open range when the candidate deletes conflicted lines", async () => {
    const f = await fixture("one\ntwo\nthree\n");
    const head = await f.change([{ type: "modify", path: "file", content: "one\nHEAD\nthree\n" }]);
    const candidate = await f.change([{ type: "modify", path: "file", content: "one\nthree\n" }]);
    const [file] = await f.classify(head, candidate);
    expect(file?.hunks).toMatchObject([
      { base: "two\n", ours: "", theirs: "HEAD\n", oursRange: { start: 2, end: 2 } },
    ]);
  });
});
