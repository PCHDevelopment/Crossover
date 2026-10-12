import type { PresenceIntent, PresenceRecord } from "@crossover/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyIntentSnapshot,
  applyPresence,
  colorOf,
  cursorsOn,
  HEARTBEAT_MS,
  livePresence,
  MIN_INTERVAL_MS,
  PRESENCE_COLORS,
  PresenceSender,
  RETRY_MS,
  intentRangesOn,
  liveIntents,
  viewersByPath,
  type IntentMap,
  type OwnPresence,
} from "./presence.js";

const rec = (id: string, expires: string, patch: Partial<PresenceRecord> = {}): PresenceRecord => ({
  participant_id: id,
  status: "active",
  open_files: [],
  cursor: null,
  expires_at: expires,
  ...patch,
});

describe("presence records", () => {
  it("a snapshot replaces everything; a record replaces its own unless it is older", () => {
    let m = applyPresence(new Map(), { snapshot: [rec("p_a", "2026-01-01T00:00:10Z")] });
    m = applyPresence(m, { record: rec("p_b", "2026-01-01T00:00:10Z") });
    m = applyPresence(m, { record: rec("p_a", "2026-01-01T00:00:05Z", { status: "idle" }) });
    expect(m.get("p_a")!.status).toBe("active"); // older: ignored
    m = applyPresence(m, { record: rec("p_a", "2026-01-01T00:00:20Z", { status: "idle" }) });
    expect([...m.values()].map((r) => [r.participant_id, r.status])).toEqual([
      ["p_a", "idle"],
      ["p_b", "active"],
    ]);
    m = applyPresence(m, { snapshot: [rec("p_c", "2026-01-01T00:00:30Z")] });
    expect([...m.keys()]).toEqual(["p_c"]);
  });

  it("drops expired records, keeping the same map when nothing expired", () => {
    const m = applyPresence(new Map(), {
      snapshot: [rec("p_a", "2026-01-01T00:00:10Z"), rec("p_b", "2026-01-01T00:00:20Z")],
    });
    expect(livePresence(m, Date.parse("2026-01-01T00:00:05Z"))).toBe(m);
    expect([...livePresence(m, Date.parse("2026-01-01T00:00:10Z")).keys()]).toEqual(["p_b"]);
  });

  it("cursors on a file: everyone else's, with a stable colour and their selection", () => {
    const sel = { start_line: 2, start_column: 1, end_line: 3, end_column: 4 };
    const m = applyPresence(new Map(), {
      snapshot: [
        rec("p_me", "2026-01-01T00:00:10Z", {
          open_files: ["a.ts"],
          cursor: { path: "a.ts", line: 1, column: 1 },
        }),
        rec("p_b", "2026-01-01T00:00:10Z", {
          open_files: ["a.ts"],
          cursor: { path: "a.ts", line: 3, column: 4, selection: sel },
        }),
        rec("p_c", "2026-01-01T00:00:10Z", {
          open_files: ["a.ts", "b.ts"],
          cursor: { path: "b.ts", line: 1, column: 1 },
        }),
      ],
    });
    expect(cursorsOn(m, "a.ts", "p_me", (id) => id.toUpperCase())).toEqual([
      {
        participant_id: "p_b",
        name: "P_B",
        color: colorOf("p_b"),
        line: 3,
        column: 4,
        selection: sel,
      },
    ]);
    expect(viewersByPath(m, "p_me")).toEqual(
      new Map([
        ["a.ts", ["p_b", "p_c"]],
        ["b.ts", ["p_c"]],
      ]),
    );
    expect(colorOf("p_b")).toBe(colorOf("p_b"));
    for (const id of ["p_a", "part_x", ""]) expect(colorOf(id)).toBeLessThan(PRESENCE_COLORS);
  });
});

describe("PresenceSender", () => {
  beforeEach(() => vi.useFakeTimers({ now: 0 }));
  afterEach(() => vi.useRealTimers());

  const value = (line: number): OwnPresence => ({
    status: "active",
    open_files: ["a.ts"],
    cursor: { path: "a.ts", line, column: 1 },
  });

  it("coalesces cursor moves to one send per interval, the latest each time, and heartbeats", async () => {
    const sent: OwnPresence[] = [];
    const sender = new PresenceSender(async (v) => void sent.push(v), Date.now);
    sender.set(value(1));
    sender.set(value(2));
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.map((v) => v.cursor?.line)).toEqual([2]);
    for (let line = 3; line < 10; line++) sender.set(value(line));
    await vi.advanceTimersByTimeAsync(MIN_INTERVAL_MS - 1);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent.map((v) => v.cursor?.line)).toEqual([2, 9]);
    // Nothing moves: the same record again before it can expire.
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(sent.map((v) => v.cursor?.line)).toEqual([2, 9, 9]);
    sender.stop({ status: "active", open_files: [], cursor: null });
    expect(sent.at(-1)).toEqual({ status: "active", open_files: [], cursor: null });
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
    sender.set(value(1));
    await vi.advanceTimersByTimeAsync(MIN_INTERVAL_MS);
    expect(sent).toHaveLength(4);
  });

  it("keeps the last 20 open files, drops a cursor on one it dropped, and retries a failed send", async () => {
    const sent: OwnPresence[] = [];
    let fail = true;
    const sender = new PresenceSender(async (v) => {
      if (fail) throw new Error("rate limited");
      sent.push(v);
    });
    const files = Array.from({ length: 25 }, (_, i) => `f${i}.ts`);
    sender.set({
      status: "active",
      open_files: files,
      cursor: { path: "f0.ts", line: 1, column: 1 },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual([]);
    fail = false;
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(sent).toEqual([{ status: "active", open_files: files.slice(5), cursor: null }]);
    sender.stop();
  });
});

const intent = (
  participant_id: string,
  expires_at: string,
  task_id: string | null = null,
): PresenceIntent => ({
  participant_id,
  paths: ["src/notes.txt"],
  ranges: [{ path: "src/notes.txt", start_line: 2, end_line: 4 }],
  task_id,
  expires_at,
});

describe("live editor intents", () => {
  it("replaces the snapshot and drops expired intents locally", () => {
    const active = intent("pair", "2026-10-12T12:00:00.000Z");
    const expired = intent("old", "2026-10-12T11:59:59.000Z");
    const snapshot = applyIntentSnapshot([active, expired]);

    expect(liveIntents(snapshot, Date.parse("2026-10-12T11:59:59.500Z"))).toEqual(
      new Map([["pair", active]]),
    );
    const fresh = applyIntentSnapshot([active]);
    expect(liveIntents(fresh, Date.parse("2026-10-12T11:00:00Z"))).toBe(fresh);
  });

  it("labels another participant's ranges with their task and stable color", () => {
    const intents: IntentMap = applyIntentSnapshot([intent("pair", "2026-10-12T12:00:00Z", "t1")]);

    expect(
      intentRangesOn(
        intents,
        "src/notes.txt",
        "self",
        () => "Pair",
        () => "Edit notes",
      ),
    ).toEqual([
      {
        participant_id: "pair",
        name: "Pair",
        color: colorOf("pair"),
        whole_file: false,
        start_line: 2,
        end_line: 4,
        label: "Pair · Edit notes",
      },
    ]);
    expect(
      intentRangesOn(
        intents,
        "src/other.txt",
        "self",
        () => "Pair",
        () => "Edit notes",
      ),
    ).toEqual([]);
    expect(
      intentRangesOn(
        intents,
        "src/notes.txt",
        "pair",
        () => "Pair",
        () => "Edit notes",
      ),
    ).toEqual([]);
  });

  it("lists a path-only intent as a whole-file intent", () => {
    const intents: IntentMap = applyIntentSnapshot([
      {
        participant_id: "pair",
        paths: ["src/notes.txt"],
        ranges: [],
        task_id: null,
        expires_at: "2026-10-12T12:00:00Z",
      },
    ]);

    expect(
      intentRangesOn(
        intents,
        "src/notes.txt",
        "self",
        () => "Pair",
        () => undefined,
      ),
    ).toEqual([
      {
        participant_id: "pair",
        name: "Pair",
        color: colorOf("pair"),
        whole_file: true,
        start_line: 0,
        end_line: 0,
        label: "Pair · Active edit",
      },
    ]);
  });
});
