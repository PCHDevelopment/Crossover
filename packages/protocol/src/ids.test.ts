import { describe, expect, it } from "vitest";
import { ID_PREFIXES, isId, newId } from "./ids.js";

describe("newId", () => {
  it("returns prefix_ulid for every prefix", () => {
    for (const prefix of ID_PREFIXES) {
      const id = newId(prefix);
      expect(id.startsWith(`${prefix}_`)).toBe(true);
      expect(isId(id, prefix)).toBe(true);
    }
  });

  it("sorts IDs generated in the same millisecond in creation order", () => {
    const ids = Array.from({ length: 5000 }, () => newId("evt"));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("sorts IDs across milliseconds in creation order", async () => {
    const a = newId("task");
    await new Promise((r) => setTimeout(r, 3));
    const b = newId("task");
    expect(a < b).toBe(true);
  });
});

describe("isId", () => {
  it("rejects a wrong prefix", () => {
    expect(isId(newId("room"), "task")).toBe(false);
  });

  it("rejects a prefix that merely starts with the expected one", () => {
    expect(isId(`rooms_${newId("room").slice(5)}`, "room")).toBe(false);
  });

  it("rejects malformed ULIDs", () => {
    expect(isId("room_", "room")).toBe(false);
    expect(isId("room_123", "room")).toBe(false);
    expect(isId("room_01J0000000000000000000000U", "room")).toBe(false); // U not in alphabet
    expect(isId("room_81J00000000000000000000000", "room")).toBe(false); // overflows 48-bit time
    expect(isId("room_01j00000000000000000000000", "room")).toBe(false); // lowercase
    expect(isId(`${newId("room")}0`, "room")).toBe(false); // too long
  });

  it("rejects non-strings and missing separator", () => {
    expect(isId(undefined, "room")).toBe(false);
    expect(isId(42, "room")).toBe(false);
    expect(isId("room01J00000000000000000000000", "room")).toBe(false);
  });
});
