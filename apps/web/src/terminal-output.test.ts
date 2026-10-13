import { describe, expect, it } from "vitest";
import { sanitizeTerminalText } from "./terminal-output.js";

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
});
