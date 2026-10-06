import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, GitError } from "./git.js";

export interface LineRange {
  start: number;
  end: number;
}
export interface ConflictHunk {
  base: string;
  ours: string;
  theirs: string;
  baseRange: LineRange;
  oursRange: LineRange;
  theirsRange: LineRange;
}
const lines = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

async function output(args: string[], cwd: string, maxConflictExit: number): Promise<string> {
  try {
    return (await git(args, { cwd, timeoutMs: 10_000 })).stdout;
  } catch (error) {
    if (
      !(error instanceof GitError) ||
      error.exitCode === null ||
      error.exitCode < 1 ||
      error.exitCode > maxConflictExit ||
      error.signal !== null ||
      error.timedOut
    )
      throw error;
    return typeof error.stdout === "string" ? error.stdout : error.stdout.toString("utf8");
  }
}

/** Map projected merge positions to original blobs, including earlier clean edits. */
async function mapPositions(
  original: string,
  projection: string[],
  positions: LineRange[],
  dir: string,
  side: string,
): Promise<LineRange[]> {
  const from = join(dir, `${side}-original`),
    to = join(dir, `${side}-projection`);
  await Promise.all([writeFile(from, original), writeFile(to, projection.join(""))]);
  const diff = await output(
    [
      "diff",
      "--no-index",
      "--no-ext-diff",
      "--no-textconv",
      "--text",
      "--no-color",
      "--unified=0",
      "--",
      from,
      to,
    ],
    dir,
    1,
  );
  const edits = [...diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map((match) => {
    const oldCount = Number(match[2] ?? 1),
      newCount = Number(match[4] ?? 1);
    return {
      oldStart: Number(match[1]) - (oldCount ? 1 : 0),
      oldCount,
      newStart: Number(match[3]) - (newCount ? 1 : 0),
      newCount,
    };
  });
  const map = (position: number): number => {
    let delta = 0;
    for (const edit of edits) {
      if (position < edit.newStart) break;
      if (position < edit.newStart + edit.newCount)
        return edit.oldStart + Math.min(position - edit.newStart, edit.oldCount);
      delta = edit.newStart + edit.newCount - edit.oldStart - edit.oldCount;
    }
    return position - delta;
  };
  return positions.map(({ start, end }) => ({ start: map(start) + 1, end: map(end) + 1 }));
}

/** Extract UTF-8 diff3 hunks with 1-based half-open ranges (§11.1). */
export async function extractHunks(
  base: string,
  ours: string,
  theirs: string,
): Promise<ConflictHunk[]> {
  const originals = [base, ours, theirs];
  // Marker runs longer than any input run cannot collide with literal source lines.
  let size = 7;
  for (const text of originals) {
    for (const match of text.matchAll(/^[<>=|]+/gm)) size = Math.max(size, match[0].length + 1);
  }
  const dir = await mkdtemp(join(tmpdir(), "crossover-hunks-"));
  try {
    const paths = ["base", "ours", "theirs"].map((name) => join(dir, name));
    await Promise.all(paths.map((path, index) => writeFile(path, originals[index]!)));
    const merged = await output(
      [
        "merge-file",
        "-p",
        "--diff3",
        `--marker-size=${size}`,
        "-L",
        "ours",
        "-L",
        "base",
        "-L",
        "theirs",
        "--",
        paths[1]!,
        paths[0]!,
        paths[2]!,
      ],
      dir,
      127,
    );
    const tokens = lines(merged);
    const projections: string[][] = [[], [], []];
    const positions: LineRange[][] = [[], [], []];
    let index = 0;
    const marker = (character: string, label = "") =>
      character.repeat(size) + (label ? ` ${label}` : "");
    const isMarker = (line: string | undefined, value: string) =>
      line?.replace(/\r?\n$/, "") === value;
    while (index < tokens.length) {
      if (!isMarker(tokens[index], marker("<", "ours"))) {
        projections.forEach((projection) => projection.push(tokens[index]!));
        index += 1;
        continue;
      }
      index += 1;
      const blocks: string[][] = [];
      for (const boundary of [marker("|", "base"), marker("="), marker(">", "theirs")]) {
        const block: string[] = [];
        while (index < tokens.length && !isMarker(tokens[index], boundary))
          block.push(tokens[index++]!);
        if (index === tokens.length) throw new GitError("Malformed merge-file markers", 1, "");
        index += 1;
        blocks.push(block);
      }
      [blocks[1]!, blocks[0]!, blocks[2]!].forEach((block, side) => {
        const start = projections[side]!.length;
        for (const line of block) projections[side]!.push(line);
        positions[side]!.push({ start, end: projections[side]!.length });
      });
    }
    const ranges = await Promise.all(
      originals.map((original, side) =>
        mapPositions(original, projections[side]!, positions[side]!, dir, String(side)),
      ),
    );
    const text = originals.map(lines);
    return positions[0]!.map((_, index) => {
      const [baseRange, oursRange, theirsRange] = ranges.map((side) => side[index]!);
      const slice = (side: number, range: LineRange) =>
        text[side]!.slice(range.start - 1, range.end - 1).join("");
      return {
        base: slice(0, baseRange!),
        ours: slice(1, oursRange!),
        theirs: slice(2, theirsRange!),
        baseRange: baseRange!,
        oursRange: oursRange!,
        theirsRange: theirsRange!,
      };
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
