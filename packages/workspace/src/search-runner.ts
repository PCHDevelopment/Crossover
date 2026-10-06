import { spawn } from "node:child_process";
import { CrossoverError } from "@crossover/protocol";

export type SearchOptions = {
  query: string;
  regex: boolean;
  case_sensitive: boolean;
  glob?: string;
};
export type SearchMatch = { path: string; line: number; text: string };

/** Stream JSON with backpressure; callback false stops the child once public limits are reached. */
export async function runSearch(
  tree: string,
  options: SearchOptions,
  match: (value: SearchMatch) => Promise<boolean>,
): Promise<{ truncated: boolean }> {
  const args = [
    "--json",
    "--no-config",
    "--hidden",
    "--no-ignore",
    "--threads=1",
    ...(options.regex ? [] : ["--fixed-strings"]),
    options.case_sensitive ? "--case-sensitive" : "--ignore-case",
    ...(options.glob === undefined ? [] : ["--glob", options.glob]),
    "--",
    options.query,
    ".",
  ];
  const child = spawn("rg", args, { cwd: tree, stdio: ["ignore", "pipe", "pipe"] });
  let timedOut = false;
  let truncated = false;
  let stderr = "";
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, 10_000);
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderr.length < 8192) stderr += chunk.toString();
  });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  // Observe spawn errors even if an asynchronous authorization callback throws first.
  void closed.catch(() => {});
  let record = "";
  child.stdout.setEncoding("utf8");
  try {
    outer: for await (const chunk of child.stdout) {
      record += chunk as string;
      // Bound a pathological JSON record (e.g. millions of submatches in a minified line).
      if (Buffer.byteLength(record) > 32 * 1024 * 1024) {
        truncated = true;
        break;
      }
      let newline: number;
      while ((newline = record.indexOf("\n")) !== -1) {
        const message = JSON.parse(record.slice(0, newline)) as {
          type: string;
          data: { path?: { text?: string }; lines?: { text?: string }; line_number?: number };
        };
        record = record.slice(newline + 1);
        if (
          message.type !== "match" ||
          message.data.path?.text === undefined ||
          message.data.lines?.text === undefined ||
          message.data.line_number === undefined
        )
          continue;
        if (
          !(await match({
            path: message.data.path.text.replace(/^\.\//, ""),
            line: message.data.line_number,
            text: message.data.lines.text.replace(/\r?\n$/, ""),
          }))
        ) {
          truncated = true;
          break outer;
        }
      }
    }
    if (truncated) child.kill("SIGKILL");
    const code = await closed;
    if (timedOut)
      throw new CrossoverError("VALIDATION", "Search timed out", {
        details: { reason: "search_timeout" },
      });
    if (!truncated && code !== 0 && code !== 1)
      throw new CrossoverError("VALIDATION", "Invalid search", {
        details: { reason: "invalid_search", diagnostic: stderr.slice(0, 8192) },
      });
    return { truncated };
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");
    await closed.catch(() => {});
  }
}
