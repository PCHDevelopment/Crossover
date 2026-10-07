import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { git } from "./git.js";
import type { MergeResult } from "./merge.js";
import { treeChanges } from "./tree-changes.js";

type SyntaxTree = { rootNode: { hasError: boolean }; delete(): void };
type Language = unknown;
type ParserInstance = {
  setLanguage(language: Language): void;
  parse(source: string): SyntaxTree;
  delete(): void;
};
type TreeSitterRuntime = {
  init(options: { locateFile: (file: string, folder: string) => string }): Promise<void>;
  new (): ParserInstance;
};
type TreeSitterModule = { Parser: TreeSitterRuntime };

const require = createRequire(import.meta.url);
const wasmEntry = require.resolve("@vscode/tree-sitter-wasm");
const wasmDirectory = dirname(wasmEntry);
const treeSitterModule = require("@vscode/tree-sitter-wasm") as TreeSitterModule & {
  Language: { load(path: string): Promise<Language> };
};
const TreeSitter = treeSitterModule.Parser;
const parserReady = TreeSitter.init({ locateFile: (file) => join(wasmDirectory, file) });
const grammarFiles: Record<string, string> = {
  javascript: "tree-sitter-javascript.wasm",
  python: "tree-sitter-python.wasm",
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
};
const languages = new Map<string, Promise<Language>>();

function grammarFor(path: string): string | undefined {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (["js", "jsx", "mjs", "cjs"].includes(extension)) return "javascript";
  if (["ts", "mts", "cts"].includes(extension)) return "typescript";
  if (extension === "tsx") return "tsx";
  if (extension === "py") return "python";
  return undefined;
}

async function languageFor(grammar: string): Promise<Language> {
  await parserReady;
  let language = languages.get(grammar);
  if (!language) {
    language = treeSitterModule.Language.load(join(wasmDirectory, grammarFiles[grammar]!));
    languages.set(grammar, language);
  }
  return language;
}

async function blobsAt(
  repo: string,
  tree: string,
  paths: readonly string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (let offset = 0; offset < paths.length; offset += 32) {
    const batch = paths.slice(offset, offset + 32);
    const { stdout } = await git(["ls-tree", "-rz", "--full-tree", tree, "--", ...batch], {
      gitDir: repo,
      timeoutMs: 10_000,
      env: { GIT_LITERAL_PATHSPECS: "1" },
    });
    for (const record of stdout.split("\0")) {
      if (!record) continue;
      const tab = record.indexOf("\t");
      const [mode, type, oid] = record.slice(0, tab).split(" ");
      const path = record.slice(tab + 1);
      if (type === "blob" && (mode === "100644" || mode === "100755") && oid) result.set(path, oid);
    }
  }
  return result;
}

async function readBlobs(repo: string, oids: readonly string[]): Promise<Map<string, Buffer>> {
  const unique = [...new Set(oids)];
  const sizes = new Map<string, number>();
  if (unique.length) {
    const { stdout } = await git(["cat-file", "--batch-check"], {
      gitDir: repo,
      timeoutMs: 10_000,
      input: `${unique.join("\n")}\n`,
    });
    for (const line of stdout.trimEnd().split("\n")) {
      const [oid, type, sizeText] = line.split(" ");
      const size = Number(sizeText);
      if (oid && type === "blob" && Number.isSafeInteger(size)) sizes.set(oid, size);
    }
  }
  const contents = new Map<string, Buffer>();
  // Workspace files are capped at 25 MiB; larger imported blobs are not parsed here.
  const supported = unique.filter((oid) => (sizes.get(oid) ?? Infinity) <= 25 * 1024 * 1024);
  for (let offset = 0; offset < supported.length;) {
    let end = offset;
    let bytes = 0;
    while (
      end < supported.length &&
      (end === offset || bytes + sizes.get(supported[end]!)! <= 24 * 1024 * 1024)
    ) {
      bytes += sizes.get(supported[end]!)! + 128;
      end++;
    }
    const batch = supported.slice(offset, end);
    const { stdout } = await git(["cat-file", "--batch"], {
      gitDir: repo,
      timeoutMs: 10_000,
      input: `${batch.join("\n")}\n`,
      encoding: "buffer",
      maxBuffer: 32 * 1024 * 1024,
    });
    let cursor = 0;
    for (const expected of batch) {
      const newline = stdout.indexOf(0x0a, cursor);
      if (newline < 0) throw new Error("Malformed source blob batch");
      const [oid, type, sizeText] = stdout.subarray(cursor, newline).toString("ascii").split(" ");
      const size = Number(sizeText);
      const start = newline + 1;
      if (oid !== expected || type !== "blob" || size !== sizes.get(expected))
        throw new Error("Unexpected source blob batch result");
      contents.set(oid, stdout.subarray(start, start + size));
      cursor = start + size;
      if (stdout[cursor] !== 0x0a) throw new Error("Malformed source blob batch separator");
      cursor++;
    }
    offset = end;
  }
  return contents;
}

async function failsToParse(content: Buffer | undefined, grammar: string): Promise<boolean> {
  if (!content || content.includes(0)) return false;
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return false;
  }
  const parser = new TreeSitter();
  try {
    parser.setLanguage(await languageFor(grammar));
    const treeResult = parser.parse(source);
    try {
      return treeResult.rootNode.hasError;
    } finally {
      treeResult.delete();
    }
  } finally {
    parser.delete();
  }
}

/** Detect newly introduced syntax errors among source files changed by a clean merge (§10.3). */
export async function parseConflicts(
  repo: string,
  headCommit: string,
  candidateCommit: string,
  result: Extract<MergeResult, { clean: true }>,
): Promise<string[]> {
  const changed = await treeChanges(repo, headCommit, result.tree);
  const paths = changed.map(({ path }) => path).filter((path) => grammarFor(path));
  const [headBlobs, candidateBlobs, resultBlobs] = await Promise.all([
    blobsAt(repo, headCommit, paths),
    blobsAt(repo, candidateCommit, paths),
    blobsAt(repo, result.tree, paths),
  ]);
  const contents = await readBlobs(repo, [
    ...headBlobs.values(),
    ...candidateBlobs.values(),
    ...resultBlobs.values(),
  ]);
  const conflicts: string[] = [];
  for (const path of paths) {
    const grammar = grammarFor(path)!;
    const mergedFails = await failsToParse(contents.get(resultBlobs.get(path) ?? ""), grammar);
    if (!mergedFails) continue;
    const [headFails, candidateFails] = await Promise.all([
      failsToParse(contents.get(headBlobs.get(path) ?? ""), grammar),
      failsToParse(contents.get(candidateBlobs.get(path) ?? ""), grammar),
    ]);
    // A missing file is valid; a draft that was already malformed is allowed through (§10.3).
    if (!headFails && !candidateFails) conflicts.push(path);
  }
  return conflicts;
}
