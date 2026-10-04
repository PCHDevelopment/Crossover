import { describe, expect, it } from "vitest";
import { normalizePath, PathValidationError } from "./path.js";

describe("normalizePath", () => {
  it.each([
    ["src/file.ts", "src/file.ts"],
    ["./src//file.ts", "src/file.ts"],
    ["src/./file.ts/", "src/file.ts"],
    ["cafe\u0301.ts", "café.ts"],
    [".gitignore", ".gitignore"],
    [".github/workflows/check.yml", ".github/workflows/check.yml"],
    ["src/.gitkeep", "src/.gitkeep"],
    ["git~10/file", "git~10/file"],
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
    ["uppercase Git metadata", ".GIT/config"],
    ["mixed-case nested Git metadata", "src/.GiT/config"],
    ["trailing dot Git metadata", ".git./config"],
    ["trailing space Git metadata", "src/.git /config"],
    ["mixed trailing spaces and dots", "src/.GIT. . /config"],
    ["Git short name", "git~1/config"],
    ["uppercase nested short name", "src/GIT~1/config"],
    ["short name with trailing dots/spaces", "src/Git~1. /config"],
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
