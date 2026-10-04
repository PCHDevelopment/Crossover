import { describe, expect, it } from "vitest";
import { normalizePath, PathValidationError } from "./path.js";

describe("normalizePath", () => {
  it.each([
    ["src/file.ts", "src/file.ts"],
    ["./src//file.ts", "src/file.ts"],
    ["src/./file.ts/", "src/file.ts"],
    ["cafe\u0301.ts", "café.ts"],
    [".gitignore", ".gitignore"],
    ["src/..name", "src/..name"],
  ])("normalizes %j to %j", (input, output) => {
    expect(normalizePath(input!)).toBe(output);
    expect(normalizePath(output!)).toBe(output);
  });

  it.each([
    ["leading slash", "/src/a"],
    ["parent traversal", "src/../a"],
    ["leading parent", "../a"],
    ["terminal parent", "src/.."],
    ["Git metadata at root", ".git/config"],
    ["nested Git metadata", "src/.git/objects/x"],
    ["NUL", "src/a\0b"],
    ["Windows separator", "src\\a"],
    ["empty", ""],
    ["current directory", "."],
    ["collapsed current directory", "././"],
    ["too many UTF-8 bytes", "界".repeat(1366)],
    ["too many ASCII bytes", "a".repeat(4097)],
  ])("rejects %s", (_rule, input) => {
    expect(() => normalizePath(input!)).toThrow(PathValidationError);
  });

  it("accepts exactly 4096 UTF-8 bytes after NFC normalization", () => {
    expect(normalizePath("a".repeat(4096))).toHaveLength(4096);
    expect(Buffer.byteLength(normalizePath("界".repeat(1365) + "a"))).toBe(4096);
    expect(normalizePath("e\u0301".repeat(2048))).toBe("é".repeat(2048));
  });
});
