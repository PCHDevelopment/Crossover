import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { git } from "./git.js";
import { initRoomRepo } from "./repo.js";
import { buildSearchFixture } from "./search-bench-fixture.js";

describe("search benchmark fixture", () => {
  it("the bench fixture is deterministic and plants exactly 3 files per rare token", async () => {
    const root = await mkdtemp(join(tmpdir(), "search-bench-fixture-"));
    try {
      const build = async (room: string) => {
        const repo = await initRoomRepo(root, room);
        const parent = (
          await git(["rev-parse", "refs/room/canonical"], { gitDir: repo, timeoutMs: 10_000 })
        ).stdout.trim();
        const fixture = await buildSearchFixture({ repo, parent, files: 500, bigBytes: 16_384 });
        return { repo, fixture };
      };
      const first = await build("room_A");
      const second = await build("room_B");
      expect(first.fixture.tree).toBe(second.fixture.tree);
      expect(first.fixture.paths).toEqual(second.fixture.paths);
      expect(first.fixture.paths).toHaveLength(500);

      for (let token = 0; token < 10; token++) {
        const { stdout } = await git(
          ["grep", "-l", "-F", `rare_token_${token};`, first.fixture.commit],
          { gitDir: first.repo, timeoutMs: 10_000 },
        );
        expect(stdout.trim().split("\n"), `rare_token_${token}`).toHaveLength(3);
      }
      const docs = first.fixture.paths.filter((path) => path.startsWith("docs/"));
      expect(docs).toHaveLength(25);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
