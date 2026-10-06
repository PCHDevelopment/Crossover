import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyConflicts } from "./conflicts.js";
import { git } from "./git.js";
import { materialize } from "./materialize.js";
import { merge } from "./merge.js";
import { initRoomRepo } from "./repo.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("adjacent-hunk rule (§10.4)", () => {
  it.each([
    { later: 11, reverse: false, clean: false },
    { later: 11, reverse: true, clean: false },
    { later: 12, reverse: false, clean: true },
    { later: 12, reverse: true, clean: true },
  ])("lines 10/$later, reverse=$reverse: clean=$clean", async ({ later, reverse, clean }) => {
    const root = await mkdtemp(join(tmpdir(), "crossover-adjacent-"));
    dirs.push(root);
    const repo = await initRoomRepo(root, "room_test");
    const options = { gitDir: repo, timeoutMs: 5000 };
    const canonical = (await git(["rev-parse", "refs/room/canonical"], options)).stdout.trim();
    const original = Array.from({ length: 22 }, (_, index) => `line ${index + 1}\n`);
    const base = await materialize(repo, canonical, [
      { type: "create", path: "file", content: original.join("") },
    ]);
    const edit = async (line: number, replacement: string) => {
      const content = [...original];
      content[line - 1] = replacement + "\n";
      return materialize(repo, base, [{ type: "modify", path: "file", content: content.join("") }]);
    };
    const earlier = await edit(10, "earlier edit");
    const laterCommit = await edit(later, "later edit");
    const head = reverse ? laterCommit : earlier;
    const candidate = reverse ? earlier : laterCommit;
    const result = await merge(repo, base, head, candidate);
    expect(result.clean).toBe(clean);
    if (result.clean) {
      const expected = [...original];
      expected[9] = "earlier edit\n";
      expected[later - 1] = "later edit\n";
      expect((await git(["show", `${result.tree}:file`], options)).stdout).toBe(expected.join(""));
    } else {
      const [file] = await classifyConflicts(repo, result);
      expect(file).toMatchObject({
        path: "file",
        kind: "CONTENT",
        hunks: [{ base: "line 10\nline 11\n", baseRange: { start: 10, end: 12 } }],
      });
      expect(file?.hunks[0]?.ours).toBe(
        reverse ? "earlier edit\nline 11\n" : "line 10\nlater edit\n",
      );
      expect(file?.hunks[0]?.theirs).toBe(
        reverse ? "line 10\nlater edit\n" : "earlier edit\nline 11\n",
      );
    }
    expect((await git(["rev-parse", "refs/room/canonical"], options)).stdout.trim()).toBe(
      canonical,
    );
  });
});
