import { spawn } from "node:child_process";
import { once } from "node:events";
import type { Writable } from "node:stream";
import { git } from "./git.js";

/** Seeded PRNG (mulberry32): the fixture is the same bytes on every run. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SearchFixtureOptions {
  /** Bare repository that receives the objects. */
  repo: string;
  /** Commit the fixture commit is built on. */
  parent: string;
  /** Regular files; 50,000 is the §3 working-tree limit. */
  files: number;
  /** Size of each of the 10 single-line files. */
  bigBytes: number;
  seed?: number;
}

export interface SearchFixture {
  commit: string;
  tree: string;
  paths: string[];
  bytes: number;
  vocabulary: string[];
}

const VOCABULARY = 5_000;
const MEAN_KIB = 20;
const RARE_TOKENS = 10;
const RARE_FILES = 3;
const COMMON_LINES = 1_000;

function sample(random: () => number, count: number, of: number): Set<number> {
  const chosen = new Set<number>();
  while (chosen.size < Math.min(count, of)) chosen.add(Math.floor(random() * of));
  return chosen;
}

/**
 * Build the search-benchmark tree with `git fast-import`: `src/m<0..199>/f<0..249>.ts` (every
 * twentieth slot is a `docs/**.md`), `rare_token_<k>` in exactly three files each, `common_word`
 * on about a thousand lines, and ten single-line `big/` files. Nothing is written to a work tree.
 */
export async function buildSearchFixture(options: SearchFixtureOptions): Promise<SearchFixture> {
  const random = prng(options.seed ?? 1583);
  const words = new Set<string>();
  while (words.size < VOCABULARY) {
    let word = "";
    for (let i = 5 + Math.floor(random() * 7); i > 0; i--)
      word += String.fromCharCode(97 + Math.floor(random() * 26));
    words.add(word);
  }
  const vocabulary = [...words];
  const rare = sample(random, RARE_TOKENS * RARE_FILES, options.files);
  const rareFiles = new Map<number, number>();
  [...rare].forEach((file, index) => rareFiles.set(file, Math.floor(index / RARE_FILES)));
  const common = sample(random, COMMON_LINES, options.files);

  const paths: string[] = [];
  const child = spawn("git", ["--git-dir", options.repo, "fast-import", "--quiet"], {
    stdio: ["pipe", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const closed = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`git fast-import exited ${code}: ${stderr}`)),
    );
  });
  closed.catch(() => {});
  // A write after fast-import exited is reported by `closed` with git's own stderr, not as EPIPE.
  child.stdin.on("error", () => {});
  const send = async (stream: Writable, chunk: Buffer | string): Promise<void> => {
    if (stream.write(chunk)) return;
    await Promise.race([
      once(stream, "drain"),
      closed.then(() => Promise.reject(new Error("git fast-import exited while it was being fed"))),
    ]);
  };
  let bytes = 0;
  let mark = 0;
  const blob = async (path: string, content: string): Promise<void> => {
    const data = Buffer.from(content);
    await send(child.stdin, `blob\nmark :${++mark}\ndata ${data.length}\n`);
    await send(child.stdin, data);
    await send(child.stdin, "\n");
    paths.push(path);
    bytes += data.length;
  };
  const line = (): string => {
    let text = "";
    for (let count = 6 + Math.floor(random() * 9); count > 0; count--) {
      const word = vocabulary[Math.floor(random() * VOCABULARY)]!;
      if (text.length + word.length + 1 > 110) break;
      text += `${text ? " " : "  "}${word}`;
    }
    return text;
  };
  for (let index = 0; index < options.files; index++) {
    const slot = `m${Math.floor(index / 250)}/f${index % 250}`;
    const target = (MEAN_KIB / 2) * 1024 + Math.floor(random() * MEAN_KIB * 1024);
    const lines: string[] = [];
    let size = 0;
    while (size < target) {
      const text = line();
      lines.push(text);
      size += text.length + 1;
    }
    const token = rareFiles.get(index);
    if (token !== undefined)
      lines.splice(Math.floor(lines.length / 2), 0, `  const x = rare_token_${token};`);
    if (common.has(index)) lines.splice(Math.floor(lines.length / 3), 0, "  return common_word;");
    await blob(index % 20 === 0 ? `docs/${slot}.md` : `src/${slot}.ts`, `${lines.join("\n")}\n`);
  }
  for (let k = 0; k < 10; k++) {
    let text = "";
    while (text.length < options.bigBytes)
      text += `${vocabulary[Math.floor(random() * VOCABULARY)]!} `;
    await blob(`big/b${k}.txt`, `${text.slice(0, options.bigBytes - 1)}\n`);
  }

  const message = Buffer.from("Search benchmark fixture\n");
  const identity = "Bench <bench@example.test> 0 +0000";
  await send(
    child.stdin,
    `commit refs/bench/fixture\nauthor ${identity}\ncommitter ${identity}\ndata ${message.length}\n`,
  );
  await send(child.stdin, message);
  await send(child.stdin, `from ${options.parent}\ndeleteall\n`);
  for (let i = 0; i < paths.length; i++)
    await send(child.stdin, `M 100644 :${i + 1} ${paths[i]}\n`);
  child.stdin.end();
  await closed;

  const gitDir = { gitDir: options.repo, timeoutMs: 30_000 };
  const commit = (await git(["rev-parse", "refs/bench/fixture"], gitDir)).stdout.trim();
  const tree = (await git(["rev-parse", `${commit}^{tree}`], gitDir)).stdout.trim();
  await git(["update-ref", "-d", "refs/bench/fixture"], gitDir);
  return { commit, tree, paths, bytes, vocabulary };
}
