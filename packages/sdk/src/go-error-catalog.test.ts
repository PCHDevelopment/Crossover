import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PUBLIC_ERROR_CODES } from "@crossover/protocol";
import { renderGoErrorCatalog } from "./go-error-catalog.js";

const go = () =>
  readFileSync(
    new URL("../../../clients/go/internal/cli/error_codes_gen.go", import.meta.url),
    "utf8",
  );

describe("the Go CLI error exit-code table", () => {
  it("matches PUBLIC_ERROR_CODES in protocol order; regenerate with gen:go-error-codes", () => {
    expect(go()).toBe(renderGoErrorCatalog());
  });

  it("assigns one stable status per public error", () => {
    expect(PUBLIC_ERROR_CODES).toHaveLength(14);
    expect(renderGoErrorCatalog()).toMatch(/"VALIDATION":\s+13,/);
    expect(renderGoErrorCatalog()).toMatch(/"UNAVAILABLE":\s+22,/);
  });
});
