import { describe, expect, it } from "vitest";
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
});
