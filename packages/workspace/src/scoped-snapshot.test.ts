import { mkdtemp, mkdir, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { git } from "./git.js";
import { initRoomRepo } from "./repo.js";
import {
  createScopedSnapshotRepository,
  createUnscopedSnapshotRepository,
  sweepSnapshotRepositories,
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
    env: {
      GIT_AUTHOR_NAME: "Crossover test",
      GIT_AUTHOR_EMAIL: "test@crossover.invalid",
      GIT_COMMITTER_NAME: "Crossover test",
      GIT_COMMITTER_EMAIL: "test@crossover.invalid",
    },
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
    });
    const { stdout: entries } = await git(["ls-tree", "-r", "--name-only", "main"], {
      gitDir: scoped.repo_path,
      timeoutMs: 10_000,
    });

    expect(entries.trim().split("\n")).toEqual(["src/public.txt"]);
    expect(reachable).toContain(source.publicBlob);
    expect(reachable).not.toContain(source.secretBlob);
    await expect(
      git(["cat-file", "blob", source.publicBlob], {
        gitDir: scoped.repo_path,
        timeoutMs: 10_000,
      }),
    ).resolves.toMatchObject({ stdout: "visible content" });
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
    await expect(
      git(["rev-list", "--objects", source.canonicalCommit], {
        gitDir: scoped.repo_path,
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow();
  });

  it("creates the same nonempty snapshot for the same canonical revision and scope", async () => {
    const source = await fixture();
    const [first, second] = await Promise.all([
      createScopedSnapshotRepository({
        ...source,
        revision: 17,
        canonicalTimestamp: 1_700_000_000,
        canRead: async (path) => path === "src/public.txt",
      }),
      createScopedSnapshotRepository({
        ...source,
        revision: 17,
        canonicalTimestamp: 1_700_000_000,
        canRead: async (path) => path === "src/public.txt",
      }),
    ]);
    roots.push(first.repo_path.slice(0, first.repo_path.lastIndexOf("/")));
    roots.push(second.repo_path.slice(0, second.repo_path.lastIndexOf("/")));

    expect(first.commit).toBe(second.commit);
    const { stdout } = await git(["ls-tree", "-r", "--name-only", "main"], {
      gitDir: first.repo_path,
      timeoutMs: 10_000,
    });
    expect(stdout.trim()).toBe("src/public.txt");
  });

  it("keeps the real canonical commit for an unscoped reader", async () => {
    const source = await fixture();
    const view = await createUnscopedSnapshotRepository(source);
    roots.push(view.repo_path.slice(0, view.repo_path.lastIndexOf("/")));

    expect(view.commit).toBe(source.canonicalCommit);
    expect(view.scope_hash).toBe("unscoped");
    expect(view.reference_repository).toBeUndefined();
    const { stdout } = await git(["rev-parse", "refs/heads/main"], {
      gitDir: view.repo_path,
      timeoutMs: 10_000,
    });
    expect(stdout.trim()).toBe(source.canonicalCommit);
    expect(
      (
        await git(["cat-file", "blob", source.secretBlob], {
          gitDir: view.repo_path,
          timeoutMs: 10_000,
        })
      ).stdout,
    ).toBe("private content");
  });

  it("skips packs for an advertisement but packs negotiation snapshots", async () => {
    const source = await fixture();
    for (const advertisementOnly of [true, false]) {
      const view = await createScopedSnapshotRepository({
        ...source,
        revision: 1,
        canonicalTimestamp: 1_700_000_000,
        canRead: async () => true,
        advertisementOnly,
      });
      try {
        const packs = await readdir(join(view.repo_path, "objects", "pack"));
        expect(packs.some((name) => name.endsWith(".pack"))).toBe(!advertisementOnly);
        await expect(
          git(["upload-pack", "--stateless-rpc", "--advertise-refs", view.repo_path], {
            timeoutMs: 10_000,
          }),
        ).resolves.toMatchObject({ stdout: expect.stringContaining(view.commit) });
      } finally {
        await view.dispose();
      }
    }
  });

  it("sweeps only old snapshot directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "crossover-sweep-test-"));
    roots.push(root);
    const now = Date.now();
    for (const name of ["crossover-sandbox-git-old", "crossover-sandbox-git-active", "unrelated"]) {
      await mkdir(join(root, name));
    }
    const old = new Date(now - 25 * 60 * 60 * 1000);
    await utimes(join(root, "crossover-sandbox-git-old"), old, old);
    await utimes(join(root, "unrelated"), old, old);
    await sweepSnapshotRepositories(root, now);
    expect((await readdir(root)).sort()).toEqual(["crossover-sandbox-git-active", "unrelated"]);
  });

  it("reports an undeletable snapshot and continues the startup sweep", async () => {
    const root = await mkdtemp(join(tmpdir(), "crossover-sweep-denied-test-"));
    roots.push(root);
    const now = Date.now();
    const blocked = join(root, "crossover-sandbox-git-blocked");
    const next = join(root, "crossover-sandbox-git-next");
    await mkdir(blocked);
    await mkdir(next);
    const old = new Date(now - 25 * 60 * 60 * 1000);
    await utimes(blocked, old, old);
    await utimes(next, old, old);
    const failure = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const onError = vi.fn();
    const removeDirectory = vi.fn(async (directory: string) => {
      if (directory === blocked) throw failure;
      await rm(directory, { recursive: true, force: true });
    });

    await expect(
      sweepSnapshotRepositories(root, now, onError, removeDirectory),
    ).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalledWith(failure);
    expect(removeDirectory).toHaveBeenCalledTimes(2);
    expect(await readdir(root)).toEqual(["crossover-sandbox-git-blocked"]);
  });

  it("reports an unreadable snapshot root without rejecting startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "crossover-sweep-missing-test-"));
    roots.push(root);
    const onError = vi.fn();

    await expect(
      sweepSnapshotRepositories(join(root, "missing"), Date.now(), onError),
    ).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalledOnce();
  });
});
