import { describe, expect, it } from "vitest";
import { sanitizeTerminalText, TerminalTextSanitizer } from "./terminal-output.js";

describe("sanitizeTerminalText", () => {
  it("keeps readable text and removes cursor, clear-screen, title, and hyperlink controls", () => {
    const output =
      "before\u001b[2Jhidden prompt\u001b[1Aafter\u001b]0;fake title\u0007" +
      "\u001b]8;;https://example.invalid\u001b\\link\u001b]8;;\u001b\\";

    expect(sanitizeTerminalText(output)).toBe("beforehidden promptafterlink");
  });

  it("removes control bytes while retaining newlines and tabs", () => {
    expect(sanitizeTerminalText("a\u0007b\r\nc\td\u001b")).toBe("ab\nc\td");
  });

  it("holds a CSI sequence split across output chunks until it can remove the whole sequence", () => {
    const sanitizer = new TerminalTextSanitizer();
    expect(sanitizer.write("before\u001b[")).toBe("before");
    expect(sanitizer.write("2Jafter")).toBe("after");
    sanitizer.finish();
  });

  it("removes C1 controls and bidi override and isolate characters", () => {
    expect(sanitizeTerminalText("a\u009b2Jb\u0080c\u202ed\u2066e\u2069f")).toBe("abcdef");
  });

  it("stops buffering an unterminated OSC after 4 KiB and shows following text", () => {
    const sanitizer = new TerminalTextSanitizer();
    const content = "x".repeat(4 * 1024);

    expect(sanitizer.write("\u001b]0;")).toBe("");
    expect(sanitizer.write(`${content}visible after OSC`)).toContain("visible after OSC");
    expect(sanitizer.write("later text")).toBe("later text");
    sanitizer.finish();
  });
});
