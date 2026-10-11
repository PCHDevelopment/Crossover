// Runs under Node (tsconfig.node-tests.json): compares the browser merge with Git's.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { merge3 } from "./draft.js";

describe("merge3 against Git", () => {
  it("agrees with `git merge-file` whenever it calls a merge clean (randomized)", () => {
    const dir = mkdtempSync(join(tmpdir(), "merge3-"));
    try {
      let seed = 12345;
      const rand = (n: number) => {
        seed = (seed * 1103515245 + 12345) % 2 ** 31;
        return seed % n;
      };
      const mutate = (lines: string[], tag: string) => {
        const out = [...lines];
        const edits = 1 + rand(3);
        for (let e = 0; e < edits; e++) {
          const at = rand(out.length + 1);
          const op = rand(3);
          if (op === 0) out.splice(at, 0, `${tag}${rand(100)}`);
          else if (op === 1 && out.length > 0) out.splice(Math.min(at, out.length - 1), 1);
          else if (out.length > 0) out[Math.min(at, out.length - 1)] = `${tag}${rand(100)}`;
        }
        return out;
      };
      let cleanCount = 0;
      for (let round = 0; round < 200; round++) {
        const base = Array.from({ length: 4 + rand(12) }, (_, i) => `line${i}`);
        const ours = mutate(base, "o");
        const theirs = mutate(base, "t");
        const text = (lines: string[]) => `${lines.join("\n")}\n`;
        const mine = merge3(text(base), text(ours), text(theirs));
        writeFileSync(join(dir, "base"), text(base));
        writeFileSync(join(dir, "ours"), text(ours));
        writeFileSync(join(dir, "theirs"), text(theirs));
        let gitClean = true;
        try {
          execFileSync(
            "git",
            ["merge-file", join(dir, "ours"), join(dir, "base"), join(dir, "theirs")],
            {
              stdio: "ignore",
            },
          );
        } catch {
          gitClean = false;
        }
        if (mine.clean) {
          cleanCount++;
          // Never claim a clean merge Git would call a conflict, and produce the same text.
          expect(gitClean, `round ${round}`).toBe(true);
          expect(mine.text, `round ${round}`).toBe(readFileSync(join(dir, "ours"), "utf8"));
        }
      }
      expect(cleanCount).toBeGreaterThan(20); // the comparison actually exercised clean merges
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
