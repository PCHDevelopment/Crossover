import { spawn } from "node:child_process";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "@crossover/db";
import { git } from "./git.js";
import { HealthCheckQueue } from "./health-queue.js";

export interface ZoektIndexerOptions {
  pool: Pool;
  indexDir: string;
  command?: string[];
  concurrency: number;
  timeoutMs: number;
  onError?: (error: unknown, roomId: string, revision: number) => void;
}

export function zoektArgs(indexDir: string, roomId: string, repo: string): string[] {
  if (!/^room_[0-9A-Za-z]+$/.test(roomId)) throw new Error("Invalid room ID for Zoekt shard");
  return [
    "-index",
    indexDir,
    "-shard_prefix_override",
    roomId,
    "-prefix",
    "refs/zoekt/",
    "-branches",
    "head",
    "-incremental",
    "-delta",
    "-delta_threshold",
    "50",
    "-disable_ctags",
    "-submodules=false",
    "-file_limit",
    "5242880",
    "-max_trigram_count",
    "5242880",
    repo,
  ];
}

/** Runs one index per room off the actor, with coalescing supplied by HealthCheckQueue. */
export class ZoektIndexer {
  private readonly queue: HealthCheckQueue;
  private readonly waiters: Array<() => void> = [];
  private readonly removing = new Set<string>();
  private active = 0;

  constructor(private readonly options: ZoektIndexerOptions) {
    if (!Number.isInteger(options.concurrency) || options.concurrency < 1)
      throw new RangeError("Zoekt concurrency must be positive");
    if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1)
      throw new RangeError("Zoekt timeout must be positive");
    if (options.command?.length === 0) throw new Error("Zoekt command must not be empty");
    this.queue = new HealthCheckQueue({
      run: (roomId, revision, signal) => this.index(roomId, revision, signal),
      onError:
        options.onError ??
        ((error, roomId, revision) =>
          console.error(`zoekt index failed for ${roomId} revision ${revision}`, error)),
    });
  }

  schedule(roomId: string, revision: number): void {
    if (this.removing.has(roomId)) return;
    this.queue.enqueue(roomId, revision);
  }

  async index(
    roomId: string,
    revision: number,
    signal: AbortSignal,
  ): Promise<"indexed" | "skipped"> {
    if (!/^room_[0-9A-Za-z]+$/.test(roomId)) throw new Error("Invalid room ID for Zoekt shard");
    if (this.removing.has(roomId)) return "skipped";
    if (signal.aborted) return "skipped";
    const { rows } = await this.options.pool.query<{
      repo_path: string;
      commit_sha: string;
      revision: string;
      status: string;
      purge_started_at: Date | null;
    }>(
      `SELECT w.repo_path, wr.commit_sha, wr.revision, room.status, room.purge_started_at
       FROM rooms room JOIN workspaces w ON w.room_id = room.id
       JOIN workspace_revisions wr ON wr.workspace_id = w.id AND wr.room_id = room.id
       WHERE room.id = $1 ORDER BY wr.revision DESC LIMIT 1`,
      [roomId],
    );
    const head = rows[0];
    if (
      !head ||
      Number(head.revision) !== revision ||
      head.status === "DELETED" ||
      head.purge_started_at ||
      signal.aborted
    )
      return "skipped";
    await this.acquire(signal);
    try {
      if (signal.aborted) return "skipped";
      // Recheck after waiting for a slot so an older revision cannot replace a newer shard.
      const current = await this.options.pool.query<{
        revision: string;
        purge_started_at: Date | null;
      }>(
        `SELECT max(wr.revision) AS revision, room.purge_started_at
         FROM rooms room JOIN workspace_revisions wr ON wr.room_id = room.id
         WHERE room.id = $1 GROUP BY room.purge_started_at`,
        [roomId],
      );
      if (
        Number(current.rows[0]?.revision) !== revision ||
        current.rows[0]?.purge_started_at ||
        signal.aborted
      )
        return "skipped";
      await git(["update-ref", "refs/zoekt/head", head.commit_sha], {
        gitDir: head.repo_path,
        timeoutMs: 10_000,
      });
      if (signal.aborted) return "skipped";
      const command = this.options.command ?? ["zoekt-git-index"];
      await this.run(
        command[0]!,
        [...command.slice(1), ...zoektArgs(this.options.indexDir, roomId, head.repo_path)],
        signal,
      );
      return "indexed";
    } finally {
      this.release();
    }
  }

  async removeRoom(roomId: string): Promise<void> {
    if (!/^room_[0-9A-Za-z]+$/.test(roomId)) throw new Error("Invalid room ID for Zoekt shard");
    this.removing.add(roomId);
    await this.queue.cancel(roomId);
    const names = await readdir(this.options.indexDir).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    await Promise.all(
      names
        .filter((name) => name.startsWith(`${roomId}_v`))
        .map((name) => rm(join(this.options.indexDir, name))),
    );
  }

  close(): Promise<void> {
    return this.queue.close();
  }

  private async acquire(signal: AbortSignal): Promise<void> {
    if (this.active < this.options.concurrency) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const index = this.waiters.indexOf(wake);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(signal.reason ?? new Error("Zoekt indexing aborted"));
      };
      const wake = () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      this.waiters.push(wake);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.active--;
  }

  private run(command: string, args: string[], signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      let stderr = "";
      let failed = false;
      const child = spawn(command, args, {
        signal,
        timeout: this.options.timeoutMs,
        killSignal: "SIGKILL",
        stdio: ["ignore", "ignore", "pipe"],
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < 8192) stderr += chunk.toString("utf8").slice(0, 8192 - stderr.length);
      });
      child.on("error", (error) => {
        failed = true;
        reject(new Error(`Zoekt index process failed: ${stderr}`, { cause: error }));
      });
      child.on("close", (code, killedBy) => {
        if (failed) return;
        if (code === 0) resolve();
        else reject(new Error(`Zoekt index process failed (${killedBy ?? code}): ${stderr}`));
      });
    });
  }
}
