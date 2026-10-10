import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderPythonCatalog, renderPythonStub } from "./python-catalog.js";

const python = (file: string) =>
  readFileSync(new URL(`../../../clients/python/crossover_sdk/${file}`, import.meta.url), "utf8");

describe("the Python SDK's catalog", () => {
  it("is the protocol catalog: regenerate with `pnpm --filter @crossover/sdk gen:python` when it changes", () => {
    expect(python("_catalog.py")).toBe(renderPythonCatalog());
    expect(python("typed_api.pyi")).toBe(renderPythonStub());
  });

  it("marks mutating commands and spells Python keywords with a trailing underscore", () => {
    const catalog = renderPythonCatalog();
    expect(catalog).toContain('"tasks.create": True');
    expect(catalog).toContain('"tasks.list": False');
    expect(renderPythonStub()).toContain("def import_(");
    expect(renderPythonStub()).not.toMatch(/def import\(/);
  });
});
