import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { blobsAt, blobSizes, readBlobs } from "./blobs.js";
import type { MergeResult } from "./merge.js";
import { treeChanges } from "./tree-changes.js";

type SyntaxNode = {
  type: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number };
  previousSibling: SyntaxNode | null;
};
type SyntaxTree = {
  rootNode: {
    hasError: boolean;
    childCount: number;
    child(index: number): SyntaxNode | null;
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
      // Only the first non-comment node on each row can indicate that indentation.
      if (grammar !== "python") return false;
      return Array.from({ length: root.childCount }, (_, index) => root.child(index)).some(
        (child) =>
          child !== null &&
          child.type !== "comment" &&
          child.startPosition.column > 0 &&
          (!child.previousSibling ||
            child.previousSibling.endPosition.row < child.startPosition.row),
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
