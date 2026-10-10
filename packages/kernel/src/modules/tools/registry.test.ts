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

  it("requires an immutable digest for executable plugin images", () => {
    const r = new ToolRegistry();
    const execution = {
      image: `busybox:1.36.1-musl@sha256:${"a".repeat(64)}`,
      command: ["/bin/busybox", "true"],
      egressHosts: [],
    };
    r.register(tool({ execution }));

    for (const image of [
      "busybox:latest",
      "busybox:1.36.1-musl",
      `busybox@sha256:${"A".repeat(64)}`,
      `busybox@sha256:${"a".repeat(63)}`,
    ]) {
      const next = new ToolRegistry();
      expect(() => next.register(tool({ execution: { ...execution, image } }))).toThrow(
        /pinned by a sha256 digest/,
      );
    }
  });

  it("validates credential requirements and GitHub repository scoping", () => {
    const base = {
      image: `busybox:1.36.1-musl@sha256:${"a".repeat(64)}`,
      command: ["/bin/busybox", "true"],
      egressHosts: [],
    };
    const registry = new ToolRegistry();
    expect(() =>
      registry.register(tool({ execution: { ...base, integrations: [{ provider: "github" }] } })),
    ).toThrow(/requires explicit permissions/);
    expect(() =>
      registry.register(
        tool({ execution: { ...base, integrations: [{ provider: "github", permissions: {} }] } }),
      ),
    ).toThrow(/requires explicit permissions/);
    expect(() =>
      registry.register(
        tool({
          execution: {
            ...base,
            integrations: [{ provider: "github", permissions: { contents: "read" } }],
          },
        }),
      ),
    ).not.toThrow();
    const { scope: _scope, ...unscoped } = tool();
    void _scope;
    expect(() =>
      new ToolRegistry().register({
        ...unscoped,
        execution: {
          ...base,
          integrations: [{ provider: "github", permissions: { contents: "read" } }],
        },
      }),
    ).toThrow(/repository-scoped/);
    expect(() =>
      new ToolRegistry().register(
        tool({
          execution: {
            ...base,
            integrations: [{ provider: "aws", permissions: { contents: "read" } }],
          },
        }),
      ),
    ).toThrow(/permissions are invalid/);
    expect(() =>
      new ToolRegistry().register(
        tool({
          execution: {
            ...base,
            integrations: [{ provider: "aws" }, { provider: "aws" }],
          },
        }),
      ),
    ).toThrow(/more than once/);
  });

  it("validates per-plugin output bounds", () => {
    const base = {
      image: `busybox:1.36.1-musl@sha256:${"a".repeat(64)}`,
      command: ["/bin/busybox", "true"],
      egressHosts: [],
    };
    expect(() =>
      new ToolRegistry().register(tool({ execution: { ...base, maxOutputBytes: 256 * 1024 } })),
    ).not.toThrow();
    for (const maxOutputBytes of [0, 256 * 1024 + 1, Number.NaN]) {
      expect(() =>
        new ToolRegistry().register(tool({ execution: { ...base, maxOutputBytes } })),
      ).toThrow(/execution output limit/);
    }
  });

  it("accepts immutable local image IDs for Docker-built integration fixtures", () => {
    expect(() =>
      new ToolRegistry().register(
        tool({
          execution: {
            image: `sha256:${"b".repeat(64)}`,
            command: ["/bin/busybox", "true"],
            egressHosts: [],
          },
        }),
      ),
    ).not.toThrow();
  });

  it("caps per-tool container process limits", () => {
    const base = {
      image: `busybox:1.36.1-musl@sha256:${"a".repeat(64)}`,
      command: ["/bin/busybox", "true"],
      egressHosts: [],
    };
    expect(() =>
      new ToolRegistry().register(tool({ execution: { ...base, pidsLimit: 256 } })),
    ).not.toThrow();
    for (const pidsLimit of [0, 257, Number.NaN]) {
      expect(() =>
        new ToolRegistry().register(tool({ execution: { ...base, pidsLimit } })),
      ).toThrow(/process limit/);
    }
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
