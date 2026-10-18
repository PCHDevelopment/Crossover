import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecutionCore } from "./core.js";
import { scheduleCanonicalAdvance } from "./canonical-advance.js";
import { close } from "./lifecycle.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

function heldReconcile() {
  const entered = deferred();
  const release = deferred();
  const driver = { status: vi.fn() };
  const canonicalHead = vi.fn(async () => ({
    repo_path: "unused",
    revision: 1,
    commit_sha: "unused",
  }));
  const query = vi.fn(async () => {
    entered.resolve();
    await release.promise;
    return { rows: [] };
  });
  const core = {
    closed: false,
    pendingAdvances: new Map<string, number>(),
    pendingAdvanceSkips: new Map<string, Map<string, number>>(),
    advanceWorkers: new Map<string, Promise<void>>(),
    pool: { query },
    driver,
    canonicalHead,
    hooks: { cancelAllExecs: vi.fn(async () => {}) },
  } as unknown as ExecutionCore;
  scheduleCanonicalAdvance(core, "room_test", 1);
  return { core, entered, release, query, canonicalHead, driver };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("canonical advance shutdown", () => {
  it("waits for an in-flight reconcile and refuses advances after close", async () => {
    const { core, entered, release, query, canonicalHead, driver } = heldReconcile();
    await entered.promise;
    let closed = false;
    const closing = close(core).then(() => {
      closed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);

    scheduleCanonicalAdvance(core, "room_test", 2);
    release.resolve();
    await closing;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(query).toHaveBeenCalledTimes(1);
    expect(canonicalHead).toHaveBeenCalledTimes(1);
    expect(driver.status).not.toHaveBeenCalled();
    expect(core.pendingAdvances.size).toBe(0);
  });

  it("bounds the wait when a reconcile never settles", async () => {
    const { core, entered, release } = heldReconcile();
    await entered.promise;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers();
    const closing = close(core);
    await vi.advanceTimersByTimeAsync(30_000);
    await closing;
    expect(error).toHaveBeenCalledWith(
      "[execution] canonical advance workers did not finish before shutdown",
      { worker_count: 1, wait_ms: 30_000 },
    );
    release.resolve();
    await Promise.allSettled([...core.advanceWorkers.values()]);
  });
});
