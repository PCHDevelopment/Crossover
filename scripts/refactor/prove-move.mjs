#!/usr/bin/env node
// Prove that code was moved, not rewritten (used for the T1525 and T1526 splits).
//
//   node scripts/refactor/prove-move.mjs [options] OLD.ts NEW1.ts [NEW2.ts ...]
//
// Declarations (top-level ones, and the members of a class) are matched by name between OLD and the
// NEW files with the TypeScript parser, and their text, leading doc comments included, is compared
// after the only edits a move needs:
//   - whitespace and trailing commas (formatting), and a method chain's `.name` moved to its own line;
//   - the keywords `private`, `export`, `function` and `readonly`;
//   - the parameter that carries the state a method used through `this` (`--core-type`, default
//     `DispatcherCore`; the parameter is named by `--core-name`, default `core`);
//   - `this.` -> `core.`, and `this.core.` -> `core.` in code that stayed in the class;
//   - a call `f(core, ...)` <-> `core.f(...)`;
//   - `--pure=a,b`: functions that need no core, called `core.a(` before and `a(` after.
// A declaration listed in `--glue=a,b` (a thin wrapper left in the class) is shown, not compared.
// Anything else is printed and the exit status is 1. Declarations that exist only in the NEW files
// are listed as glue.
//
// Caveat: the keywords above are removed everywhere in a declaration, so a change to one of them
// inside a body would not be seen; there are none in the code being moved.
import { readFileSync } from "node:fs";
import ts from "typescript";

const args = process.argv.slice(2);
const opts = Object.fromEntries(
  args
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [key, ...rest] = a.slice(2).split("=");
      return [key, rest.join("=")];
    }),
);
const [oldPath, ...newPaths] = args.filter((a) => !a.startsWith("--"));
if (!oldPath || newPaths.length === 0) {
  console.error(
    "usage: prove-move.mjs [--core-type=T] [--core-name=n] [--pure=a,b] [--glue=a,b] OLD.ts NEW.ts...",
  );
  process.exit(2);
}
const coreType = opts["core-type"] || "DispatcherCore";
const coreName = opts["core-name"] || "core";
const list = (value) => (value ?? "").split(",").filter(Boolean);
const pure = list(opts.pure);
const glue = new Set(list(opts.glue));
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const declarations = (path) => {
  const text = readFileSync(path, "utf8");
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const out = new Map();
  const nameOf = (n) => {
    if (ts.isVariableStatement(n)) {
      return n.declarationList.declarations.map((d) => d.name.getText(sf)).join(",");
    }
    if (ts.isConstructorDeclaration(n)) return "constructor";
    return n.name?.getText(sf) ?? null;
  };
  const add = (n) => {
    const name = nameOf(n);
    if (name) out.set(name, n.getFullText(sf).trim()); // the full text includes the leading comments
  };
  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) continue;
    if (ts.isClassDeclaration(statement)) for (const member of statement.members) add(member);
    else add(statement);
  }
  return out;
};

const normalise = (text, names) => {
  const core = escape(coreName);
  let t = text.replace(/\s+\./g, ".");
  t = t.replace(new RegExp(`this\\.${core}\\.`, "g"), `${coreName}.`);
  t = t.replace(new RegExp(`this\\.${core},`, "g"), `${coreName},`);
  t = t.replace(/this\./g, `${coreName}.`);
  t = t.replace(new RegExp(`\\b${core}:\\s*${escape(coreType)},?`, "g"), "");
  for (const n of names) {
    t = t.replace(new RegExp(`\\b${escape(n)}\\(\\s*${core},\\s*`, "g"), `${coreName}.${n}(`);
  }
  for (const n of pure) t = t.replace(new RegExp(`\\b${core}\\.${escape(n)}\\(`, "g"), `${n}(`);
  t = t.replace(/\b(private|export|function|readonly)\b/g, "");
  return t.replace(/\s+/g, "").replace(/,(?=[)\]}])/g, "");
};

const old = declarations(oldPath);
const names = [...old.keys()];
let differing = 0;
let compared = 0;
const onlyNew = [];
for (const path of newPaths) {
  for (const [name, text] of declarations(path)) {
    if (!old.has(name)) {
      onlyNew.push(`${path.split("/").pop()}:${name}`);
      continue;
    }
    compared++;
    const before = normalise(old.get(name), names);
    const after = normalise(text, names);
    if (before === after) {
      console.log(`identical modulo the allowed edits: ${name}`);
    } else if (glue.has(name)) {
      const shown = text.split("\n").filter((l) => !/^\s*(\/\*\*|\*|\/\/)/.test(l));
      console.log(
        `expected glue (a wrapper left in the class): ${name}\n    ${shown.join("\n    ")}`,
      );
    } else {
      differing++;
      let i = 0;
      while (i < before.length && before[i] === after[i]) i++;
      console.log(
        `--- DIFFERS: ${name} (${path})\n  old: ...${before.slice(Math.max(0, i - 60), i + 80)}\n  new: ...${after.slice(Math.max(0, i - 60), i + 80)}`,
      );
    }
  }
}
console.log(`\n${compared} declarations compared, ${differing} differ.`);
if (onlyNew.length > 0) console.log("not in the original (glue):", onlyNew.join(", "));
process.exit(differing > 0 ? 1 : 0);
