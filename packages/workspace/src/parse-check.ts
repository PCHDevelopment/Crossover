import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { git } from "./git.js";
import type { MergeResult } from "./merge.js";
import { treeChanges } from "./tree-changes.js";

type SyntaxTree = {
  rootNode: {
    hasError: boolean;
    childCount: number;
    child(index: number): { startPosition: { column: number } } | null;
  };
  delete(): void;
};
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
let parserReady: Promise<void> | undefined;
function initializeParser(): Promise<void> {
  parserReady ??= TreeSitter.init({ locateFile: (file) => join(wasmDirectory, file) });
  return parserReady;
}

export const PARSE_FILE_MAX_BYTES = 1024 * 1024;
export const PARSE_APPLY_BUDGET_BYTES = 8 * 1024 * 1024;
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
  await initializeParser();
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

async function blobSizes(repo: string, oids: readonly string[]): Promise<Map<string, number>> {
  const unique = [...new Set(oids)];
  const sizes = new Map<string, number>();
  if (unique.length) {
    const { stdout } = await git(["cat-file", "--batch-check"], {
      gitDir: repo,
      timeoutMs: 10_000,
      input: `${unique.join("\n")}\n`,
    });
    const lines = stdout.trimEnd().split("\n");
    if (lines.length !== unique.length) throw new Error("Malformed source blob size response");
    for (const [index, line] of lines.entries()) {
      const [oid, type, sizeText] = line.split(" ");
      const size = Number(sizeText);
      if (
        oid === undefined ||
        oid !== unique[index] ||
        type !== "blob" ||
        !Number.isSafeInteger(size)
      )
        throw new Error("Unexpected source blob size response");
      sizes.set(oid, size);
    }
  }
  return sizes;
}

async function readBlobs(
  repo: string,
  oids: readonly string[],
  sizes: ReadonlyMap<string, number>,
): Promise<Map<string, Buffer>> {
  const unique = [...new Set(oids)];
  const contents = new Map<string, Buffer>();
  for (let offset = 0; offset < unique.length;) {
    let end = offset;
    let bytes = 0;
    while (
      end < unique.length &&
      (end === offset || bytes + sizes.get(unique[end]!)! <= 24 * 1024 * 1024)
    ) {
      bytes += sizes.get(unique[end]!)! + 128;
      end++;
    }
    const batch = unique.slice(offset, end);
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
  const language = await languageFor(grammar);
  const parser = new TreeSitter();
  try {
    parser.setLanguage(language);
    const treeResult = parser.parse(source);
    try {
      const root = treeResult.rootNode;
      if (root.hasError) return true;
      // The Python grammar accepts a top-level unexpected indent; Python rejects it.
      return (
        grammar === "python" &&
        Array.from({ length: root.childCount }, (_, index) => root.child(index)).some(
          (child) => child !== null && child.startPosition.column > 0,
        )
      );
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
  const oidsByPath = new Map(
    paths.map((path) => [
      path,
      [
        ...new Set(
          [headBlobs.get(path), candidateBlobs.get(path), resultBlobs.get(path)].filter(
            (oid): oid is string => oid !== undefined,
          ),
        ),
      ],
    ]),
  );
  const allOids = [...oidsByPath.values()].flat();
  const sizes = await blobSizes(repo, allOids);
  const parseKeys = new Set<string>();
  const parsePaths = new Set<string>();
  let parseBudget = 0;
  for (const path of paths.toSorted()) {
    const oids = oidsByPath.get(path)!;
    if (oids.some((oid) => sizes.get(oid)! > PARSE_FILE_MAX_BYTES)) continue;
    const grammar = grammarFor(path)!;
    const newKeys = oids.map((oid) => `${grammar}\0${oid}`).filter((key) => !parseKeys.has(key));
    const addedBytes = newKeys.reduce((total, key) => {
      const oid = key.slice(key.indexOf("\0") + 1);
      return total + sizes.get(oid)!;
    }, 0);
    if (parseBudget + addedBytes > PARSE_APPLY_BUDGET_BYTES) continue;
    parsePaths.add(path);
    for (const key of newKeys) parseKeys.add(key);
    parseBudget += addedBytes;
  }
  const allowedOids = [...new Set([...parsePaths].flatMap((path) => oidsByPath.get(path)!))];
  const contents = await readBlobs(repo, allowedOids, sizes);
  const parseResults = new Map<string, Promise<boolean>>();
  const check = (path: string, oid: string | undefined): Promise<boolean> => {
    if (!oid) return Promise.resolve(false); // A missing side is syntactically valid.
    const key = `${grammarFor(path)}\0${oid}`;
    let result = parseResults.get(key);
    if (!result) {
      result = failsToParse(contents.get(oid), grammarFor(path)!);
      parseResults.set(key, result);
    }
    return result;
  };
  const conflicts: string[] = [];
  for (const path of paths) {
    if (!parsePaths.has(path)) continue;
    const mergedFails = await check(path, resultBlobs.get(path));
    if (!mergedFails) continue;
    const [headFails, candidateFails] = await Promise.all([
      check(path, headBlobs.get(path)),
      check(path, candidateBlobs.get(path)),
    ]);
    // A missing file is valid; a draft that was already malformed is allowed through (§10.3).
    if (!headFails && !candidateFails) conflicts.push(path);
  }
  return conflicts;
}
