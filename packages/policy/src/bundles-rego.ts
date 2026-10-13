import {
  AUTHORITY_POWERS,
  CAPABILITIES,
  GOVERNING_TASK_CAPABILITIES,
  OWNER_GIT_CAPABILITIES,
  ROLE_BUNDLES,
} from "./bundles.js";

/**
 * policy/bundles.gen.rego: the capability catalog, the role bundles and the authority powers of
 * bundles.ts as Rego data, which is how the policy (authz.rego) decides what a role and an
 * authority cover. bundles.ts stays the single source: `gen:wasm` writes this file from it and
 * CI fails when the committed copy is stale. `gen:wasm` formats it with `opa fmt`, so the text
 * here is unformatted.
 */
export function renderBundlesRego(): string {
  // `{}` is an empty object in Rego, so an empty set has to be written `set()`.
  const items = (values: string[], indent: string): string =>
    values.length === 0
      ? "set()"
      : `{\n${values.map((value) => `${indent}\t${JSON.stringify(value)},\n`).join("")}${indent}}`;
  const set = (name: string, values: Iterable<string>): string =>
    `${name} := ${items([...values], "")}\n`;
  const byKey = (name: string, entries: [string, Iterable<string>][]): string =>
    `${name} := {\n${entries
      .map(([key, values]) => `\t${JSON.stringify(key)}: ${items([...values], "\t")},\n`)
      .join("")}}\n`;
  return [
    "# Generated from src/bundles.ts by gen:wasm: do not edit.\n",
    "package crossover.bundles\n",
    "import rego.v1\n",
    set("capabilities", Object.keys(CAPABILITIES)),
    byKey("roles", Object.entries(ROLE_BUNDLES)),
    byKey("authorities", Object.entries(AUTHORITY_POWERS)),
    // Owners and admins also hold task management, and owners the git capabilities, whatever
    // their role (see effectiveCapabilities).
    set("governing_tasks", GOVERNING_TASK_CAPABILITIES),
    set("owner_git", OWNER_GIT_CAPABILITIES),
  ].join("\n");
}
