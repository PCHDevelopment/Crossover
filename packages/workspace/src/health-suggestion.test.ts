import { describe, expect, it } from "vitest";
import { makeTargets, suggestHealthCommand, type ReadRepoFile } from "./health-suggestion.js";

const repo =
  (files: Record<string, string>): ReadRepoFile =>
  async (path) =>
    files[path] ?? null;

describe("suggestHealthCommand", () => {
  it("suggests typecheck and test from package.json scripts", async () => {
    const s = await suggestHealthCommand(
      repo({ "package.json": JSON.stringify({ scripts: { typecheck: "tsc", test: "vitest" } }) }),
    );
    expect(s).toMatchObject({
      command: "npm run typecheck && npm test",
      source: "package.json",
      needs: "node",
    });
  });

  it("uses the package manager the lockfile names", async () => {
    const pkg = JSON.stringify({ scripts: { test: "vitest" } });
    expect(
      (await suggestHealthCommand(repo({ "package.json": pkg, "pnpm-lock.yaml": "" })))?.command,
    ).toBe("pnpm test");
    expect(
      (await suggestHealthCommand(repo({ "package.json": pkg, "yarn.lock": "" })))?.command,
    ).toBe("yarn test");
  });

  it("ignores the npm-init placeholder test and a package.json without usable scripts", async () => {
    const placeholder = JSON.stringify({
      scripts: { test: 'echo "Error: no test specified" && exit 1' },
    });
    expect(await suggestHealthCommand(repo({ "package.json": placeholder }))).toBeNull();
    expect(await suggestHealthCommand(repo({ "package.json": "{not json" }))).toBeNull();
    expect(await suggestHealthCommand(repo({ "package.json": '{"scripts":[]}' }))).toBeNull();
    expect(
      await suggestHealthCommand(repo({ "package.json": '{"scripts":{"build":"tsc"}}' })),
    ).toBeNull();
  });

  it("suggests make targets, check only when there is no test", async () => {
    const both = await suggestHealthCommand(
      repo({ Makefile: "typecheck:\n\ttsc\ntest:\n\tgo test\n" }),
    );
    expect(both).toMatchObject({
      command: "make typecheck && make test",
      source: "Makefile",
      needs: "make",
    });
    expect((await suggestHealthCommand(repo({ Makefile: "check: lint\n\techo\n" })))?.command).toBe(
      "make check",
    );
    expect(
      (await suggestHealthCommand(repo({ Makefile: "test:\n\tx\ncheck:\n\ty\n" })))?.command,
    ).toBe("make test");
    expect(await suggestHealthCommand(repo({ Makefile: "build:\n\tcc\n" }))).toBeNull();
  });

  it("does not take variable assignments or recipes for targets", () => {
    expect([...makeTargets("test := 1\n\ttest:\n.PHONY: test\nall:\n")]).toEqual(["all"]);
  });

  it("suggests mypy and pytest from pyproject.toml", async () => {
    const s = await suggestHealthCommand(
      repo({ "pyproject.toml": "[tool.mypy]\nstrict = true\n[tool.pytest.ini_options]\n" }),
    );
    expect(s).toMatchObject({
      command: "mypy . && pytest",
      source: "pyproject.toml",
      needs: "python",
    });
    const dep = await suggestHealthCommand(
      repo({ "pyproject.toml": '[project.optional-dependencies]\ndev = ["pytest>=8"]\n' }),
    );
    expect(dep?.command).toBe("pytest");
    expect(
      await suggestHealthCommand(repo({ "pyproject.toml": "[project]\nname='x'\n" })),
    ).toBeNull();
  });

  it("prefers package.json, then Makefile, then pyproject; none gives null", async () => {
    const all = {
      "package.json": JSON.stringify({ scripts: { test: "vitest" } }),
      Makefile: "test:\n\tx\n",
      "pyproject.toml": "[tool.pytest]\n",
    };
    expect((await suggestHealthCommand(repo(all)))?.source).toBe("package.json");
    expect((await suggestHealthCommand(repo({ ...all, "package.json": "{}" })))?.source).toBe(
      "Makefile",
    );
    expect(
      (await suggestHealthCommand(repo({ "pyproject.toml": all["pyproject.toml"] })))?.source,
    ).toBe("pyproject.toml");
    expect(await suggestHealthCommand(repo({}))).toBeNull();
  });
});
