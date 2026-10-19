import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { newId } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { HashEmbeddingProvider, type EmbeddingProvider } from "./embeddings.js";
import { MemoryEmbeddingIndexer } from "./embedding-index.js";

let db: TestDatabase;
const signal = () => new AbortController().signal;

beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
});

async function room(): Promise<string> {
  const id = newId("room");
  await db.pool.query(
    "INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'n', 'o', 'x')",
    [id],
  );
  return id;
}

async function entry(roomId: string, key: string, value = "database migration plan") {
  await db.pool.query(
    `INSERT INTO memory_entries (room_id, key, value, content_type, author_id, revision)
     VALUES ($1, $2, $3, 'text/markdown', 'x', 1)`,
    [roomId, key, value],
  );
}

async function rows(roomId: string) {
  return (
    await db.pool.query<{ key: string; model: string; revision: number }>(
      "SELECT key, model, revision FROM memory_embeddings WHERE room_id = $1 ORDER BY key, model",
      [roomId],
    )
  ).rows;
}

const make = (provider: EmbeddingProvider = new HashEmbeddingProvider()) =>
  new MemoryEmbeddingIndexer({ pool: db.pool, provider, onError: () => {} });

describe("MemoryEmbeddingIndexer", () => {
  it("indexes live entries and removes deleted or redacted vectors", async () => {
    const id = await room();
    await entry(id, "live");
    await entry(id, "deleted");
    await entry(id, "redacted");
    const indexer = make();
    expect(await indexer.syncRoom(id, signal())).toMatchObject({ embedded: 3 });
    await db.pool.query(
      "UPDATE memory_entries SET deleted = true WHERE room_id = $1 AND key = 'deleted'",
      [id],
    );
    await db.pool.query(
      "UPDATE memory_entries SET redacted = true WHERE room_id = $1 AND key = 'redacted'",
      [id],
    );
    expect(await indexer.syncRoom(id, signal())).toMatchObject({ removed: 2 });
    expect((await rows(id)).map((row) => row.key)).toEqual(["live"]);
    await indexer.close();
  });

  it("re-embeds revisions and rebuilds from source rows", async () => {
    const id = await room();
    await entry(id, "key");
    const indexer = make();
    await indexer.syncRoom(id, signal());
    await db.pool.query(
      "UPDATE memory_entries SET revision = 2, value = 'new text' WHERE room_id = $1",
      [id],
    );
    await indexer.syncRoom(id, signal());
    expect(await rows(id)).toMatchObject([{ revision: 2 }]);
    await indexer.rebuild(id);
    expect(await rows(id)).toMatchObject([{ revision: 2 }]);
    await indexer.close();
  });

  it("does not write a vector for a revision changed during embedding", async () => {
    const id = await room();
    await entry(id, "key");
    const base = new HashEmbeddingProvider();
    let changed = false;
    const provider: EmbeddingProvider = {
      model: base.model,
      dimensions: base.dimensions,
      maxInputChars: base.maxInputChars,
      embed: async (texts, abort) => {
        if (!changed) {
          changed = true;
          await db.pool.query(
            "UPDATE memory_entries SET revision = 2, value = 'new text' WHERE room_id = $1",
            [id],
          );
        }
        return base.embed(texts, abort);
      },
    };
    const indexer = make(provider);
    await indexer.syncRoom(id, signal());
    expect(await rows(id)).toEqual([]);
    await indexer.syncRoom(id, signal());
    expect(await rows(id)).toMatchObject([{ revision: 2 }]);
    await indexer.close();
  });

  it("bounds concurrent room syncs and deduplicates queued work", async () => {
    const ids = await Promise.all(Array.from({ length: 5 }, () => room()));
    const keyToRoom = new Map<string, string>();
    for (const [index, id] of ids.entries()) {
      const key = `key-${index}`;
      keyToRoom.set(key, id);
      await entry(id, key);
    }

    const base = new HashEmbeddingProvider();
    let active = 0;
    let maxActive = 0;
    let completed = 0;
    let holdInitialCalls = true;
    let releaseInitialCalls!: () => void;
    const initialCalls = new Promise<void>((resolve) => {
      releaseInitialCalls = resolve;
    });
    const embeddedKeys: string[] = [];
    const provider: EmbeddingProvider = {
      model: base.model,
      dimensions: base.dimensions,
      maxInputChars: base.maxInputChars,
      embed: async (texts, abort) => {
        const key = texts[0]?.split("\n", 1)[0] ?? "";
        embeddedKeys.push(key);
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (holdInitialCalls) await initialCalls;
        active -= 1;
        completed += 1;
        return base.embed(texts, abort);
      },
    };
    const indexer = new MemoryEmbeddingIndexer({
      pool: db.pool,
      provider,
      maxConcurrentRooms: 2,
      onError: () => {},
    });

    for (const id of ids) indexer.schedule(id);
    await vi.waitFor(() => expect(embeddedKeys).toHaveLength(2));

    const activeKey = embeddedKeys[0]!;
    const activeRoom = keyToRoom.get(activeKey)!;
    indexer.schedule(activeRoom);
    await db.pool.query(
      "UPDATE memory_entries SET revision = 2, value = 'updated while queued' WHERE room_id = $1",
      [activeRoom],
    );
    const queuedRoom = keyToRoom.get("key-4")!;
    indexer.schedule(queuedRoom);
    indexer.schedule(queuedRoom);
    indexer.schedule(queuedRoom);

    holdInitialCalls = false;
    releaseInitialCalls();
    await vi.waitFor(() => expect(completed).toBe(6));

    expect(maxActive).toBe(2);
    expect(embeddedKeys.filter((key) => key === "key-4")).toHaveLength(1);
    expect(embeddedKeys.filter((key) => key === activeKey)).toHaveLength(2);
    await indexer.close();
  });

  it("replaces an old model and retries a provider failure on the next sweep", async () => {
    const id = await room();
    await entry(id, "key");
    const base = new HashEmbeddingProvider();
    await make().syncRoom(id, signal());
    let fail = true;
    const provider: EmbeddingProvider = {
      model: "new-model",
      dimensions: base.dimensions,
      maxInputChars: base.maxInputChars,
      embed: async (texts, abort) => {
        if (fail) {
          fail = false;
          throw new Error("temporary provider failure");
        }
        return base.embed(texts, abort);
      },
    };
    const indexer = make(provider);
    await expect(indexer.syncRoom(id, signal())).rejects.toThrow("temporary provider failure");
    expect(await rows(id)).toEqual([]);
    await indexer.sweep();
    await vi.waitFor(async () => expect(await rows(id)).toMatchObject([{ model: "new-model" }]));
    await indexer.close();
  });
});
