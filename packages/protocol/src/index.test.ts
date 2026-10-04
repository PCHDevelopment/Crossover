import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "./index.js";

describe("protocol", () => {
  it("exposes the protocol major version", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
