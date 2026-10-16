import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { attribution } from "./attribution.js";
import { git } from "./git.js";
import { materialize } from "./materialize.js";
import { initRoomRepo } from "./repo.js";

// Measured (T1529): idle n/a, 3x load 2033 ms; budget 7x.
it("attributes ranges across edits and renames at explicit commits, including unusual paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "crossover-attribution-"));
  try {
    const repo = await initRoomRepo(root, "room_test");
    const options = { gitDir: repo, timeoutMs: 10_000 };
    const initial = (await git(["rev-parse", "refs/room/canonical"], options)).stdout.trim();
    const first = await materialize(repo, initial, [
      { type: "create", path: "file[1]\n", content: "first\nsecond\nthird" },
      { type: "create", path: "empty", content: "" },
    ]);
    const second = await materialize(repo, first, [
      { type: "modify", path: "file[1]\n", content: "first\nchanged\nthird" },
    ]);
    const renamed = await materialize(repo, second, [
      { type: "rename", from: "file[1]\n", to: "renamed" },
    ]);
    expect(await attribution(repo, first, "file[1]\n")).toEqual([
      { commit: first, start: 1, count: 3 },
    ]);
    const ranges = await attribution(repo, renamed, "renamed");
    const lines = ranges
      .flatMap((range) =>
        Array.from({ length: range.count }, (_, index) => ({
          line: range.start + index,
          commit: range.commit,
        })),
      )
      .sort((a, b) => a.line - b.line);
    expect(lines).toEqual([
      { line: 1, commit: first },
      { line: 2, commit: second },
      { line: 3, commit: first },
    ]);
    expect(await attribution(repo, first, "empty")).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
