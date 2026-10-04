import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "./git.js";
import { initRoomRepo } from "./repo.js";

const dirs: string[] = [];
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "crossover-init-"));
  dirs.push(dir);
  return join(dir, "workspaces");
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("initRoomRepo", () => {
  it("creates a bare repository with an empty root commit and preserves it on repeat", async () => {
    const root = await fixture();
    const repo = await initRoomRepo(root, "room_test");
    expect(repo).toBe(join(root, "room_test.git"));
    const options = { gitDir: repo, timeoutMs: 5000 };
    expect((await git(["rev-parse", "--is-bare-repository"], options)).stdout.trim()).toBe("true");
    const first = (await git(["rev-parse", "refs/room/canonical"], options)).stdout.trim();
    expect((await git(["ls-tree", "-r", first], options)).stdout).toBe("");
    expect((await git(["rev-list", "--parents", first], options)).stdout.trim()).toBe(first);
    expect(await initRoomRepo(root, "room_test")).toBe(repo);
    expect((await git(["rev-parse", "refs/room/canonical"], options)).stdout.trim()).toBe(first);
  });

  it("does not overwrite a canonical head that has advanced", async () => {
    const root = await fixture();
    const repo = await initRoomRepo(root, "room_test");
    const options = { gitDir: repo, timeoutMs: 5000 };
    const first = (await git(["rev-parse", "refs/room/canonical"], options)).stdout.trim();
    const tree = (await git(["rev-parse", `${first}^{tree}`], options)).stdout.trim();
    const next = (
      await git(["commit-tree", tree, "-p", first], {
        ...options,
        input: "Advance head\n",
        env: {
          GIT_AUTHOR_NAME: "Test",
          GIT_AUTHOR_EMAIL: "test@example.com",
          GIT_COMMITTER_NAME: "Test",
          GIT_COMMITTER_EMAIL: "test@example.com",
        },
      })
    ).stdout.trim();
    await git(["update-ref", "refs/room/canonical", next], options);
    await initRoomRepo(root, "room_test");
    expect((await git(["rev-parse", "refs/room/canonical"], options)).stdout.trim()).toBe(next);
  });

  it("keeps room repositories separate", async () => {
    const root = await fixture();
    const first = await initRoomRepo(root, "room_one");
    const second = await initRoomRepo(root, "room_two");
    expect(first).not.toBe(second);
    expect(
      (
        await git(["rev-parse", "refs/room/canonical"], {
          gitDir: second,
          timeoutMs: 5000,
        })
      ).stdout.trim(),
    ).toMatch(/^[a-f0-9]{40,64}$/);
  });

  it.each(["", "../escape", "/absolute", "room/name", "room\\name", "room\0name"])(
    "rejects unsafe room identifier %j",
    async (roomId) => {
      await expect(initRoomRepo(await fixture(), roomId)).rejects.toThrow(TypeError);
    },
  );
});
