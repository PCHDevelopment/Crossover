import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Pool, PoolClient } from "@crossover/db";
import { CrossoverError } from "@crossover/protocol";
import type { RoomExportArchive, RoomExportSource } from "@crossover/gateway";
import { PassThrough, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const execFileAsync = promisify(execFile);
const PAGE_SIZE = 500;
const MAX_GIT_BUNDLE_MS = 15 * 60_000;

type Row = Record<string, unknown>;
type RowPage = { rows: Row[] };

interface RoomExportRow {
  slug: string;
  ledger_head: string;
  repo_path: string | null;
}

async function* pageRows(
  fetch: (cursor: string | null) => Promise<RowPage>,
  cursorOf: (row: Row) => string,
  signal: AbortSignal,
): AsyncGenerator<Row> {
  let cursor: string | null = null;
  for (;;) {
    signal.throwIfAborted();
    const { rows } = await fetch(cursor);
    signal.throwIfAborted();
    if (rows.length === 0) return;
    for (const row of rows) yield row;
    const next = cursorOf(rows[rows.length - 1]!);
    if (next === cursor) throw new Error("Room export pagination did not advance");
    cursor = next;
    if (rows.length < PAGE_SIZE) return;
  }
}

async function* rowsById(
  client: PoolClient,
  roomId: string,
  table: "memory_entries" | "tasks" | "task_reviews" | "decisions",
  signal: AbortSignal,
): AsyncGenerator<Row> {
  const idColumn = table === "memory_entries" ? "key" : "id";
  yield* pageRows(
    (cursor) =>
      client.query<Row>(
        `SELECT * FROM ${table}
         WHERE room_id = $1 AND ${idColumn} > $2
         ORDER BY ${idColumn} LIMIT $3`,
        [roomId, cursor ?? "", PAGE_SIZE],
      ),
    (row) => String(row[idColumn]),
    signal,
  );
}

async function* memoryRevisionRows(
  client: PoolClient,
  roomId: string,
  signal: AbortSignal,
): AsyncGenerator<Row> {
  yield* pageRows(
    (cursor) => {
      const [key, revision] = cursor ? (JSON.parse(cursor) as [string, number]) : ["", 0];
      return client.query<Row>(
        `SELECT * FROM memory_revisions
         WHERE room_id = $1 AND (key, revision) > ($2, $3)
         ORDER BY key, revision LIMIT $4`,
        [roomId, key, revision, PAGE_SIZE],
      );
    },
    (row) => JSON.stringify([row["key"], row["revision"]]),
    signal,
  );
}

async function* decisionPositionRows(
  client: PoolClient,
  roomId: string,
  signal: AbortSignal,
): AsyncGenerator<Row> {
  yield* pageRows(
    (cursor) => {
      const [decisionId, participantId] = cursor
        ? (JSON.parse(cursor) as [string, string])
        : ["", ""];
      return client.query<Row>(
        `SELECT * FROM decision_positions
         WHERE room_id = $1 AND (decision_id, participant_id) > ($2, $3)
         ORDER BY decision_id, participant_id LIMIT $4`,
        [roomId, decisionId, participantId, PAGE_SIZE],
      );
    },
    (row) => JSON.stringify([row["decision_id"], row["participant_id"]]),
    signal,
  );
}

async function* eventRows(
  client: PoolClient,
  roomId: string,
  signal: AbortSignal,
): AsyncGenerator<Row> {
  yield* pageRows(
    (cursor) =>
      client.query<Row>(
        `SELECT sequence::text AS sequence, room_id, actor_id, type, schema_version, timestamp,
                causation_id, payload, payload_hash, redacted
         FROM events WHERE room_id = $1 AND sequence > $2::bigint
         ORDER BY sequence LIMIT $3`,
        [roomId, cursor ?? "0", PAGE_SIZE],
      ),
    (row) => String(row["sequence"]),
    signal,
  );
}

async function writeJsonObject(
  path: string,
  sections: readonly { name: string; rows: AsyncIterable<Row> }[],
): Promise<void> {
  async function* json(): AsyncGenerator<string> {
    yield "{\n";
    for (let index = 0; index < sections.length; index++) {
      const section = sections[index]!;
      yield `${index === 0 ? "" : ",\n"}${JSON.stringify(section.name)}: [`;
      let first = true;
      for await (const row of section.rows) {
        yield `${first ? "\n" : ",\n"}${JSON.stringify(row)}`;
        first = false;
      }
      yield `${first ? "" : "\n"}]`;
    }
    yield "\n}\n";
  }
  await pipeline(Readable.from(json()), createWriteStream(path, { flags: "wx" }));
}

async function writeEvents(
  path: string,
  client: PoolClient,
  roomId: string,
  signal: AbortSignal,
): Promise<void> {
  async function* lines(): AsyncGenerator<string> {
    for await (const event of eventRows(client, roomId, signal)) yield `${JSON.stringify(event)}\n`;
  }
  await pipeline(Readable.from(lines()), createWriteStream(path, { flags: "wx" }));
}

async function makeBundle(repoPath: string, output: string, signal: AbortSignal): Promise<void> {
  await execFileAsync("git", ["--git-dir", repoPath, "bundle", "create", output, "--all"], {
    timeout: MAX_GIT_BUNDLE_MS,
    signal,
    maxBuffer: 256 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

function tarStream(
  directory: string,
  signal: AbortSignal,
): {
  stream: Readable;
  child: ChildProcess;
} {
  const child = spawn(
    "tar",
    [
      "-czf",
      "-",
      "-C",
      directory,
      "repository.bundle",
      "events.jsonl",
      "memory.json",
      "tasks.json",
      "decisions.json",
    ],
    { stdio: ["ignore", "pipe", "pipe"], signal },
  );
  const stream = new PassThrough();
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderr.length < 4096) stderr += chunk.toString("utf8").slice(0, 4096 - stderr.length);
  });
  child.once("error", (error) => stream.destroy(error));
  child.once("close", (code) => {
    if (code === 0) stream.end();
    else stream.destroy(new Error(`tar failed (${code ?? "signal"}): ${stderr.trim()}`));
  });
  child.stdout.on("error", (error) => stream.destroy(error));
  child.stdout.pipe(stream, { end: false });
  stream.once("close", () => {
    if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
  });
  return { stream, child };
}

/** Builds a disk-staged archive and streams tar output without buffering repository contents. */
export class RoomExportService implements RoomExportSource {
  constructor(
    private readonly pool: Pool,
    private readonly tempRoot = tmpdir(),
  ) {}

  async create(roomId: string, signal: AbortSignal): Promise<RoomExportArchive> {
    const directory = await mkdtemp(join(this.tempRoot, "crossover-room-export-"));
    let child: ChildProcess | undefined;
    try {
      const client = await this.pool.connect();
      let room: RoomExportRow | undefined;
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const found = await client.query<RoomExportRow>(
          `SELECT rooms.slug, rooms.last_sequence::text AS ledger_head, workspaces.repo_path
           FROM rooms LEFT JOIN workspaces ON workspaces.room_id = rooms.id
           WHERE rooms.id = $1`,
          [roomId],
        );
        room = found.rows[0];
        if (!room) throw new CrossoverError("NOT_FOUND", "Room not found");
        if (!room.repo_path)
          throw new CrossoverError("UNAVAILABLE", "Room repository is unavailable");
        await writeEvents(join(directory, "events.jsonl"), client, roomId, signal);
        await writeJsonObject(join(directory, "memory.json"), [
          { name: "entries", rows: rowsById(client, roomId, "memory_entries", signal) },
          { name: "revisions", rows: memoryRevisionRows(client, roomId, signal) },
        ]);
        await writeJsonObject(join(directory, "tasks.json"), [
          { name: "tasks", rows: rowsById(client, roomId, "tasks", signal) },
          { name: "reviews", rows: rowsById(client, roomId, "task_reviews", signal) },
        ]);
        await writeJsonObject(join(directory, "decisions.json"), [
          { name: "decisions", rows: rowsById(client, roomId, "decisions", signal) },
          { name: "positions", rows: decisionPositionRows(client, roomId, signal) },
        ]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }

      if (signal.aborted) throw signal.reason ?? new Error("Room export was cancelled");
      await makeBundle(room!.repo_path!, join(directory, "repository.bundle"), signal);
      if (signal.aborted) throw signal.reason ?? new Error("Room export was cancelled");
      const result = tarStream(directory, signal);
      child = result.child;
      const slug = room!.slug.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80) || "room";
      return {
        filename: `${slug}-export.tar.gz`,
        ledgerHead: room!.ledger_head,
        stream: result.stream,
        async cleanup() {
          if (child && child.exitCode === null && !child.killed) child.kill("SIGTERM");
          await rm(directory, { recursive: true, force: true });
        },
      };
    } catch (error) {
      if (child && child.exitCode === null && !child.killed) child.kill("SIGTERM");
      await rm(directory, { recursive: true, force: true });
      if (signal.aborted) throw new CrossoverError("UNAVAILABLE", "Room export was cancelled");
      throw error;
    }
  }
}
