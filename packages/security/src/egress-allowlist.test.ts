import { describe, expect, it } from "vitest";
import {
  normalizeRoomEgressAllowlist,
  ROOM_EGRESS_ALLOWLIST_MAX_BYTES,
} from "./egress-allowlist.js";

describe("room egress allowlist normalization", () => {
  it("deduplicates and sorts before measuring canonical JSON", () => {
    expect(
      normalizeRoomEgressAllowlist(["API.example.com.", "api.example.com", "z.example.com"]),
    ).toEqual(["api.example.com", "z.example.com"]);
    expect(
      normalizeRoomEgressAllowlist(Array.from({ length: 100 }, () => "api.example.com")),
    ).toEqual(["api.example.com"]);
  });

  it("accepts a canonical host list exactly at 4 KiB", () => {
    const hosts = Array.from({ length: 16 }, (_, index) =>
      hostOfLength(index, index === 15 ? 252 : 253),
    );
    expect(Buffer.byteLength(JSON.stringify([...hosts].sort()), "utf8")).toBe(
      ROOM_EGRESS_ALLOWLIST_MAX_BYTES,
    );
    expect(normalizeRoomEgressAllowlist(hosts)).toHaveLength(16);
  });

  it("rejects canonical host JSON above 4 KiB", () => {
    const hosts = Array.from({ length: 16 }, (_, index) => hostOfLength(index, 253));
    expect(Buffer.byteLength(JSON.stringify([...hosts].sort()), "utf8")).toBe(
      ROOM_EGRESS_ALLOWLIST_MAX_BYTES + 1,
    );
    expect(() => normalizeRoomEgressAllowlist(hosts)).toThrow("egress allowlist too large");
  });
});

function hostOfLength(index: number, length: number): string {
  const first = `h${index}`.padEnd(63, "a");
  const thirdLabelLength = length - first.length - 63 - 63 - 3;
  if (thirdLabelLength < 1 || thirdLabelLength > 63)
    throw new Error("test hostname length is invalid");
  return `${first}.${"b".repeat(63)}.${"c".repeat(thirdLabelLength)}.${"d".repeat(63)}`;
}
