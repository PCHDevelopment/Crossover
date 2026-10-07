import { describe, expect, it } from "vitest";
import { z } from "zod";
import { canonicalScope, capabilityFor, ToolRegistry, type ToolDefinition } from "./registry.js";

const tool = (
  over: Partial<ToolDefinition<{ repo: string }>> = {},
): ToolDefinition<{ repo: string }> => ({
  name: "github.create_pull_request",
  description: "d",
  capability: "github.create_pull_request",
  tier: 2,
  input: z.object({ repo: z.string() }),
  scope: (a) => a.repo,
  idempotent: false,
  ...over,
});

describe("ToolRegistry", () => {
  it("registers by name, lists in order, and refuses a duplicate or a malformed name", () => {
    const r = new ToolRegistry();
    r.register(tool({ name: "z.last", capability: "z.last" }));
    r.register(tool());
    expect(r.list().map((t) => t.name)).toEqual(["github.create_pull_request", "z.last"]);
    expect(() => r.register(tool())).toThrow(/already registered/);
    expect(() => r.register(tool({ name: "NoDot" }))).toThrow(/<plugin>\.<tool>/);
    expect(() => r.register(tool({ name: "a.b", capability: "nodot" }))).toThrow(/capability/);
    expect(r.get("nope.x")).toBeUndefined();
  });

  it("refuses a declared tier that disagrees with the policy's", () => {
    const r = new ToolRegistry({ tierOf: (c) => (c.startsWith("github.create") ? 2 : 3) });
    expect(() => r.register(tool({ tier: 0 }))).toThrow(/tier 0 .* tier 2/);
    r.register(tool({ tier: 2 }));
  });
});

describe("capabilityFor", () => {
  it("is the base alone, or base:scope from the arguments, and refuses a scope that can't be one", () => {
    expect(capabilityFor(tool(), { repo: "acme/widgets" })).toBe(
      "github.create_pull_request:acme/widgets",
    );
    const { scope: _scope, ...unscoped } = tool();
    void _scope;
    expect(capabilityFor(unscoped, { repo: "x" })).toBe("github.create_pull_request");
    expect(() => capabilityFor(tool(), { repo: "has space" })).toThrow(/scope/);
    expect(() => capabilityFor(tool(), { repo: "" })).toThrow(/scope/);
  });
});

describe("canonicalScope", () => {
  it("refuses what could re-route a scope, and applies the tool's own normalization", () => {
    for (const bad of [
      "",
      "a/../b",
      "a/./b",
      "a//b",
      "/a",
      "a/",
      "a/%2e%2e/b",
      "a?x",
      "a#x",
      "a\\b",
      "a\u0000b",
      "a\u0085b", // a C1 control
      "a b",
      "a/*",
      "a/[x]",
      "x".repeat(201),
    ]) {
      expect(() => canonicalScope(bad), JSON.stringify(bad)).toThrow(/scope/);
    }
    expect(canonicalScope("Acme/Widgets", (s) => s.toLowerCase())).toBe("acme/widgets");
    // A normalization can't produce what the rules refuse.
    expect(() => canonicalScope("acme/x", () => "acme/../x")).toThrow(/scope/);
    expect(canonicalScope("x".repeat(200))).toHaveLength(200);
  });
});
