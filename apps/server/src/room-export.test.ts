import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { newId } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RoomExportService } from "./room-export.js";

const execFileAsync = promisify(execFile);
const identity = {
  GIT_AUTHOR_NAME: "Export test",
  GIT_AUTHOR_EMAIL: "export@example.invalid",
  GIT_COMMITTER_NAME: "Export test",
  GIT_COMMITTER_EMAIL: "export@example.invalid",
};

let db: TestDatabase;
let root: string;

beforeAll(async () => {
  db = await createTestDatabase();
  root = await mkdtemp(join(tmpdir(), "crossover-room-export-test-"));
});

afterAll(async () => {
  await db?.drop();
  if (root) await rm(root, { recursive: true, force: true });
});

async function git(args: string[], cwd?: string) {
  return execFileAsync("git", args, {
    ...(cwd ? { cwd } : {}),
    env: { ...process.env, ...identity, GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 256 * 1024,
  });
}

describe("RoomExportService", () => {
  it("removes staged files when archive creation fails", async () => {
    const temp = await mkdtemp(join(root, "failed-export-"));
    try {
      await expect(
        new RoomExportService(db.pool, temp).create(newId("room"), new AbortController().signal),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(await readdir(temp)).toEqual([]);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("streams a tar containing a verifiable room bundle and only that room's memory", async () => {
    const roomId = newId("room");
    const otherRoomId = newId("room");
    const working = join(root, "working");
    const repo = join(root, "room.git");
    const staging = join(root, "staging");
    const output = join(root, "export.tar.gz");
    const extracted = join(root, "extracted");
    const clone = join(root, "bundle-clone");
    await mkdir(working);
    await mkdir(staging);
    await mkdir(extracted);
    await git(["init", "-q", "-b", "main"], working);
    await git(["config", "user.name", identity.GIT_AUTHOR_NAME], working);
    await git(["config", "user.email", identity.GIT_AUTHOR_EMAIL], working);
    await writeFile(join(working, "README.md"), "room repository\n");
    await git(["add", "README.md"], working);
    await git(["commit", "-q", "-m", "initial room state"], working);
    await git(["clone", "-q", "--bare", working, repo]);

    await db.pool.query(
      `INSERT INTO rooms (id, slug, name, objective, owner_id, last_sequence)
       VALUES ($1, $1, 'Export test', 'Verify export', 'part_test', 1),
              ($2, $2, 'Other room', 'Check room scope', 'part_test', 0)`,
      [roomId, otherRoomId],
    );
    await db.pool.query(
      `INSERT INTO events (room_id, sequence, actor_id, type, payload, payload_hash)
       VALUES ($1, 1, 'part_test', 'room.created', '{"slug":"export-test"}', 'test-hash')`,
      [roomId],
    );
    await db.pool.query("INSERT INTO workspaces (id, room_id, repo_path) VALUES ($1, $2, $3)", [
      newId("ws"),
      roomId,
      repo,
    ]);
    await db.pool.query(
      `INSERT INTO memory_entries (room_id, key, value, content_type, author_id, revision)
       VALUES ($1, 'inside', 'included', 'text/markdown', 'part_test', 1),
              ($2, 'outside', 'excluded', 'text/markdown', 'part_test', 1)`,
      [roomId, otherRoomId],
    );

    const archive = await new RoomExportService(db.pool, staging).create(
      roomId,
      new AbortController().signal,
    );
    try {
      expect(archive.ledgerHead).toBe("1");
      await pipeline(archive.stream, createWriteStream(output));
    } finally {
      await archive.cleanup();
    }
    expect(await readdir(staging)).toEqual([]);
    await execFileAsync("tar", ["-xzf", output, "-C", extracted]);

    const memory = JSON.parse(await readFile(join(extracted, "memory.json"), "utf8")) as {
      entries: { key: string; value: string }[];
    };
    expect(memory.entries.map(({ key, value }) => [key, value])).toEqual([["inside", "included"]]);
    const events = (await readFile(join(extracted, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { sequence: string; room_id: string });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ sequence: "1", room_id: roomId });
    expect((await readdir(extracted)).sort()).toEqual(
      ["repository.bundle", "events.jsonl", "memory.json", "tasks.json", "decisions.json"].sort(),
    );
    await git(["clone", "-q", join(extracted, "repository.bundle"), clone]);
    expect(await readFile(join(clone, "README.md"), "utf8")).toBe("room repository\n");
  });

  describe("a real room's repository (T1634): refs/room/canonical, no branch, HEAD on a missing branch", () => {
    /** A room repo as the server leaves it: `git init --bare --template=`, objects under refs/room/* only. */
    async function realRoom(shallow: boolean) {
      const base = await mkdtemp(join(root, "real-room-"));
      const working = join(base, "working");
      const repo = join(base, "room.git");
      await mkdir(working);
      await git(["init", "-q", "-b", "main"], working);
      for (const n of [1, 2, 3]) {
        await writeFile(join(working, "README.md"), `canonical files ${n}\n`);
        await git(["add", "README.md"], working);
        await git(["commit", "-q", "-m", `commit ${n}`], working);
      }
      await git(["init", "-q", "--bare", "--template=", repo]);
      let canonical: string;
      if (shallow) {
        // As git.import leaves it: a --depth=1 upstream fetched with --update-shallow, then a canonical
        // commit made with `commit-tree <upstream tree> -p <room head>`.
        const upstream = join(base, "upstream.git");
        const clone = join(base, "clone");
        await git(["clone", "-q", "--bare", working, upstream]);
        await git(["clone", "-q", "--depth=1", `file://${upstream}`, clone]);
        await git(
          [
            "fetch",
            "-q",
            "--no-tags",
            "--update-shallow",
            clone,
            "+refs/heads/main:refs/upstream/head",
          ],
          repo,
        );
        const tree = (
          await git(["--git-dir", repo, "rev-parse", "refs/upstream/head^{tree}"])
        ).stdout.trim();
        const hashing = execFileAsync(
          "git",
          ["--git-dir", repo, "hash-object", "-t", "tree", "-w", "--stdin"],
          { env: { ...process.env, ...identity } },
        );
        hashing.child.stdin?.end();
        const empty = (await hashing).stdout.trim();
        const head = (
          await git(["--git-dir", repo, "commit-tree", empty, "-m", "room"])
        ).stdout.trim();
        canonical = (
          await git(["--git-dir", repo, "commit-tree", tree, "-p", head, "-m", "import"])
        ).stdout.trim();
        await git(["--git-dir", repo, "update-ref", "refs/room/canonical", canonical]);
      } else {
        await git(
          ["push", "-q", repo, "main:refs/room/canonical", "main:refs/upstream/head"],
          working,
        );
        canonical = (await git(["rev-parse", "HEAD"], working)).stdout.trim();
      }
      return { base, repo, canonical };
    }

    /** Export the repo through the service and return the extracted bundle's path. */
    async function exportedBundle(base: string, repo: string): Promise<string> {
      const roomId = newId("room");
      const staging = join(base, "staging");
      const extracted = join(base, "extracted");
      await mkdir(staging);
      await mkdir(extracted);
      await db.pool.query(
        "INSERT INTO rooms (id, slug, name, objective, owner_id, last_sequence) VALUES ($1, $1, 'Real', 'Real room', 'part_test', 0)",
        [roomId],
      );
      await db.pool.query("INSERT INTO workspaces (id, room_id, repo_path) VALUES ($1, $2, $3)", [
        newId("ws"),
        roomId,
        repo,
      ]);
      const archive = await new RoomExportService(db.pool, staging).create(
        roomId,
        new AbortController().signal,
      );
      const output = join(base, "export.tar.gz");
      try {
        await pipeline(archive.stream, createWriteStream(output));
      } finally {
        await archive.cleanup();
      }
      await execFileAsync("tar", ["-xzf", output, "-C", extracted]);
      expect((await readdir(extracted)).sort()).toEqual(
        ["repository.bundle", "events.jsonl", "memory.json", "tasks.json", "decisions.json"].sort(),
      );
      return join(extracted, "repository.bundle");
    }

    it("a real room's bundle clones to its canonical files", async () => {
      const { base, repo, canonical } = await realRoom(false);
      const bundle = await exportedBundle(base, repo);
      const clone = join(base, "clone-of-bundle");
      await git(["clone", "-q", bundle, clone]);
      expect(await readFile(join(clone, "README.md"), "utf8")).toBe("canonical files 3\n");
      expect((await git(["rev-parse", "HEAD"], clone)).stdout.trim()).toBe(canonical);
    });

    it("the bundle keeps refs/room and refs/upstream and adds refs/heads/main and HEAD", async () => {
      const { base, repo, canonical } = await realRoom(false);
      const heads = (await git(["bundle", "list-heads", await exportedBundle(base, repo)])).stdout
        .trim()
        .split("\n")
        .map((line) => line.split(" ").reverse() as [string, string]);
      expect(Object.fromEntries(heads)).toEqual({
        HEAD: canonical,
        "refs/heads/main": canonical,
        "refs/room/canonical": canonical,
        "refs/upstream/head": canonical,
      });
    });

    it("exporting does not change the room repository", async () => {
      const { base, repo } = await realRoom(false);
      const state = async () =>
        [
          (await git(["--git-dir", repo, "for-each-ref"])).stdout,
          (await git(["--git-dir", repo, "symbolic-ref", "HEAD"])).stdout,
          (await readdir(repo)).sort().join(","),
        ].join("|");
      const before = await state();
      await exportedBundle(base, repo);
      expect(await state()).toBe(before);
    });

    it(
      "a shallow room (as git.import leaves it) clones to its canonical files too",
      { timeout: 30_000 },
      async () => {
        const { base, repo, canonical } = await realRoom(true);
        expect((await readdir(repo)).includes("shallow")).toBe(true);
        const bundle = await exportedBundle(base, repo);
        const clone = join(base, "clone-of-bundle");
        await git(["clone", "-q", bundle, clone]);
        expect(await readFile(join(clone, "README.md"), "utf8")).toBe("canonical files 3\n");
        expect((await git(["rev-parse", "HEAD"], clone)).stdout.trim()).toBe(canonical);
      },
    );
  });
});
