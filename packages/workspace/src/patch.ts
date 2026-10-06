import { CrossoverError } from "@crossover/protocol";
import { git, GitError } from "./git.js";
import type { GitOptions } from "./git.js";

function mismatch(path: string): never {
  throw new CrossoverError("VALIDATION", `Patch must only modify ${path}`, {
    details: { path, reason: "patch_path_mismatch" },
  });
}

function headerPath(header: string, path: string): string {
  if (!header.startsWith('"')) return header.split("\t")[0]!;
  const quoted = /^"((?:\\.|[^"\\])*)"/.exec(header);
  if (!quoted) return mismatch(path);
  const chunks: Buffer[] = [];
  const escapes: Record<string, number> = {
    a: 7,
    b: 8,
    f: 12,
    n: 10,
    r: 13,
    t: 9,
    v: 11,
    '"': 34,
    "\\": 92,
  };
  for (const token of quoted[1]!.matchAll(/\\([0-7]{1,3}|.)|([^\\]+)/g)) {
    if (token[2] !== undefined) chunks.push(Buffer.from(token[2]));
    else {
      const escape = token[1]!;
      const byte = /^[0-7]+$/.test(escape) ? parseInt(escape, 8) : escapes[escape];
      if (byte === undefined || byte > 255) return mismatch(path);
      chunks.push(Buffer.from([byte]));
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function patchFailure(path: string, error: GitError): never {
  throw new CrossoverError("VALIDATION", `Patch does not apply to ${path}`, {
    details: { path, reason: "patch_failed", message: error.stderr },
    cause: error,
  });
}

/** Parse with Git and check both file headers before touching the temporary index. */
export async function validatePatch(
  path: string,
  patch: string,
  options: GitOptions,
): Promise<void> {
  let summary: string;
  try {
    summary = (
      await git(["apply", "--numstat", "--summary", "-z", "--", "-"], {
        ...options,
        encoding: "utf8",
        input: patch,
      })
    ).stdout;
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    patchFailure(path, error);
  }
  const records = summary.split("\0");
  if (
    records.length !== 2 ||
    records[1] !== "" ||
    records[0]!.split("\t").slice(2).join("\t") !== path
  )
    mismatch(path);
  // Hunk payload can itself contain ---/+++ lines, so count it before reading headers.
  let remaining = 0;
  let headers = 0;
  for (const line of patch.split("\n")) {
    if (remaining > 0) {
      if (line.startsWith(" ")) remaining -= 2;
      else if (line.startsWith("+") || line.startsWith("-")) remaining -= 1;
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      remaining = Number(hunk[1] ?? 1) + Number(hunk[2] ?? 1);
    } else if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      const name = headerPath(line.slice(4), path);
      const slash = name.indexOf("/");
      if (name === "/dev/null" || slash < 0 || name.slice(slash + 1) !== path) mismatch(path);
      headers += 1;
    }
  }
  if (headers !== 2) mismatch(path);
}
