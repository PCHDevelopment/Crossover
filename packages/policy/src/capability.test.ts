import { CrossoverError } from "@crossover/protocol";
import { describe, expect, it } from "vitest";
import {
  capabilityMatches,
  capabilityMatchesPath,
  isSafeRequestPath,
  parseCapability,
  tierOf,
} from "./capability.js";
import { CAPABILITIES } from "./bundles.js";
import { pathGlobMatch } from "./glob.js";

describe("parseCapability", () => {
  it.each([
    ["workspace.read", { resource: "workspace", action: "read", base: "workspace.read" }],
    ["sandbox.exec", { resource: "sandbox", action: "exec", base: "sandbox.exec" }],
    [
      "decisions.add_position",
      { resource: "decisions", action: "add_position", base: "decisions.add_position" },
    ],
    ["browser.navigate", { resource: "browser", action: "navigate", base: "browser.navigate" }],
    ["tasks2.do_it", { resource: "tasks2", action: "do_it", base: "tasks2.do_it" }],
  ])("accepts %s", (input, expected) => {
    expect(parseCapability(input)).toEqual(expected);
  });

  it.each([
    ["workspace.write:src/api/**", "src/api/**"],
    ["github.create_pull_request:org/repo", "org/repo"],
    ["aws.deploy_lambda:function/staging-*", "function/staging-*"],
    // the scope is everything after the FIRST colon, colons included (ARNs)
    [
      "aws.read_logs:arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/foo",
      "arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/foo",
    ],
    ["github.read_repository:a:b:c", "a:b:c"],
    ["workspace.write:.github/**", ".github/**"],
    ["workspace.write:a[1].txt", "a[1].txt"],
  ])("splits the scope of %s", (input, scope) => {
    expect(parseCapability(input).scope).toBe(scope);
  });

  it.each([
    ["empty", ""],
    ["one segment", "workspace"],
    ["trailing dot", "workspace."],
    ["leading dot", ".write"],
    ["three segments", "workspace.changeset.get"],
    ["double dot", "workspace..write"],
    ["uppercase", "Workspace.write"],
    ["uppercase action", "workspace.Write"],
    ["hyphen", "work-space.write"],
    ["starts with a digit", "1workspace.write"],
    ["wildcard action", "tasks.*"],
    ["wildcard resource", "*.read"],
    ["wildcard both", "*.*"],
    ["space", "workspace.write extra"],
    ["empty scope", "workspace.write:"],
    ["whitespace scope", "workspace.write: "],
    ["scope with a space", "github.create_pull_request:org/my repo"],
    ["scope with a newline", "workspace.write:src/a\n"],
    ["scope with NUL", "workspace.write:src/a\u0000"],
    ["colon first", ":scope"],
    ["only colons", "::"],
    ["unicode resource", "wörkspace.write"],
    ["too long", `workspace.write:${"a".repeat(600)}`],
  ])("rejects %s", (_label, input) => {
    expect(() => parseCapability(input)).toThrow(CrossoverError);
    try {
      parseCapability(input);
    } catch (e) {
      expect(e).toMatchObject({ code: "VALIDATION" });
    }
  });

  it("rejects non-strings", () => {
    for (const bad of [undefined, null, 5, {}, []]) {
      expect(() => parseCapability(bad as unknown as string)).toThrow(CrossoverError);
    }
  });

  describe("workspace path scopes can't escape the root", () => {
    it.each([
      "workspace.write:../etc/passwd",
      "workspace.write:src/../../x",
      "workspace.write:/etc/passwd",
      "workspace.write:src//x",
      "workspace.write:src/",
      "workspace.write:./src",
      "workspace.write:src/./x",
      "workspace.write:src\\x",
      "workspace.write:..",
      "workspace.write:.",
    ])("rejects %s", (input) => {
      expect(() => parseCapability(input)).toThrow(CrossoverError);
    });

    it("accepts dotfiles and dot directories (they aren't . or ..)", () => {
      for (const ok of [
        "workspace.write:.env",
        "workspace.write:.github/workflows/ci.yml",
        "workspace.write:a/..b/c",
        "workspace.write:...",
        "workspace.write:a/.../b",
      ]) {
        expect(() => parseCapability(ok), ok).not.toThrow();
      }
    });

    it("other resources may use / and .. freely: their scopes aren't paths", () => {
      expect(parseCapability("github.create_pull_request:/org/repo/").scope).toBe("/org/repo/");
    });
  });
});

describe("capabilityMatches: the resource, the action and unscoped grants", () => {
  it("an exact capability matches itself", () => {
    expect(capabilityMatches("workspace.read", "workspace.read")).toBe(true);
  });

  it("different action or resource never matches", () => {
    expect(capabilityMatches("workspace.read", "workspace.write")).toBe(false);
    expect(capabilityMatches("workspace.write", "memory.write")).toBe(false);
    expect(capabilityMatches("workspace.write", "workspace.write_all")).toBe(false);
    expect(capabilityMatches("workspace.write", "workspaces.write")).toBe(false);
  });

  it("an unscoped grant covers every scope", () => {
    expect(capabilityMatches("workspace.write", "workspace.write:src/api/x.ts")).toBe(true);
    expect(
      capabilityMatches("github.create_pull_request", "github.create_pull_request:org/repo"),
    ).toBe(true);
    expect(capabilityMatches("aws.read_logs", "aws.read_logs:arn:aws:logs:x")).toBe(true);
  });

  it("a scoped grant doesn't cover the unscoped capability (which means all scopes)", () => {
    expect(capabilityMatches("workspace.write:src/**", "workspace.write")).toBe(false);
    expect(
      capabilityMatches("github.create_pull_request:org/repo", "github.create_pull_request"),
    ).toBe(false);
  });

  it("is case-sensitive", () => {
    expect(capabilityMatches("workspace.write:src/**", "workspace.write:SRC/a.ts")).toBe(false);
    expect(capabilityMatches("workspace.write:Src/**", "workspace.write:src/a.ts")).toBe(false);
  });
});

describe("capabilityMatches: workspace path globs", () => {
  const covers = (glob: string, path: string) =>
    capabilityMatches(`workspace.write:${glob}`, `workspace.write:${path}`);

  describe("**", () => {
    it("workspace.write:src/api/** covers src/api/x/y.ts, but not src/apix.ts", () => {
      expect(covers("src/api/**", "src/api/x/y.ts")).toBe(true);
      expect(covers("src/api/**", "src/apix.ts")).toBe(false);
      expect(covers("src/api/**", "src/apix/y.ts")).toBe(false);
    });

    it("a trailing /** covers one or more segments below, not the directory path itself", () => {
      expect(covers("src/api/**", "src/api/x")).toBe(true);
      expect(covers("src/api/**", "src/api/x/y/z/w.ts")).toBe(true);
      expect(covers("src/api/**", "src/api")).toBe(false);
    });

    it("doesn't cover siblings, parents or other roots", () => {
      expect(covers("src/api/**", "src/other/x.ts")).toBe(false);
      expect(covers("src/api/**", "src")).toBe(false);
      expect(covers("src/api/**", "lib/src/api/x.ts")).toBe(false);
      expect(covers("src/api/**", "other/src/api/x.ts")).toBe(false);
    });

    it("a lone ** covers every path", () => {
      expect(covers("**", "a")).toBe(true);
      expect(covers("**", "a/b/c.txt")).toBe(true);
      expect(covers("**", ".env")).toBe(true);
    });

    it("a leading **/ matches zero or more directories", () => {
      expect(covers("**/README.md", "README.md")).toBe(true);
      expect(covers("**/README.md", "docs/README.md")).toBe(true);
      expect(covers("**/README.md", "a/b/c/README.md")).toBe(true);
      expect(covers("**/README.md", "README.md.bak")).toBe(false);
      expect(covers("**/README.md", "docs/NOTREADME.md")).toBe(false);
    });

    it("a middle /**/ matches zero or more directories", () => {
      expect(covers("docs/**/*.md", "docs/a.md")).toBe(true);
      expect(covers("docs/**/*.md", "docs/x/y/a.md")).toBe(true);
      expect(covers("docs/**/*.md", "docs/x/y/a.txt")).toBe(false);
      expect(covers("docs/**/*.md", "other/a.md")).toBe(false);
      expect(covers("src/**/test/**", "src/test/a.ts")).toBe(true);
      expect(covers("src/**/test/**", "src/a/b/test/c/d.ts")).toBe(true);
      expect(covers("src/**/test/**", "src/a/b/test")).toBe(false);
    });

    it("** inside a segment behaves like *", () => {
      expect(covers("src/a**b.ts", "src/axxb.ts")).toBe(true);
      expect(covers("src/a**b.ts", "src/a/b.ts")).toBe(false);
    });
  });

  describe("*", () => {
    it("matches within a segment and never crosses /", () => {
      expect(covers("src/*.ts", "src/a.ts")).toBe(true);
      expect(covers("src/*.ts", "src/.ts")).toBe(true);
      expect(covers("src/*.ts", "src/a/b.ts")).toBe(false);
      expect(covers("src/*", "src/a")).toBe(true);
      expect(covers("src/*", "src/a/b")).toBe(false);
      expect(covers("src/*", "src")).toBe(false);
      expect(covers("*", "a")).toBe(true);
      expect(covers("*", "a/b")).toBe(false);
    });

    it("matches zero or more characters, anywhere in a segment", () => {
      expect(covers("src/a*", "src/a")).toBe(true);
      expect(covers("src/a*", "src/abc")).toBe(true);
      expect(covers("src/*c", "src/abc")).toBe(true);
      expect(covers("src/a*c", "src/abbbc")).toBe(true);
      expect(covers("src/a*c", "src/abbbd")).toBe(false);
      expect(covers("src/*a*b*", "src/xaxbx")).toBe(true);
      expect(covers("src/*a*b*", "src/xbxax")).toBe(false);
    });

    it("is a wildcard even where the path has a * of its own", () => {
      // The pattern's `*` was once compared to the text character first, so it only matched itself
      // there and the match failed (found by comparing with the Rego policy, scope-oracle.test.ts).
      expect(covers("*", "**")).toBe(true);
      expect(covers("src/*", "src/*.ts")).toBe(true);
      expect(covers("src/*.ts", "src/*.ts")).toBe(true);
      expect(covers("*a*", "a**b")).toBe(true);
      expect(covers("a*b*c", "a*b*c")).toBe(true);
      expect(covers("src/*", "src/*/x")).toBe(false);
    });

    it("an exact path (no wildcards) covers only that path", () => {
      expect(covers("src/a.ts", "src/a.ts")).toBe(true);
      expect(covers("src/a.ts", "src/a.tsx")).toBe(false);
      expect(covers("src/a.ts", "src/a.ts/x")).toBe(false);
      expect(covers("src/a.ts", "x/src/a.ts")).toBe(false);
    });
  });

  describe("?", () => {
    it("matches exactly one non-/ character", () => {
      expect(covers("src/?.ts", "src/a.ts")).toBe(true);
      expect(covers("src/?.ts", "src/ab.ts")).toBe(false);
      expect(covers("src/?.ts", "src/.ts")).toBe(false);
      expect(covers("src/a?c", "src/a/c")).toBe(false);
    });
  });

  describe("dotfiles", () => {
    it("wildcards match dotfiles: a grant of src/** covers src/.env", () => {
      expect(covers("src/**", "src/.env")).toBe(true);
      expect(covers("src/**", "src/.hidden/deep/file")).toBe(true);
      expect(covers("src/*", "src/.env")).toBe(true);
      expect(covers("**", ".github/workflows/ci.yml")).toBe(true);
      expect(covers("**/*.yml", ".github/workflows/ci.yml")).toBe(true);
      expect(covers("*.md", ".notes.md")).toBe(true);
    });

    it("a dot-prefixed pattern is literal and covers just those", () => {
      expect(covers(".github/**", ".github/workflows/ci.yml")).toBe(true);
      expect(covers(".github/**", "github/workflows/ci.yml")).toBe(false);
      expect(covers(".env", ".env")).toBe(true);
      expect(covers(".env", ".env.local")).toBe(false);
      expect(covers(".env*", ".env.local")).toBe(true);
    });

    it("segments like ..x or ... are ordinary names", () => {
      expect(covers("a/**", "a/..b/c")).toBe(true);
      expect(covers("a/*", "a/...")).toBe(true);
    });
  });

  describe("only * ? ** are special", () => {
    it("[], {}, !, \\ and . are literal characters", () => {
      expect(covers("a[1].txt", "a[1].txt")).toBe(true);
      expect(covers("a[1].txt", "a1.txt")).toBe(false);
      expect(covers("{a,b}.txt", "a.txt")).toBe(false);
      expect(covers("{a,b}.txt", "{a,b}.txt")).toBe(true);
      expect(covers("a.b", "aXb")).toBe(false); // . is not "any character"
      expect(covers("!x", "!x")).toBe(true);
      expect(covers("a+b", "aab")).toBe(false);
      expect(covers("a(b)", "a(b)")).toBe(true);
    });

    it("a literal * in the requested path is just a character", () => {
      expect(covers("src/a*b.txt", "src/a*b.txt")).toBe(true);
      expect(covers("src/exact.txt", "src/*.txt")).toBe(false); // can't claim a pattern as a path
      expect(covers("src/x.txt", "src/*")).toBe(false);
    });
  });

  describe("traversal and malformed requests never match", () => {
    it.each([
      "src/api/../../secrets/key",
      "src/api/../x",
      "../src/api/x",
      "/src/api/x",
      "src//api/x",
      "src/api/x/",
      "./src/api/x",
      "src/./api/x",
      "src\\api\\x",
      "",
    ])("%s", (path) => {
      expect(covers("src/**", path)).toBe(false);
      expect(covers("**", path)).toBe(false);
      expect(capabilityMatches("workspace.write", `workspace.write:${path}`)).toBe(
        path !== "" &&
          !path.includes("..") &&
          !path.startsWith("/") &&
          !path.includes("//") &&
          !path.endsWith("/") &&
          !path.startsWith("./") &&
          !path.includes("/./") &&
          !path.includes("\\"),
      );
    });

    it("a request for an unscoped path-escape also fails through an unscoped grant", () => {
      // An unscoped grant covers all valid scopes, but an invalid request is refused anyway.
      expect(capabilityMatches("workspace.write", "workspace.write:src/../x")).toBe(false);
      expect(capabilityMatches("workspace.write", "workspace.write:/abs")).toBe(false);
    });
  });
});

describe("capabilityMatches: other resources use IAM-style globs", () => {
  it("exact scopes match exactly", () => {
    expect(
      capabilityMatches(
        "github.create_pull_request:org/repo",
        "github.create_pull_request:org/repo",
      ),
    ).toBe(true);
    expect(
      capabilityMatches(
        "github.create_pull_request:org/repo",
        "github.create_pull_request:org/repo2",
      ),
    ).toBe(false);
    expect(
      capabilityMatches(
        "github.create_pull_request:org/repo",
        "github.create_pull_request:other/repo",
      ),
    ).toBe(false);
  });

  it("* matches any run of characters, / and : included", () => {
    expect(
      capabilityMatches(
        "aws.deploy_lambda:function/staging-*",
        "aws.deploy_lambda:function/staging-api",
      ),
    ).toBe(true);
    expect(
      capabilityMatches(
        "aws.deploy_lambda:function/staging-*",
        "aws.deploy_lambda:function/staging-a/b",
      ),
    ).toBe(true);
    expect(
      capabilityMatches(
        "aws.deploy_lambda:function/staging-*",
        "aws.deploy_lambda:function/prod-api",
      ),
    ).toBe(false);
    expect(
      capabilityMatches(
        "aws.read_logs:arn:aws:logs:*",
        "aws.read_logs:arn:aws:logs:us-east-1:123:log-group:/x/y",
      ),
    ).toBe(true);
    expect(
      capabilityMatches("aws.read_logs:arn:aws:logs:*", "aws.read_logs:arn:aws:s3:::bucket"),
    ).toBe(false);
    expect(
      capabilityMatches("github.create_pull_request:org/*", "github.create_pull_request:org/repo"),
    ).toBe(true);
    expect(
      capabilityMatches(
        "github.create_pull_request:org/*",
        "github.create_pull_request:other/repo",
      ),
    ).toBe(false);
  });

  it("? matches exactly one character", () => {
    expect(capabilityMatches("aws.deploy_lambda:fn-?", "aws.deploy_lambda:fn-1")).toBe(true);
    expect(capabilityMatches("aws.deploy_lambda:fn-?", "aws.deploy_lambda:fn-12")).toBe(false);
  });

  it("a prefix is not a match: the whole scope must match", () => {
    expect(capabilityMatches("slack.post_message:#eng", "slack.post_message:#eng-private")).toBe(
      false,
    );
    expect(capabilityMatches("slack.post_message:#eng*", "slack.post_message:#eng-private")).toBe(
      true,
    );
  });
});

describe("capabilityMatches never throws", () => {
  it("returns false for malformed input on either side", () => {
    const bad = [
      "",
      "x",
      "a.b.c",
      "tasks.*",
      "workspace.write:",
      "workspace.write:../x",
      undefined,
      null,
      5,
      {},
    ];
    for (const g of bad) {
      for (const r of ["workspace.write", ...bad]) {
        expect(() =>
          capabilityMatches(g as unknown as string, r as unknown as string),
        ).not.toThrow();
      }
    }
    expect(capabilityMatches("tasks.*", "tasks.claim")).toBe(false);
    expect(capabilityMatches("workspace.write:../x", "workspace.write:../x")).toBe(false);
    expect(capabilityMatches("", "")).toBe(false);
  });

  it("stays fast on pathological globs", () => {
    const pattern = `${Array.from({ length: 40 }, () => "**").join("/")}/x.ts`;
    const path = `${Array.from({ length: 200 }, (_, i) => `d${i}`).join("/")}/y.ts`;
    const started = Date.now();
    expect(capabilityMatches(`workspace.write:${pattern}`, `workspace.write:${path}`)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);

    const stars = `${"*a".repeat(30)}*b`;
    const text = "a".repeat(200);
    const t2 = Date.now();
    expect(capabilityMatches(`aws.read_logs:${stars}`, `aws.read_logs:${text}`)).toBe(false);
    expect(Date.now() - t2).toBeLessThan(1_000);

    const wildcardStarted = performance.now();
    expect(pathGlobMatch("*x".repeat(12) + "y", "x".repeat(255))).toBe(false);
    expect(performance.now() - wildcardStarted).toBeLessThan(50);
  });
});

describe("tierOf", () => {
  it("is 0 for the room's reads and for external reads", () => {
    for (const c of [
      "workspace.read",
      "room.read",
      "tasks.read",
      "github.read_repository",
      "aws.read_logs",
    ]) {
      expect(tierOf(c), c).toBe(0);
    }
  });

  it("is 1 for room-internal writes", () => {
    for (const c of [
      "workspace.write",
      "tasks.claim",
      "memory.write",
      "sandbox.exec",
      "messages.send",
      "decisions.decide",
    ]) {
      expect(tierOf(c), c).toBe(1);
    }
  });

  it("is 2 for external, reversible side effects", () => {
    for (const c of ["github.create_pull_request", "slack.post_message", "browser.navigate"]) {
      expect(tierOf(c), c).toBe(2);
    }
  });

  it("is 3 for production and irreversible actions, and for granting Tier 3", () => {
    expect(tierOf("aws.deploy_lambda")).toBe(3);
    expect(tierOf("capabilities.grant_tier3")).toBe(3);
  });

  it("uses scope for scoped tiers and otherwise preserves the base tier", () => {
    expect(tierOf("aws.deploy_lambda:function/staging-*")).toBe(3);
    expect(tierOf("aws.deploy_lambda:staging-api")).toBe(2);
    expect(tierOf("aws.deploy_lambda:prod-api")).toBe(3);
    expect(tierOf("aws.deploy_lambda:Staging-api")).toBe(3);
    expect(tierOf("aws.deploy_lambda")).toBe(3);
    expect(tierOf("workspace.write:src/**")).toBe(1);
    expect(tierOf("github.create_pull_request:org/repo")).toBe(2);
  });

  it("is 3 for anything unknown (fail closed)", () => {
    for (const c of [
      "acme.launch_rocket",
      "workspace.explode",
      "github.delete_repository:org/repo",
    ]) {
      expect(tierOf(c), c).toBe(3);
    }
  });

  it("throws VALIDATION for a malformed capability", () => {
    expect(() => tierOf("nope")).toThrow(CrossoverError);
    expect(() => tierOf("tasks.*")).toThrow(CrossoverError);
  });

  it("gives every catalog capability a tier: reads 0, everything else 1 except grant_tier3", () => {
    for (const [name, def] of Object.entries(CAPABILITIES)) {
      const expected = name === "capabilities.grant_tier3" ? 3 : def.mutating ? 1 : 0;
      expect(tierOf(name), name).toBe(expected);
    }
  });
});

describe("isSafeRequestPath / capabilityMatchesPath", () => {
  it("accepts ordinary paths, including spaces and unicode", () => {
    for (const path of [
      "a",
      "src/a.ts",
      "docs/My File ü.md",
      ".github/workflows/ci.yml",
      "a/.env",
    ]) {
      expect(isSafeRequestPath(path)).toBe(true);
    }
  });

  it("rejects paths that could leave the workspace or are malformed", () => {
    for (const path of [
      "",
      "/a",
      "a/",
      "a//b",
      ".",
      "..",
      "a/../b",
      "./a",
      "a\\b",
      "a\u0000b",
      "a\nb",
    ]) {
      expect(isSafeRequestPath(path)).toBe(false);
    }
  });

  it("matches a scoped grant against the path as is", () => {
    expect(
      capabilityMatchesPath("workspace.write:docs/**", "workspace.write", "docs/My File.md"),
    ).toBe(true);
    expect(capabilityMatchesPath("workspace.write:docs/**", "workspace.write", "src/a.ts")).toBe(
      false,
    );
    expect(capabilityMatchesPath("workspace.write", "workspace.write", "src/a.ts")).toBe(true);
    expect(capabilityMatchesPath("workspace.read:docs/**", "workspace.write", "docs/a.md")).toBe(
      false,
    );
    expect(capabilityMatchesPath("tasks.create:x/**", "tasks.create", "x/y")).toBe(false); // not path-scoped
  });

  it("fails closed for an unsafe path or a malformed grant, and never throws", () => {
    expect(capabilityMatchesPath("workspace.write", "workspace.write", "../a")).toBe(false);
    expect(capabilityMatchesPath("not a capability", "workspace.write", "a")).toBe(false);
  });
});
