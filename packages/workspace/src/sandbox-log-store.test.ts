import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newId } from "@crossover/protocol";
import { FileLogStore, MemoryLogStore, SandboxOutputHub } from "./sandbox-log-store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fileStore(onError?: (error: unknown, path: string) => void): Promise<FileLogStore> {
  const root = await mkdtemp(join(tmpdir(), "crossover-sandbox-logs-"));
  roots.push(root);
  return new FileLogStore(root, onError);
}

const metadata = (execId = newId("exec")) => ({
  exec_id: execId,
  room_id: newId("room"),
  sandbox_id: newId("sandbox"),
  participant_id: newId("part"),
  command: "printf private",
  cwd: "/workspace/src",
  timeout_s: 600,
  started_at: new Date(0).toISOString(),
  output_bytes: 0,
  truncated: false,
});

describe("sandbox output log store", () => {
  it("keeps private metadata and ordered, replayable binary chunks with restrictive modes", async () => {
    const store = await fileStore();
    const entry = metadata();
    await store.create(entry);
    await store.append(entry.exec_id, {
      cursor: 1,
      kind: "data",
      stream: "stdout",
      data: Buffer.from([0, 1, 0xff]),
    });
    await store.append(entry.exec_id, { cursor: 2, kind: "truncated" });

    expect(await store.read(entry.exec_id, 1, 10)).toEqual([{ cursor: 2, kind: "truncated" }]);
    expect(await store.get(entry.exec_id)).toEqual(entry);
    const rootStat = await stat(store.root);
    const metadataStat = await stat(join(store.root, entry.exec_id, "metadata.json"));
    expect(rootStat.mode & 0o777).toBe(0o700);
    expect(metadataStat.mode & 0o777).toBe(0o600);
    expect(
      await readFile(join(store.root, entry.exec_id, "chunks", "0000000001.json"), "utf8"),
    ).not.toContain("private");
  });

  it("expires logs after 30 days and publishes updates without coupling subscribers", async () => {
    const store = await fileStore();
    const entry = metadata();
    await store.create(entry);
    await store.append(entry.exec_id, {
      cursor: 1,
      kind: "data",
      stream: "stderr",
      data: Buffer.from("diagnostic"),
    });
    const hub = new SandboxOutputHub();
    const received: unknown[] = [];
    hub.subscribe(entry.exec_id, () => {
      throw new Error("closed subscriber");
    });
    hub.subscribe(entry.exec_id, (update) => received.push(update));
    hub.publish(entry.exec_id, {
      cursor: 1,
      kind: "data",
      stream: "stderr",
      data: Buffer.from("diagnostic"),
    });
    const finished = {
      ...entry,
      finished_at: new Date(1).toISOString(),
      exit_code: 0,
      duration_ms: 1,
    };
    await store.update(entry.exec_id, finished);
    hub.publishFinished(entry.exec_id, finished);

    expect(received).toHaveLength(2);
    expect(await store.sweepExpired(30 * 24 * 60 * 60 * 1000)).toBe(1);
    expect(await store.get(entry.exec_id)).toBeUndefined();
  });

  it("continues retention cleanup when one metadata file is corrupt", async () => {
    const errors: Array<{ error: unknown; path: string }> = [];
    const store = await fileStore((error, path) => errors.push({ error, path }));
    const corrupt = metadata();
    const expired = metadata();
    await store.create(corrupt);
    await writeFile(join(store.root, corrupt.exec_id, "metadata.json"), "{");
    await store.create(expired);

    const removed = await store.sweepExpired(Date.now() + 30 * 24 * 60 * 60 * 1000 - 60_000);

    expect(removed).toBe(1);
    expect(await store.get(expired.exec_id)).toBeUndefined();
    expect(await readFile(join(store.root, corrupt.exec_id, "metadata.json"), "utf8")).toBe("{");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      path: join(store.root, corrupt.exec_id),
      error: expect.any(SyntaxError),
    });
  });

  it("keeps the in-memory test adapter byte accurate", async () => {
    const store = new MemoryLogStore();
    const entry = metadata();
    await store.create(entry);
    await store.append(entry.exec_id, {
      cursor: 1,
      kind: "data",
      stream: "stdout",
      data: Buffer.from([0, 255]),
    });
    const [chunk] = await store.read(entry.exec_id, 0, 10);
    expect(chunk).toMatchObject({ cursor: 1, kind: "data", stream: "stdout" });
    expect(chunk?.kind === "data" ? Buffer.from(chunk.data) : undefined).toEqual(
      Buffer.from([0, 255]),
    );
  });
});
