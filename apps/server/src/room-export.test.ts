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
  it("streams a tar containing a verifiable room bundle and only that room's memory", async () => {
    const roomId = newId("room");
    const otherRoomId = newId("room");
    const working = join(root, "working");
    const repo = join(root, "room.git");
    const output = join(root, "export.tar.gz");
    const extracted = join(root, "extracted");
    const clone = join(root, "bundle-clone");
    await mkdir(working);
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

    const archive = await new RoomExportService(db.pool).create(
      roomId,
      new AbortController().signal,
    );
    try {
      expect(archive.ledgerHead).toBe("1");
      await pipeline(archive.stream, createWriteStream(output));
    } finally {
      await archive.cleanup();
    }
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
});
