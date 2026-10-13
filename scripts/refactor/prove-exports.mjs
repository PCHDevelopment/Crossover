#!/usr/bin/env node
// Prove that a package's public surface did not change (used for the T1525 and T1526 splits).
//
//   node scripts/refactor/prove-exports.mjs BEFORE/src/index.ts AFTER/src/index.ts
//
// Lists every name exported from each entry file, `export *` chains followed, with the TypeScript
// checker, and prints the names, and their kind (value, type), that only one side exports. Compare
// `main` (a `git worktree add --detach /tmp/wt-main origin/main`, with node_modules linked in) with
// the branch. Exit status 1 on any difference.
import ts from "typescript";

const exportedNames = (entry) => {
  const program = ts.createProgram([entry], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    noEmit: true,
  });
  const checker = program.getTypeChecker();
  const module = checker.getSymbolAtLocation(program.getSourceFile(entry));
  const out = new Map();
  for (const symbol of checker.getExportsOfModule(module)) {
    const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    const kind = [
      target.flags & ts.SymbolFlags.Value ? "value" : "",
      target.flags & ts.SymbolFlags.Type ? "type" : "",
    ]
      .filter(Boolean)
      .join("+");
    out.set(symbol.name, kind);
  }
  return out;
};

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) {
  console.error("usage: prove-exports.mjs BEFORE_ENTRY.ts AFTER_ENTRY.ts");
  process.exit(2);
}
const before = exportedNames(beforePath);
const after = exportedNames(afterPath);
let differences = 0;
for (const [name, kind] of before) {
  if (!after.has(name)) {
    console.log(`REMOVED: ${name} (${kind})`);
    differences++;
  } else if (after.get(name) !== kind) {
    console.log(`CHANGED KIND: ${name}: ${kind} -> ${after.get(name)}`);
    differences++;
  }
}
for (const [name, kind] of after) {
  if (!before.has(name)) {
    console.log(`ADDED: ${name} (${kind})`);
    differences++;
  }
}
console.log(
  `${before.size} names exported before, ${after.size} after, ${differences} differences.`,
);
process.exit(differences > 0 ? 1 : 0);
