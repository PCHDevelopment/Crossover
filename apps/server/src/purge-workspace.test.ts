import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { purgeRoomWorkspace } from "./purge-workspace.js";

it("fails purge when Zoekt shard removal fails, leaving the repository for retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "zoekt-purge-test-"));
  const repoPath = join(root, "room_A.git");
  await mkdir(repoPath);
  const removeSearchIndex = vi.fn(async () => {
    throw new Error("shard directory unavailable");
  });
  try {
    await expect(
      purgeRoomWorkspace({
        workspaceRoot: root,
        roomId: "room_A",
        repoPath,
        destroyRoom: async () => {},
        removeSearchIndex,
      }),
    ).rejects.toThrow("shard directory unavailable");
    expect(removeSearchIndex).toHaveBeenCalledWith("room_A");
    expect((await stat(repoPath)).isDirectory()).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
