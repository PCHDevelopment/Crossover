/**
 * Suggest a room `health_command` from what an imported repository says about itself (§24.1,
 * T802). A suggestion only: nothing applies it, and a repository that says nothing useful gets
 * none (`null`) rather than a guess.
 */

export interface HealthSuggestion {
  /** What to run, as the room's `health_command` would hold it. */
  command: string;
  /** Which file it came from. */
  source: "package.json" | "Makefile" | "pyproject.toml";
  /** One line for the person deciding whether to accept it. */
  reason: string;
  /** The tools it needs, so the lead can pick a `health_image` that has them. */
  needs: "node" | "make" | "python";
}

/** Read a file of the imported tree at its root; `null` if it isn't there. */
export type ReadRepoFile = (path: string) => Promise<string | null>;

/** The placeholder `npm init` writes for `test`: it fails by design, so it is no test. */
const NPM_PLACEHOLDER_TEST = /no test specified/i;

async function fromPackageJson(read: ReadRepoFile): Promise<HealthSuggestion | null> {
  const text = await read("package.json");
  if (text === null) return null;
  let scripts: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    const candidate = (parsed as { scripts?: unknown } | null)?.scripts;
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate))
      return null;
    scripts = candidate as Record<string, unknown>;
  } catch {
    return null;
  }
  const has = (name: string) =>
    typeof scripts[name] === "string" && (scripts[name] as string).trim() !== "";
  const hasTypecheck = has("typecheck");
  const hasTest = has("test") && !NPM_PLACEHOLDER_TEST.test(scripts["test"] as string);
  if (!hasTypecheck && !hasTest) return null;

  const manager =
    (await read("pnpm-lock.yaml")) !== null
      ? "pnpm"
      : (await read("yarn.lock")) !== null
        ? "yarn"
        : "npm";
  const parts: string[] = [];
  if (hasTypecheck) parts.push(`${manager} run typecheck`);
  if (hasTest) parts.push(manager === "npm" ? "npm test" : `${manager} test`);
  const found = [hasTypecheck && "typecheck", hasTest && "test"].filter(Boolean).join(" and ");
  return {
    command: parts.join(" && "),
    source: "package.json",
    reason: `package.json has ${found} script${hasTypecheck && hasTest ? "s" : ""}; ${manager} is used because of ${manager === "npm" ? "no other lockfile" : manager === "pnpm" ? "pnpm-lock.yaml" : "yarn.lock"}`,
    needs: "node",
  };
}

/** The targets a Makefile defines: `name:` at the start of a line, not a `.PHONY`-style special. */
export function makeTargets(text: string): Set<string> {
  const targets = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*:(?!=)/.exec(line);
    if (match) targets.add(match[1]!);
  }
  return targets;
}

async function fromMakefile(read: ReadRepoFile): Promise<HealthSuggestion | null> {
  const text = (await read("Makefile")) ?? (await read("makefile")) ?? (await read("GNUmakefile"));
  if (text === null) return null;
  const targets = makeTargets(text);
  const parts: string[] = [];
  if (targets.has("typecheck")) parts.push("make typecheck");
  if (targets.has("test")) parts.push("make test");
  // `check` is conventionally the whole verification; used alone when there is no `test`.
  if (parts.length === 0 && targets.has("check")) parts.push("make check");
  if (parts.length === 0) return null;
  return {
    command: parts.join(" && "),
    source: "Makefile",
    reason: `Makefile defines ${parts.map((p) => p.replace("make ", "")).join(" and ")}`,
    needs: "make",
  };
}

async function fromPyproject(read: ReadRepoFile): Promise<HealthSuggestion | null> {
  const text = await read("pyproject.toml");
  if (text === null) return null;
  const mypy = /^\s*\[tool\.mypy[\].]/m.test(text);
  const pytest =
    /^\s*\[tool\.pytest[\].]/m.test(text) || /["']pytest(?:[<>=!~\s;[\]"'].*)?["']/.test(text);
  const parts: string[] = [];
  if (mypy) parts.push("mypy .");
  if (pytest) parts.push("pytest");
  if (parts.length === 0) return null;
  return {
    command: parts.join(" && "),
    source: "pyproject.toml",
    reason: `pyproject.toml configures ${[mypy && "mypy", pytest && "pytest"].filter(Boolean).join(" and ")}`,
    needs: "python",
  };
}

/**
 * The first ecosystem that has something to run, in the order package.json, Makefile,
 * pyproject.toml; `null` if none does.
 */
export async function suggestHealthCommand(read: ReadRepoFile): Promise<HealthSuggestion | null> {
  return (await fromPackageJson(read)) ?? (await fromMakefile(read)) ?? (await fromPyproject(read));
}
