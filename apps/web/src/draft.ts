/**
 * Editor drafts (§13, T1105a): an open file's buffer is local and non-authoritative until it is
 * flushed as a ChangeSet (`source = EDITOR`). This module is the draft's state machine, free of
 * any UI: when a flush is due, what it sends, and what happens when someone else's change lands
 * on a file that is open here. The editor component drives it.
 */

/** No typing for this long flushes the draft (§13.2). */
export const IDLE_FLUSH_MS = 1_500;
/** Typing without a pause for this long flushes anyway, so flushes stay small (§13.2). */
export const CONTINUOUS_FLUSH_MS = 10_000;
/** Past this many lines on any side, the browser doesn't attempt a merge: it reports a conflict. */
export const MAX_MERGE_LINES = 20_000;

export interface Draft {
  path: string;
  /** The file revision the buffer is based on (`base_file_revisions` when flushing). */
  baseRevision: number;
  /** Canonical content at `baseRevision`. */
  base: string;
  /** The buffer. */
  text: string;
  /** When the first unflushed edit was made, and the latest one (ms). Undefined when clean. */
  firstEditAt?: number;
  lastEditAt?: number;
  /** Someone else's change couldn't be merged in: the next flush is expected to be a Conflict. */
  conflicted?: boolean;
}

export const openDraft = (path: string, baseRevision: number, content: string): Draft => ({
  path,
  baseRevision,
  base: content,
  text: content,
});

/** Unflushed edits exist (the UI's draft indicator). */
export const isDirty = (draft: Draft): boolean => draft.text !== draft.base;

/** The buffer changed at `now`. */
export function edit(draft: Draft, text: string, now: number): Draft {
  if (text === draft.base) {
    // Typed back to what is canonical: nothing to flush.
    const { firstEditAt: _first, lastEditAt: _last, ...clean } = draft;
    void _first;
    void _last;
    return { ...clean, text };
  }
  return { ...draft, text, firstEditAt: draft.firstEditAt ?? now, lastEditAt: now };
}

/**
 * A flush is due after `IDLE_FLUSH_MS` without typing or `CONTINUOUS_FLUSH_MS` of typing. Save,
 * switching files and closing the tab flush regardless (the caller decides those).
 */
export function flushDue(draft: Draft, now: number): boolean {
  if (!isDirty(draft) || draft.lastEditAt === undefined || draft.firstEditAt === undefined)
    return false;
  return now - draft.lastEditAt >= IDLE_FLUSH_MS || now - draft.firstEditAt >= CONTINUOUS_FLUSH_MS;
}

/** When the next flush becomes due, if the user stops typing now; undefined when clean. */
export function nextFlushAt(draft: Draft): number | undefined {
  if (!isDirty(draft) || draft.lastEditAt === undefined || draft.firstEditAt === undefined)
    return undefined;
  return Math.min(draft.lastEditAt + IDLE_FLUSH_MS, draft.firstEditAt + CONTINUOUS_FLUSH_MS);
}

/** The parameters of `workspace.apply_changeset` for this flush. */
export function flushParams(draft: Draft, baseWorkspaceRevision: number) {
  return {
    source: "EDITOR" as const,
    message: `Edit ${draft.path}`,
    base_workspace_revision: baseWorkspaceRevision,
    base_file_revisions: { [draft.path]: draft.baseRevision },
    operations: [{ type: "modify" as const, path: draft.path, content: draft.text }],
  };
}

/**
 * The flush of `sent` was applied as file revision `revision`. Edits typed after the flush was
 * sent stay in the buffer, now based on what was sent.
 */
export function flushed(draft: Draft, sent: string, revision: number): Draft {
  const { firstEditAt: _first, lastEditAt: _last, conflicted: _conflicted, ...rest } = draft;
  void _first;
  void _last;
  void _conflicted;
  const next: Draft = { ...rest, base: sent, baseRevision: revision };
  // Still typing: those edits are a new draft starting now (`lastEditAt` keeps the idle timer).
  return draft.text === sent || draft.lastEditAt === undefined
    ? next
    : { ...next, firstEditAt: draft.lastEditAt, lastEditAt: draft.lastEditAt };
}

export type IncomingOutcome = "unchanged" | "replaced" | "rebased" | "conflict";

/**
 * Someone else's ChangeSet changed this file to `content` at `revision` (§13.3). A clean buffer is
 * replaced; a dirty one is merged three-way in the browser: if it merges cleanly the buffer is
 * rebased onto the new base, otherwise the buffer is kept as is, marked conflicted, and the next
 * flush is expected to come back as a Conflict (which opens the merge view, T1105c).
 */
export function applyIncoming(
  draft: Draft,
  content: string,
  revision: number,
): { draft: Draft; outcome: IncomingOutcome } {
  if (revision <= draft.baseRevision) return { draft, outcome: "unchanged" };
  if (!isDirty(draft)) {
    return { draft: { ...openDraft(draft.path, revision, content) }, outcome: "replaced" };
  }
  const merged = merge3(draft.base, draft.text, content);
  if (!merged.clean) return { draft: { ...draft, conflicted: true }, outcome: "conflict" };
  return {
    draft: {
      ...draft,
      base: content,
      baseRevision: revision,
      text: merged.text,
      conflicted: false,
    },
    outcome: "rebased",
  };
}

// ---------------------------------------------------------------------------------------------
// Three-way merge of lines (diff3), as the server's apply pipeline does with Git.

type Match = [baseIndex: number, otherIndex: number];

/** Pairs of equal lines along a shortest edit script (Myers), in order. */
function commonLines(a: readonly string[], b: readonly string[]): Match[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
          ? v[offset + k + 1]!
          : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }
  // Walk the trace back from the end, collecting the diagonal (equal) steps.
  const matches: Match[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const prev = trace[d]!;
    const k = x - y;
    const prevK =
      k === -d || (k !== d && prev[offset + k - 1]! < prev[offset + k + 1]!) ? k + 1 : k - 1;
    const prevX = prev[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) matches.push([--x, --y]);
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) matches.push([--x, --y]);
  return matches.reverse();
}

/**
 * Merge `ours` and `theirs`, both edited from `base`. Clean when every region that both sides
 * changed was changed the same way; otherwise not clean (the caller keeps `ours` and reports a
 * conflict, never a half-merged buffer).
 */
export function merge3(
  base: string,
  ours: string,
  theirs: string,
): { clean: true; text: string } | { clean: false } {
  if (ours === theirs) return { clean: true, text: ours };
  if (ours === base) return { clean: true, text: theirs };
  if (theirs === base) return { clean: true, text: ours };
  const o = base.split("\n");
  const a = ours.split("\n");
  const b = theirs.split("\n");
  if (Math.max(o.length, a.length, b.length) > MAX_MERGE_LINES) return { clean: false };

  // Base lines kept, unchanged, by each side: base index → that side's index.
  const inA = new Map(commonLines(o, a));
  const inB = new Map(commonLines(o, b));
  const out: string[] = [];
  let oi = 0;
  let ai = 0;
  let bi = 0;
  const flushChunk = (oEnd: number, aEnd: number, bEnd: number): boolean => {
    const oChunk = o.slice(oi, oEnd);
    const aChunk = a.slice(ai, aEnd);
    const bChunk = b.slice(bi, bEnd);
    const same = (x: string[], y: string[]) =>
      x.length === y.length && x.every((line, i) => line === y[i]);
    if (same(aChunk, oChunk)) out.push(...bChunk);
    else if (same(bChunk, oChunk) || same(aChunk, bChunk)) out.push(...aChunk);
    else return false; // both changed this region differently
    oi = oEnd;
    ai = aEnd;
    bi = bEnd;
    return true;
  };
  // Stable lines: kept by both sides. Between two stable lines, each side's chunk is merged.
  for (let index = 0; index < o.length; index++) {
    const aIndex = inA.get(index);
    const bIndex = inB.get(index);
    if (aIndex === undefined || bIndex === undefined) continue;
    if (aIndex < ai || bIndex < bi) continue;
    if (!flushChunk(index, aIndex, bIndex)) return { clean: false };
    out.push(o[index]!);
    oi = index + 1;
    ai = aIndex + 1;
    bi = bIndex + 1;
  }
  if (!flushChunk(o.length, a.length, b.length)) return { clean: false };
  return { clean: true, text: out.join("\n") };
}
