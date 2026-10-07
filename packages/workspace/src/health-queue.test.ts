import { describe, expect, it, vi } from "vitest";
import { HealthCheckQueue } from "./health-queue.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("HealthCheckQueue", () => {
  it("runs the active revision and only the latest of ten rapid updates", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const secondStarted = deferred<void>();
    const calls: Array<{ roomId: string; revision: number }> = [];
    let active = 0;
    let maximumActive = 0;
    const queue = new HealthCheckQueue({
      run: async (roomId, revision) => {
        calls.push({ roomId, revision });
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        try {
          if (revision === 0) await first.promise;
          else {
            secondStarted.resolve();
            await second.promise;
          }
        } finally {
          active -= 1;
        }
      },
    });

    queue.enqueue("room_a", 0);
    for (let revision = 1; revision <= 10; revision += 1) queue.enqueue("room_a", revision);
    queue.enqueue("room_a", 4); // a late older notification cannot replace the newest head
    expect(calls).toEqual([{ roomId: "room_a", revision: 0 }]);

    first.resolve();
    await secondStarted.promise;
    expect(calls).toEqual([
      { roomId: "room_a", revision: 0 },
      { roomId: "room_a", revision: 10 },
    ]);
    expect(maximumActive).toBe(1);
    second.resolve();
    await queue.close();
    expect(maximumActive).toBe(1);
  });

  it("runs different rooms independently", async () => {
    const roomAStarted = deferred<void>();
    const roomBStarted = deferred<void>();
    const releaseA = deferred<void>();
    const queue = new HealthCheckQueue({
      run: async (roomId) => {
        if (roomId === "room_a") {
          roomAStarted.resolve();
          await releaseA.promise;
        } else {
          roomBStarted.resolve();
        }
      },
    });

    queue.enqueue("room_a", 1);
    await roomAStarted.promise;
    queue.enqueue("room_b", 1);
    await roomBStarted.promise;
    releaseA.resolve();
    await queue.close();
  });

  it("aborts the active run, drops pending revisions, and rejects work on close", async () => {
    const started = deferred<void>();
    const calls: number[] = [];
    let activeSignal: AbortSignal | undefined;
    const queue = new HealthCheckQueue({
      run: async (_roomId, revision, signal) => {
        calls.push(revision);
        activeSignal = signal;
        started.resolve();
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      },
    });

    queue.enqueue("room_a", 1);
    await started.promise;
    queue.enqueue("room_a", 2);
    await queue.close();
    queue.enqueue("room_a", 3);

    expect(activeSignal?.aborted).toBe(true);
    expect(calls).toEqual([1]);
  });

  it("continues to the latest revision after a run rejects", async () => {
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const secondStarted = deferred<void>();
    const calls: number[] = [];
    const onError = vi.fn();
    const queue = new HealthCheckQueue({
      onError,
      run: async (_roomId, revision) => {
        calls.push(revision);
        if (revision === 1) {
          firstStarted.resolve();
          await releaseFirst.promise;
          throw new Error("health runner failed");
        }
        secondStarted.resolve();
      },
    });

    queue.enqueue("room_a", 1);
    await firstStarted.promise;
    queue.enqueue("room_a", 2);
    releaseFirst.resolve();
    await secondStarted.promise;
    await queue.close();

    expect(calls).toEqual([1, 2]);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("keeps a per-room revision high-water mark after the worker drains", async () => {
    const calls: number[] = [];
    const queue = new HealthCheckQueue({
      run: async (_roomId, revision) => void calls.push(revision),
    });

    queue.enqueue("room_a", 9);
    await new Promise<void>((resolve) => setImmediate(resolve));
    queue.enqueue("room_a", 8);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await queue.close();

    expect(calls).toEqual([9]);
  });
});
