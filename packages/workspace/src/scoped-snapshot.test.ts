import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "./git.js";
import { initRoomRepo } from "./repo.js";
import {
  createScopedSnapshotRepository,
  createUnscopedSnapshotRepository,
} from "./scoped-snapshot.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "crossover-scoped-snapshot-test-"));
  roots.push(root);
  const referenceRepository = await initRoomRepo(root, "room_scope-test");
  const { stdout: publicBlob } = await git(["hash-object", "-w", "--stdin"], {
    gitDir: referenceRepository,
    timeoutMs: 10_000,
    input: "visible content",
  });
  const { stdout: secretBlob } = await git(["hash-object", "-w", "--stdin"], {
    gitDir: referenceRepository,
    timeoutMs: 10_000,
    input: "private content",
  });
  const { stdout: nestedTree } = await git(["mktree"], {
    gitDir: referenceRepository,
    timeoutMs: 10_000,
    input: `100644 blob ${publicBlob.trim()}\tpublic.txt\n100644 blob ${secretBlob.trim()}\tsecret.txt\n`,
  });
  const { stdout: tree } = await git(["mktree"], {
    gitDir: referenceRepository,
    timeoutMs: 10_000,
    input: `040000 tree ${nestedTree.trim()}\tsrc\n`,
  });
  const { stdout: commit } = await git(["commit-tree", tree.trim(), "-m", "canonical"], {
    gitDir: referenceRepository,
    timeoutMs: 10_000,
    input: "",
  });
  return {
    referenceRepository,
    canonicalCommit: commit.trim(),
    publicBlob: publicBlob.trim(),
    secretBlob: secretBlob.trim(),
  };
}

describe("createScopedSnapshotRepository", () => {
  it("advertises only readable paths and their blobs", async () => {
    const source = await fixture();
    const scoped = await createScopedSnapshotRepository({
      ...source,
      revision: 17,
      canonicalTimestamp: 1_700_000_000,
      canRead: async (path) => path === "src/public.txt",
    });
    roots.push(scoped.repo_path.slice(0, scoped.repo_path.lastIndexOf("/")));

    const { stdout: reachable } = await git(["rev-list", "--objects", "refs/heads/main"], {
      gitDir: scoped.repo_path,
      timeoutMs: 10_000,
      env: { GIT_ALTERNATE_OBJECT_DIRECTORIES: join(source.referenceRepository, "objects") },
    });
    const { stdout: entries } = await git(["ls-tree", "-r", "--name-only", "main"], {
      gitDir: scoped.repo_path,
      timeoutMs: 10_000,
      env: { GIT_ALTERNATE_OBJECT_DIRECTORIES: join(source.referenceRepository, "objects") },
    });

    expect(entries.trim().split("\n")).toEqual(["src/public.txt"]);
    expect(reachable).toContain(source.publicBlob);
    expect(reachable).not.toContain(source.secretBlob);
    const { stdout: commitContent } = await git(["cat-file", "commit", scoped.commit], {
      gitDir: scoped.repo_path,
      timeoutMs: 10_000,
    });
    expect(commitContent).toContain(
      "author Crossover <sandbox@crossover.invalid> 1700000000 +0000",
    );
    expect(commitContent).toContain(
      `x-crossover-workspace-revision 17\nx-crossover-scope-sha256 ${scoped.scope_hash}`,
    );
    expect(commitContent).toContain("\n\nCrossover sandbox snapshot\n");
    expect(commitContent).not.toContain("parent ");
    expect(commitContent).not.toContain("canonical");
    await expect(
      git(["cat-file", "blob", source.secretBlob], {
        gitDir: scoped.repo_path,
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow();
  });

  it("creates a deterministic empty snapshot when no path is readable", async () => {
    const source = await fixture();
    const [first, second] = await Promise.all([
      createScopedSnapshotRepository({
        ...source,
        revision: 17,
        canonicalTimestamp: 1_700_000_000,
        canRead: async () => false,
      }),
      createScopedSnapshotRepository({
        ...source,
        revision: 17,
        canonicalTimestamp: 1_700_000_000,
        canRead: async () => false,
      }),
    ]);
    roots.push(first.repo_path.slice(0, first.repo_path.lastIndexOf("/")));
    roots.push(second.repo_path.slice(0, second.repo_path.lastIndexOf("/")));

    expect(first.commit).toBe(second.commit);
    const { stdout } = await git(["ls-tree", "-r", "--name-only", "main"], {
      gitDir: first.repo_path,
      timeoutMs: 10_000,
      env: { GIT_ALTERNATE_OBJECT_DIRECTORIES: join(source.referenceRepository, "objects") },
    });
    expect(stdout).toBe("");
  });

  it("keeps the real canonical commit for an unscoped reader", async () => {
    const source = await fixture();
    const view = await createUnscopedSnapshotRepository(source);
    roots.push(view.repo_path.slice(0, view.repo_path.lastIndexOf("/")));

    expect(view.commit).toBe(source.canonicalCommit);
    expect(view.scope_hash).toBe("unscoped");
    const { stdout } = await git(["rev-parse", "refs/heads/main"], {
      gitDir: view.repo_path,
      timeoutMs: 10_000,
      env: { GIT_ALTERNATE_OBJECT_DIRECTORIES: join(source.referenceRepository, "objects") },
    });
    expect(stdout.trim()).toBe(source.canonicalCommit);
  });
});
