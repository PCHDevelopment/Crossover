import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex, sha256HexPortable } from "./canonical.js";

describe("canonicalJson", () => {
  it("serializes objects with the same content identically regardless of key order", () => {
    const a = { b: 1, a: { y: [1, { d: 4, c: 3 }], x: null }, c: "z" };
    const b = { c: "z", a: { x: null, y: [1, { c: 3, d: 4 }] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"x":null,"y":[1,{"c":3,"d":4}]},"b":1,"c":"z"}');
  });

  it("emits no whitespace", () => {
    expect(canonicalJson({ a: [1, 2], b: { c: "d e" } })).toBe('{"a":[1,2],"b":{"c":"d e"}}');
  });

  it("keeps array order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("serializes primitives", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson('a"b\n')).toBe('"a\\"b\\n"');
    expect(canonicalJson(1.5)).toBe("1.5");
    expect(canonicalJson(-0)).toBe("0");
    expect(canonicalJson({})).toBe("{}");
    expect(canonicalJson([])).toBe("[]");
  });

  it("sorts keys by UTF-16 code unit", () => {
    expect(canonicalJson({ b: 1, B: 2, é: 3, a: 4, "10": 5, "9": 6 })).toBe(
      '{"10":5,"9":6,"B":2,"a":4,"b":1,"é":3}',
    );
  });

  it("escapes keys and handles __proto__ as an ordinary key", () => {
    const parsed: unknown = JSON.parse('{"__proto__":{"x":1},"a\\"b":2}');
    expect(canonicalJson(parsed)).toBe('{"__proto__":{"x":1},"a\\"b":2}');
  });

  it("rejects undefined, anywhere", () => {
    expect(() => canonicalJson(undefined)).toThrow(TypeError);
    expect(() => canonicalJson({ a: undefined })).toThrow(/\$\.a/);
    expect(() => canonicalJson([1, undefined])).toThrow(/\$\[1\]/);
    // eslint-disable-next-line no-sparse-arrays
    expect(() => canonicalJson([1, , 3])).toThrow(/\$\[1\]/);
  });

  it("rejects functions, symbols and bigints", () => {
    expect(() => canonicalJson(() => 1)).toThrow(/function/);
    expect(() => canonicalJson({ f() {} })).toThrow(/function/);
    expect(() => canonicalJson(Symbol("s"))).toThrow(/symbol/);
    expect(() => canonicalJson(10n)).toThrow(/bigint/);
  });

  it("rejects non-finite numbers", () => {
    for (const n of [NaN, Infinity, -Infinity]) {
      expect(() => canonicalJson(n)).toThrow(/non-finite/);
      expect(() => canonicalJson({ n })).toThrow(/non-finite/);
    }
  });

  it("rejects non-plain objects", () => {
    expect(() => canonicalJson(new Date())).toThrow(/unsupported object/);
    expect(() => canonicalJson(new Map())).toThrow(/unsupported object/);
    expect(() => canonicalJson(new (class Foo {})())).toThrow(/unsupported object/);
  });

  it("accepts null-prototype objects", () => {
    const o = Object.create(null) as Record<string, unknown>;
    o["a"] = 1;
    expect(canonicalJson(o)).toBe('{"a":1}');
  });

  it("rejects circular references, but allows a shared (non-circular) object", () => {
    const a: Record<string, unknown> = {};
    a["self"] = a;
    expect(() => canonicalJson(a)).toThrow(/circular/);
    const shared = { x: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
  });

  it("rejects absurdly deep nesting instead of overflowing the stack", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 600; i++) deep = [deep];
    expect(() => canonicalJson(deep)).toThrow(/deeper than/);
  });
});

describe("sha256Hex", () => {
  it("matches known answers", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("hashes the UTF-8 encoding", () => {
    expect(sha256Hex("héllo ✓")).toBe(
      "5657cdef8a85a584e0e961e6f8247cf5d3f8ed21496ed6fdbcfd43a761e94245",
    );
  });

  it("hashes canonical JSON stably (known answer, key order irrelevant)", () => {
    const expected = "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777";
    expect(sha256Hex(canonicalJson({ b: 2, a: 1 }))).toBe(expected);
    expect(sha256Hex(canonicalJson({ a: 1, b: 2 }))).toBe(expected);
  });
});

describe("sha256HexPortable (the browser's SHA-256)", () => {
  it("agrees with Node's on empty input, block boundaries, multi-byte text and long input", () => {
    const inputs = [
      "",
      "abc",
      "a".repeat(55),
      "a".repeat(56),
      "a".repeat(63),
      "a".repeat(64),
      "a".repeat(65),
      "a".repeat(119),
      "a".repeat(120),
      "héllo wörld ✓ 日本語 😀",
      "x".repeat(100_000),
    ];
    for (const input of inputs) {
      expect(sha256HexPortable(input), input.slice(0, 20)).toBe(
        createHash("sha256").update(input, "utf8").digest("hex"),
      );
    }
    expect(sha256HexPortable("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
