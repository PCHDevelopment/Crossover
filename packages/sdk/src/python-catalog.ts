import { isMutatingMethod, METHOD_NAMES, PROTOCOL_VERSION } from "@crossover/protocol";

const HEADER =
  "# Generated from the protocol catalog by packages/sdk (src/python-catalog.ts). Do not edit.\n";

/** `_catalog.py`: every Room Protocol method and whether it mutates (and so carries an idempotency key). */
export function renderPythonCatalog(): string {
  const names = [...METHOD_NAMES].sort();
  return (
    HEADER +
    `PROTOCOL_VERSION = ${PROTOCOL_VERSION}\n\n` +
    "# method name -> True when the command mutates (it gets an idempotency key)\n" +
    "METHODS: dict[str, bool] = {\n" +
    names.map((n) => `    "${n}": ${isMutatingMethod(n) ? "True" : "False"},`).join("\n") +
    "\n}\n"
  );
}

const PYTHON_KEYWORDS = new Set(
  "False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield".split(
    " ",
  ),
);
/** A catalog name as a Python attribute: a keyword gets a trailing underscore (`git.import_`). */
const attr = (name: string) => (PYTHON_KEYWORDS.has(name) ? `${name}_` : name);

interface Node {
  methods: string[];
  children: Map<string, Node>;
}

/** `typed_api.pyi`: the catalog as nested, typed namespaces (`room.api.tasks.create(...)`), for editors and type checkers. */
export function renderPythonStub(): string {
  const root: Node = { methods: [], children: new Map() };
  for (const name of [...METHOD_NAMES].sort()) {
    const parts = name.split(".");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.children.has(part)) node.children.set(part, { methods: [], children: new Map() });
      node = node.children.get(part)!;
    }
    node.methods.push(parts[parts.length - 1]!);
  }
  const out: string[] = [];
  const className = (path: string[]) => `_Ns_${path.join("_")}`;
  const emit = (node: Node, path: string[], callable = false) => {
    for (const [name, child] of node.children)
      emit(child, [...path, name], node.methods.includes(name));
    out.push(`class ${path.length === 0 ? "Api" : className(path)}:`);
    // A name that is both a command and a namespace (`sandbox.exec`, `sandbox.exec.cancel`).
    if (callable) {
      out.push(
        "    def __call__(self, params: Mapping[str, Any] | None = ..., *, idempotency_key: str | None = ...) -> Awaitable[CommandResult]: ...",
      );
    }
    for (const [name] of node.children)
      out.push(`    ${attr(name)}: ${className([...path, name])}`);
    for (const m of node.methods) {
      if (node.children.has(m)) continue;
      out.push(
        `    def ${attr(m)}(self, params: Mapping[str, Any] | None = ..., *, idempotency_key: str | None = ...) -> Awaitable[CommandResult]: ...`,
      );
    }
    if (node.children.size === 0 && node.methods.length === 0) out.push("    pass");
    out.push("");
  };
  emit(root, []);
  return (
    HEADER +
    "from typing import Any, Awaitable, Mapping\n\nfrom ._types import CommandResult\n\n\n" +
    out.join("\n")
  );
}
