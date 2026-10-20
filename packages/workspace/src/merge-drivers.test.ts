import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { git } from "./git.js";
import { materialize } from "./materialize.js";
import { merge } from "./merge.js";
import { resolveStructurally, type MergeDriver } from "./merge-drivers.js";
import { initRoomRepo } from "./repo.js";

const roots: string[] = [];
async function fixture(path = "file.txt", other?: string) {
  const root = await mkdtemp(join(tmpdir(), "crossover-driver-test-"));
  roots.push(root);
  const repo = await initRoomRepo(root, "room_test");
  const canonical = (
    await git(["rev-parse", "refs/room/canonical"], { gitDir: repo, timeoutMs: 5000 })
  ).stdout.trim();
  const paths = other ? [path, other] : [path];
  const base = await materialize(
    repo,
    canonical,
    paths.map((item) => ({ type: "create" as const, path: item, content: "one\ntwo\n" })),
  );
  const head = await materialize(
    repo,
    base,
    paths.map((item) => ({ type: "modify" as const, path: item, content: "HEAD\ntwo\n" })),
  );
  const candidate = await materialize(
    repo,
    base,
    paths.map((item) => ({ type: "modify" as const, path: item, content: "CANDIDATE\ntwo\n" })),
  );
  const original = await merge(repo, base, head, candidate);
  if (original.clean) throw new Error("Expected a content conflict");
  return { repo, canonical, base, head, candidate, original, path };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const driver = (mergeFn: MergeDriver["merge"]): MergeDriver => ({
  name: "fake",
  matches: () => true,
  merge: mergeFn,
});

describe("resolveStructurally", () => {
  it.each(["file.txt", "tab\tname", "line\nname"])(
    "writes a clean tree for %s without touching refs or the repository index",
    async (path) => {
      const f = await fixture(path);
      const before = await readdir(f.repo);
      const result = await resolveStructurally(f.repo, f.original, new Set(), [
        driver(async ({ base, head, candidate }) => {
          expect([base, head, candidate]).toEqual([
            "one\ntwo\n",
            "HEAD\ntwo\n",
            "CANDIDATE\ntwo\n",
          ]);
          return { ok: true, content: "resolved\n" };
        }),
      ]);
      expect(result).toMatchObject({ clean: true, structured: [{ path, driver: "fake" }] });
      expect(
        (await git(["show", `${result.tree}:${path}`], { gitDir: f.repo, timeoutMs: 5000 })).stdout,
      ).toBe("resolved\n");
      expect(
        (
          await git(["rev-parse", "refs/room/canonical"], { gitDir: f.repo, timeoutMs: 5000 })
        ).stdout.trim(),
      ).toBe(f.canonical);
      expect(await readdir(f.repo)).toEqual(before);
    },
  );

  it("preserves Git's original result when no driver matches", async () => {
    const f = await fixture();
    const result = await resolveStructurally(f.repo, f.original, new Set(), [
      {
        name: "skip",
        matches: () => false,
        merge: vi.fn(),
      },
    ]);
    expect(result).toEqual({
      ...f.original,
      structuredRefusals: [{ path: f.path, driver: null, reason: "no_driver" }],
    });
  });

  it("preserves Git's original result when a driver refuses", async () => {
    const f = await fixture();
    const result = await resolveStructurally(f.repo, f.original, new Set(), [
      driver(async () => ({ ok: false, reason: "same_key" })),
    ]);
    expect(result).toEqual({
      ...f.original,
      structuredRefusals: [{ path: f.path, driver: "fake", reason: "same_key" }],
    });
    expect((await readdir(f.repo)).some((name) => name.startsWith("crossover-merge-"))).toBe(false);
  });

  it("uses the resolver through merge() only for conflicted results", async () => {
    const f = await fixture();
    const result = await merge(f.repo, f.base, f.head, f.candidate, {
      drivers: [driver(async () => ({ ok: true, content: "integrated\n" }))],
    });
    expect(result).toMatchObject({ clean: true, structured: [{ path: f.path, driver: "fake" }] });
  });

  it("keeps both files conflicted when the second file has no driver", async () => {
    const f = await fixture("file.txt", "other.txt");
    const original = f.original;
    const called = vi.fn(async () => ({ ok: true as const, content: "resolved" }));
    const result = await resolveStructurally(f.repo, original, new Set(), [
      {
        name: "first",
        matches: (path) => path === f.path,
        merge: called,
      },
    ]);
    expect(result).toEqual({
      ...original,
      structuredRefusals: [{ path: "other.txt", driver: null, reason: "no_driver" }],
    });
    expect(called).not.toHaveBeenCalled();
  });

  it("does not invoke a driver for binary, mode-change, or non-content conflicts", async () => {
    const f = await fixture();
    const called = vi.fn(async () => ({ ok: true as const, content: "resolved" }));
    const candidate = driver(called);
    const binary = await resolveStructurally(f.repo, f.original, new Set([f.path]), [candidate]);
    expect(binary).toMatchObject({ clean: false, structuredRefusals: [{ reason: "ineligible" }] });
    const file = f.original.conflicts.files[0]!;
    const modeChanged = {
      ...f.original,
      conflicts: {
        ...f.original.conflicts,
        files: [
          {
            ...file,
            stages: file.stages.map((stage) =>
              stage.stage === 3 ? { ...stage, mode: "100755" } : stage,
            ),
          },
        ],
      },
    };
    expect(await resolveStructurally(f.repo, modeChanged, new Set(), [candidate])).toMatchObject({
      clean: false,
      structuredRefusals: [{ reason: "ineligible" }],
    });
    const renamed = {
      ...f.original,
      conflicts: {
        ...f.original.conflicts,
        messages: [{ paths: [f.path], type: "CONFLICT (rename/delete)", message: "conflict" }],
      },
    };
    expect(await resolveStructurally(f.repo, renamed, new Set(), [candidate])).toMatchObject({
      clean: false,
      structuredRefusals: [{ reason: "ineligible" }],
    });
    expect(called).not.toHaveBeenCalled();
  });

  it("rejects more than twenty conflicted files before calling drivers", async () => {
    const f = await fixture();
    const file = f.original.conflicts.files[0]!;
    const oversized = {
      ...f.original,
      conflicts: {
        ...f.original.conflicts,
        files: Array.from({ length: 21 }, (_, index) => ({ ...file, path: `file${index}.txt` })),
      },
    };
    const called = vi.fn(async () => ({ ok: true as const, content: "resolved" }));
    const result = await resolveStructurally(f.repo, oversized, new Set(), [driver(called)]);
    expect(result).toMatchObject({ clean: false, structuredRefusals: [{ reason: "budget" }] });
    expect(called).not.toHaveBeenCalled();
  });

  it("refuses invalid UTF-8 before invoking the driver", async () => {
    const f = await fixture();
    const { stdout } = await git(["hash-object", "-w", "--stdin"], {
      gitDir: f.repo,
      timeoutMs: 5000,
      input: Buffer.from([0xff]),
    });
    const file = f.original.conflicts.files[0]!;
    const invalid = {
      ...f.original,
      conflicts: {
        ...f.original.conflicts,
        files: [
          {
            ...file,
            stages: file.stages.map((stage) =>
              stage.stage === 3 ? { ...stage, oid: stdout.trim() } : stage,
            ),
          },
        ],
      },
    };
    const called = vi.fn(async () => ({ ok: true as const, content: "resolved" }));
    const result = await resolveStructurally(f.repo, invalid, new Set(), [driver(called)]);
    expect(result).toEqual({
      ...invalid,
      structuredRefusals: [{ path: f.path, driver: "fake", reason: "not_utf8" }],
    });
    expect(called).not.toHaveBeenCalled();
  });
});
