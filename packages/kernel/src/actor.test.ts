import { describe, expect, it } from "vitest";
import { RoomActor, RoomActorRegistry } from "./actor.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("RoomActor", () => {
  it("jobs for the same room never overlap", async () => {
    const actor = new RoomActor("room_1");
    let running = 0;
    let maxRunning = 0;
    const delays = [30, 5, 20, 1, 15, 10];
    await Promise.all(
      delays.map((ms) =>
        actor.submit(async () => {
          running++;
          maxRunning = Math.max(maxRunning, running);
          await sleep(ms);
          running--;
        }),
      ),
    );
    expect(maxRunning).toBe(1);
    expect(running).toBe(0);
  });

  it("runs jobs in submission order even when later jobs are faster", async () => {
    const actor = new RoomActor("room_1");
    const order: string[] = [];
    const jobs = [40, 1, 20, 0].map((ms, i) =>
      actor.submit(async () => {
        order.push(`start-${i}`);
        await sleep(ms);
        order.push(`end-${i}`);
        return i;
      }),
    );
    expect(await Promise.all(jobs)).toEqual([0, 1, 2, 3]);
    expect(order).toEqual([
      "start-0",
      "end-0",
      "start-1",
      "end-1",
      "start-2",
      "end-2",
      "start-3",
      "end-3",
    ]);
  });

  it("a job submitted while another runs waits for it", async () => {
    const actor = new RoomActor("room_1");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const events: string[] = [];
    const first = actor.submit(async () => {
      events.push("first-start");
      await gate;
      events.push("first-end");
    });
    await sleep(10);
    const second = actor.submit(() => {
      events.push("second");
    });
    await sleep(30);
    expect(events).toEqual(["first-start"]); // second hasn't started
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(["first-start", "first-end", "second"]);
  });

  it("a failing job rejects its own promise and doesn't stop the queue", async () => {
    const actor = new RoomActor("room_1");
    const boom = new Error("boom");
    const results = await Promise.allSettled([
      actor.submit(async () => "a"),
      actor.submit(async () => {
        await sleep(5);
        throw boom;
      }),
      actor.submit(async () => "c"),
    ]);
    expect(results[0]).toEqual({ status: "fulfilled", value: "a" });
    expect(results[1]).toEqual({ status: "rejected", reason: boom });
    expect(results[2]).toEqual({ status: "fulfilled", value: "c" });
    expect(await actor.submit(async () => "still running")).toBe("still running");
  });

  it("handles jobs that throw synchronously or reject with non-errors", async () => {
    const actor = new RoomActor("room_1");
    const results = await Promise.allSettled([
      actor.submit(() => {
        throw new Error("sync");
      }),
      actor.submit(() => Promise.reject("a string")),
      actor.submit(() => 42), // a plain function is fine too
    ]);
    expect(results[0]).toMatchObject({ status: "rejected", reason: new Error("sync") });
    expect(results[1]).toEqual({ status: "rejected", reason: "a string" });
    expect(results[2]).toEqual({ status: "fulfilled", value: 42 });
  });

  it("a failure doesn't leak into later jobs' results", async () => {
    const actor = new RoomActor("room_1");
    const failed = actor.submit(async () => {
      throw new Error("first fails");
    });
    const ok = actor.submit(async () => "second ok");
    await expect(failed).rejects.toThrow("first fails");
    await expect(ok).resolves.toBe("second ok");
  });

  it("tracks pending jobs and idle()", async () => {
    const actor = new RoomActor("room_1");
    expect(actor.pending).toBe(0);
    await actor.idle(); // nothing queued: resolves immediately
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const a = actor.submit(() => gate);
    const b = actor.submit(async () => {
      throw new Error("fails");
    });
    b.catch(() => {});
    expect(actor.pending).toBe(2);
    let idle = false;
    const idled = actor.idle().then(() => (idle = true));
    await sleep(20);
    expect(idle).toBe(false);
    release();
    await a;
    await idled;
    expect(idle).toBe(true);
    expect(actor.pending).toBe(0);
  });

  it("pending is already updated when a job's promise resolves", async () => {
    const actor = new RoomActor("room_1");
    await actor.submit(async () => undefined);
    expect(actor.pending).toBe(0);
    await actor.submit(async () => undefined).catch(() => {});
    expect(actor.pending).toBe(0);
  });

  it("keeps working after thousands of jobs", async () => {
    const actor = new RoomActor("room_1");
    let n = 0;
    await Promise.all(Array.from({ length: 5000 }, () => actor.submit(() => ++n)));
    expect(n).toBe(5000);
    expect(actor.pending).toBe(0);
  });

  it("rejects a bad room id or a non-function job", () => {
    expect(() => new RoomActor("")).toThrow(TypeError);
    expect(() => new RoomActor(undefined as unknown as string)).toThrow(TypeError);
    const actor = new RoomActor("room_1");
    expect(() => actor.submit(undefined as unknown as () => void)).toThrow(TypeError);
    expect(actor.pending).toBe(0);
  });
});

describe("RoomActorRegistry", () => {
  it("creates actors lazily and returns the same one per room", () => {
    const registry = new RoomActorRegistry();
    expect(registry.size).toBe(0);
    expect(registry.has("room_1")).toBe(false);
    const a = registry.get("room_1");
    expect(a).toBeInstanceOf(RoomActor);
    expect(a.roomId).toBe("room_1");
    expect(registry.get("room_1")).toBe(a);
    expect(registry.size).toBe(1);
    expect(registry.get("room_2")).not.toBe(a);
    expect(registry.size).toBe(2);
    expect(registry.has("room_1")).toBe(true);
  });

  it("rejects an empty room id without creating an actor", () => {
    const registry = new RoomActorRegistry();
    expect(() => registry.get("")).toThrow(TypeError);
    expect(registry.size).toBe(0);
  });

  it("jobs for different rooms run concurrently", async () => {
    const registry = new RoomActorRegistry();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let aStarted!: () => void;
    const started = new Promise<void>((r) => (aStarted = r));

    // Room A's job is stuck until released.
    const a = registry.get("room_a").submit(async () => {
      aStarted();
      await gate;
      return "a";
    });
    await started;

    // Room B must finish while room A is still running...
    const winner = await Promise.race([
      registry.get("room_b").submit(async () => "b"),
      sleep(3000).then(() => "timeout"),
    ]);
    expect(winner).toBe("b");
    // ...but another room A job is still queued behind A's running job.
    let queuedRan = false;
    const queued = registry.get("room_a").submit(() => {
      queuedRan = true;
    });
    await sleep(30);
    expect(queuedRan).toBe(false);

    release();
    expect(await a).toBe("a");
    await queued;
    expect(queuedRan).toBe(true);
  });

  it("overlaps work across rooms while serializing each room", async () => {
    const registry = new RoomActorRegistry();
    const running = new Map<string, number>();
    let total = 0;
    let maxTotal = 0;
    let maxPerRoom = 0;
    const jobs: Promise<void>[] = [];
    for (let i = 0; i < 4; i++) {
      for (const room of ["r1", "r2", "r3"]) {
        jobs.push(
          registry.get(room).submit(async () => {
            const mine = (running.get(room) ?? 0) + 1;
            running.set(room, mine);
            total++;
            maxPerRoom = Math.max(maxPerRoom, mine);
            maxTotal = Math.max(maxTotal, total);
            await sleep(15);
            running.set(room, mine - 1);
            total--;
          }),
        );
      }
    }
    await Promise.all(jobs);
    expect(maxPerRoom).toBe(1);
    expect(maxTotal).toBeGreaterThan(1); // rooms did overlap
  });

  it("a failing job in one room doesn't affect another room", async () => {
    const registry = new RoomActorRegistry();
    const failing = registry.get("r1").submit(async () => {
      throw new Error("r1 fails");
    });
    const other = registry.get("r2").submit(async () => "r2 ok");
    await expect(failing).rejects.toThrow("r1 fails");
    await expect(other).resolves.toBe("r2 ok");
  });
});
