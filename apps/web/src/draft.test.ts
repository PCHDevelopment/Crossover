import { describe, expect, it } from "vitest";
import {
  applyIncoming,
  CONTINUOUS_FLUSH_MS,
  edit,
  flushDue,
  flushed,
  flushParams,
  IDLE_FLUSH_MS,
  isDirty,
  MAX_MERGE_LINES,
  merge3,
  mergeRegions,
  nextFlushAt,
  openDraft,
  resolveRegions,
} from "./draft.js";

describe("draft flushing (§13.2)", () => {
  it("flushes after 1.5 s without typing, or after 10 s of continuous typing", () => {
    let d = edit(openDraft("a.ts", 3, "x\n", 30), "xy\n", 1_000);
    expect(isDirty(d)).toBe(true);
    expect(flushDue(d, 1_000 + IDLE_FLUSH_MS - 1)).toBe(false);
    expect(flushDue(d, 1_000 + IDLE_FLUSH_MS)).toBe(true);
    // Typing every second never goes idle, but 10 s after the first edit it flushes anyway.
    d = openDraft("a.ts", 3, "x\n", 30);
    for (let t = 0; t < CONTINUOUS_FLUSH_MS; t += 1_000) {
      d = edit(d, `x${t}\n`, t);
      expect(flushDue(d, t)).toBe(false);
    }
    expect(flushDue(d, CONTINUOUS_FLUSH_MS)).toBe(true);
    expect(nextFlushAt(d)).toBe(CONTINUOUS_FLUSH_MS);
  });

  it("a clean buffer, or one typed back to canonical, has nothing to flush", () => {
    const d = openDraft("a.ts", 1, "same", 10);
    expect(flushDue(d, 99_999)).toBe(false);
    const back = edit(edit(d, "other", 0), "same", 10);
    expect(isDirty(back)).toBe(false);
    expect(flushDue(back, 99_999)).toBe(false);
    expect(nextFlushAt(back)).toBeUndefined();
  });

  it("a flush is an EDITOR ChangeSet based on the workspace revision the buffer's base was read at", () => {
    const d = edit(openDraft("src/a.ts", 7, "old", 70), "new", 0);
    expect(flushParams(d)).toEqual({
      source: "EDITOR",
      message: "Edit src/a.ts",
      base_workspace_revision: 70,
      base_file_revisions: { "src/a.ts": 7 },
      operations: [{ type: "modify", path: "src/a.ts", content: "new" }],
    });
  });

  it("edits typed while a flush was in flight stay in the draft, now based on what was sent", () => {
    let d = edit(openDraft("a.ts", 1, "a", 10), "ab", 0);
    const sent = d.text;
    d = edit(d, "abc", 500); // typed after sending
    d = flushed(d, sent, 2, 25);
    expect(d).toMatchObject({ base: "ab", baseRevision: 2, baseWorkspace: 25, text: "abc" });
    expect(isDirty(d)).toBe(true);
    // …and they flush in turn, on the idle timer from the last keystroke.
    expect(flushDue(d, 500 + IDLE_FLUSH_MS - 1)).toBe(false);
    expect(flushDue(d, 500 + IDLE_FLUSH_MS)).toBe(true);
    // A fully flushed draft is clean.
    expect(isDirty(flushed(edit(openDraft("a.ts", 1, "a", 10), "ab", 0), "ab", 2, 25))).toBe(false);
  });
});

describe("incoming changes to an open file (§13.3)", () => {
  it("a clean buffer is replaced", () => {
    const r = applyIncoming(openDraft("a.ts", 1, "one", 10), "two", 2, 21);
    expect(r.outcome).toBe("replaced");
    expect(r.draft).toMatchObject({ text: "two", base: "two", baseRevision: 2, baseWorkspace: 21 });
  });

  it("a dirty buffer whose edits don't overlap is rebased silently", () => {
    const base = "a\nb\nc\nd\ne\n";
    const d = edit(openDraft("a.ts", 1, base, 10), "A\nb\nc\nd\ne\n", 0);
    const r = applyIncoming(d, "a\nb\nc\nd\nE\n", 2, 21);
    expect(r.outcome).toBe("rebased");
    expect(r.draft).toMatchObject({
      text: "A\nb\nc\nd\nE\n",
      base: "a\nb\nc\nd\nE\n",
      baseRevision: 2,
      baseWorkspace: 21,
    });
    expect(isDirty(r.draft)).toBe(true); // our line is still ours to flush
  });

  it("our own flush coming back before its response leaves a clean draft, with no stale edit times", () => {
    const d = edit(openDraft("a.ts", 1, "a\n", 10), "a\nb\n", 1_000);
    const r = applyIncoming(d, "a\nb\n", 2, 21);
    expect(r.outcome).toBe("rebased");
    expect(isDirty(r.draft)).toBe(false);
    expect(r.draft.firstEditAt).toBeUndefined();
    // The next keystroke starts a fresh 10 s window, not one from the earlier edits.
    expect(flushDue(edit(r.draft, "a\nb\nc\n", 20_000), 20_000)).toBe(false);
  });

  it("a dirty buffer that overlaps is kept as is and marked conflicted", () => {
    const d = edit(openDraft("a.ts", 1, "a\nb\nc\n", 10), "a\nmine\nc\n", 0);
    const r = applyIncoming(d, "a\ntheirs\nc\n", 2, 21);
    expect(r.outcome).toBe("conflict");
    // Still based where it was: its flush must merge from there and come back as a Conflict.
    expect(r.draft).toMatchObject({
      text: "a\nmine\nc\n",
      baseRevision: 1,
      baseWorkspace: 10,
      conflicted: true,
    });
    expect(flushParams(r.draft).base_workspace_revision).toBe(10);
  });

  it("an older or same revision changes nothing", () => {
    const d = openDraft("a.ts", 5, "x", 50);
    expect(applyIncoming(d, "y", 5, 51).outcome).toBe("unchanged");
    expect(applyIncoming(d, "y", 4, 41).outcome).toBe("unchanged");
  });
});

describe("merge3", () => {
  it("handles the trivial cases and refuses huge inputs", () => {
    expect(merge3("a", "a", "b")).toEqual({ clean: true, text: "b" });
    expect(merge3("a", "b", "a")).toEqual({ clean: true, text: "b" });
    expect(merge3("a", "b", "b")).toEqual({ clean: true, text: "b" });
    const huge = "x\n".repeat(25_000);
    expect(merge3(huge, `${huge}y`, `z${huge}`)).toEqual({ clean: false });
  });
});

describe("merge regions for the merge view (T1105c)", () => {
  const base = "a\nb\nc\nd\ne";
  const ours = "a\nB-ours\nc\nd\nE";
  const theirs = "A\nB-theirs\nc\nd\ne";

  it("keeps settled lines merged and both sides of a region changed differently", () => {
    expect(mergeRegions(base, ours, theirs)).toEqual([
      { kind: "conflict", base: ["a", "b"], ours: ["a", "B-ours"], theirs: ["A", "B-theirs"] },
      { kind: "merged", lines: ["c", "d", "E"] },
    ]);
    expect(mergeRegions("x", "y", "y")).toEqual([{ kind: "merged", lines: ["y"] }]);
    const huge = Array.from({ length: MAX_MERGE_LINES + 1 }, (_, i) => `${i}`).join("\n");
    expect(mergeRegions(huge, `${huge}\nx`, `y\n${huge}`)).toBeUndefined();
  });

  it("resolves each conflict as chosen, ours by default, and agrees with merge3 when clean", () => {
    const regions = mergeRegions(base, ours, theirs)!;
    expect(resolveRegions(regions, [])).toBe("a\nB-ours\nc\nd\nE");
    expect(resolveRegions(regions, ["theirs"])).toBe("A\nB-theirs\nc\nd\nE");
    expect(resolveRegions(regions, ["both"])).toBe("a\nB-ours\nA\nB-theirs\nc\nd\nE");
    const clean = mergeRegions("a\nb\nc", "A\nb\nc", "a\nb\nC")!;
    expect(resolveRegions(clean, [])).toBe("A\nb\nC");
    expect(merge3("a\nb\nc", "A\nb\nc", "a\nb\nC")).toEqual({ clean: true, text: "A\nb\nC" });
  });
});
