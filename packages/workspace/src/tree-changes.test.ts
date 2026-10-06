import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { git } from "./git.js";
import { initRoomRepo } from "./repo.js";
import { materialize } from "./materialize.js";
import { treeChanges } from "./tree-changes.js";

it("records rename deletions/creations and preserves NUL-delimited paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "crossover-tree-changes-"));
  try {
    const repo = await initRoomRepo(root, "room_test");
    const options = { gitDir: repo, timeoutMs: 10_000 };
    const empty = (await git(["rev-parse", "refs/room/canonical"], options)).stdout.trim();
    const base = await materialize(repo, empty, [
      { type: "create", path: "original", content: "same" },
      { type: "create", path: "gone", content: "gone" },
      { type: "create", path: "untouched", content: "same" },
    ]);
    const next = await materialize(repo, base, [
      { type: "rename", from: "original", to: "line\nname" },
      { type: "delete", path: "gone" },
      { type: "create", path: "tab\tname", content: "new" },
    ]);
    const oid = async (path: string) =>
      (await git(["rev-parse", `${next}:${path}`], options)).stdout.trim();
    expect(await treeChanges(repo, base, next)).toEqual([
      { path: "gone", blob: null },
      { path: "line\nname", blob: await oid("line\nname") },
      { path: "original", blob: null },
      { path: "tab\tname", blob: await oid("tab\tname") },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
