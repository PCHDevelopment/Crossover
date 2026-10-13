import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { capabilityMatches, capabilityMatchesPath, isSafeRequestPath } from "./capability.js";
import { createPolicyEngine, type AuthzFacts, type PolicyEngine } from "./engine.js";

/**
 * The scope matching of the compiled policy (policy/scope.rego) against the TypeScript it replaced
 * at decision time (capability.ts, glob.ts), which stays for validating grants when they are
 * created. The two must never drift apart, so this runs in CI for good: every grant against every
 * request of a fixed corpus, and a seeded random one.
 *
 * The only known difference is for astral characters (emoji): Rego counts code points and the
 * TypeScript UTF-16 units, so `?` and the length limits (512 / 4096) differ for them. Grants in the
 * database were validated by the TypeScript, and the corpus below leaves astral characters out
 * except in the one test that pins the difference.
 */
const WASM = new URL("../policy/policy.wasm", import.meta.url);

/**
 * The three big comparisons run about 24,000, 11,000 and 6,000 policy decisions. Measured on a 4-core
 * machine (T1527): 2.2 s, 0.6 s and 0.6 s alone, and the same inside the whole parallel `pnpm test`;
 * 4.3 s, 1.7 s and 1.6 s with the CPUs oversubscribed three times over. On the shared CI runner the
 * first one took more than vitest's default 5 s (the file 8.8 s), which failed unrelated PRs. Every
 * case stays; the budget is 30 s, seven times the oversubscribed run.
 */
const ORACLE_TIMEOUT_MS = 30_000;

const SCOPES = [
  "",
  "*",
  "**",
  "src/**",
  "src/*",
  "src/*.ts",
  "**/*.ts",
  "a/**/b",
  "a/**/**/b",
  "a/b",
  "src/.env",
  ".env",
  "a.b",
  "a+b",
  "(a)",
  "a|b",
  "^a$",
  "a$",
  "[ab]",
  "{a,b}",
  "a\\b",
  "!a",
  "a?b",
  "a??",
  "?",
  "??",
  "a b",
  "x:y",
  "arn:aws:s3:::bucket/*",
  "org/repo",
  "org/*",
  "function/staging-*",
  "..",
  "a/../b",
  "/a",
  "a//b",
  "a/",
  "./a",
  "ünï/**",
  "**/a/**",
  "a/**/",
  "a**",
  "**a",
  "*a*",
  "a*b*c",
  "a.ts",
  "ab",
  "a/b/c/d",
  "a\tb",
  "a\nb",
];
const BASES = ["workspace.write", "github.create_pull_request", "tasks.read"];
const WITH_SCOPES = (base: string) => [base, ...SCOPES.map((s) => `${base}:${s}`)];
const CAPABILITIES = BASES.flatMap(WITH_SCOPES);
const REQUESTS = [
  ...CAPABILITIES,
  "",
  "tasks.*",
  "Tasks.read",
  "tasks",
  "tasks.read:",
  "x".repeat(600),
  `workspace.write:${"a/".repeat(300)}`,
];
const PATHS = [
  "",
  "a",
  "a/b",
  "src/a.ts",
  "src/x/y.ts",
  ".env",
  "src/.env",
  "a b",
  "a.b",
  "a+b",
  "(a)",
  "a|b",
  "^a$",
  "a$",
  "[ab]",
  "{a,b}",
  "a\\b",
  "..",
  "a/../b",
  "/a",
  "a//b",
  "a/",
  "./a",
  "ünï/x",
  "a?b",
  "a*b",
  "tab\tx",
  "nl\nx",
  "x".repeat(5000),
  "a/b/c/d",
  "b",
  "a/b/b",
  "org/repo",
  "x:y",
  "**",
  "*",
];

/** Everything but the revocation lets the command through, so a revocation is the only way to a
 * "revoked" reason: it tells whether the policy found the grant to cover the request. */
function facts(action: string, resourcePath: string | null, covering: string): AuthzFacts {
  return {
    method: "workspace.search",
    room_match: true,
    participant: { status: "ACTIVE", authority: "MEMBER", role: "OBSERVER" },
    room_status: "ACTIVE",
    mutating: false,
    approved: false,
    action,
    resource_path: resourcePath,
    per_path: false,
    grants: [],
    denies: [{ capability: covering }],
  };
}

const covered = (engine: PolicyEngine, f: AuthzFacts): "covered" | "invalid_path" | "no" => {
  const d = engine.decide(f);
  // Allowed: nothing revoked it (a read in the observer's bundle, say).
  if (d.allow) return "no";
  return d.reason === "revoked" ? "covered" : d.reason === "invalid_path" ? "invalid_path" : "no";
};

/** What the TypeScript decides for the same request, as authorize() used to compute it. */
function expectedCover(
  granted: string,
  action: string,
  path: string | null,
): "covered" | "invalid_path" | "no" {
  const base = action.split(":", 1)[0] ?? "";
  const pathScoped = base.split(".", 1)[0] === "workspace";
  if (path !== null && action === base && pathScoped) {
    if (path !== "" && !isSafeRequestPath(path)) return "invalid_path";
    return capabilityMatchesPath(granted, base, path) ? "covered" : "no";
  }
  return capabilityMatches(granted, action) ? "covered" : "no";
}

function expectNoMismatch(mismatches: string[], total: number): void {
  expect(total).toBeGreaterThan(1000);
  expect(mismatches.slice(0, 20)).toEqual([]);
}

describe("scope matching in the compiled policy equals the TypeScript", () => {
  it(
    "covers a requested capability exactly as capabilityMatches() does",
    async () => {
      const engine = await createPolicyEngine(await readFile(WASM));
      const mismatches: string[] = [];
      let total = 0;
      for (const granted of CAPABILITIES) {
        for (const requested of REQUESTS) {
          total++;
          const policy = covered(engine, facts(requested, null, granted));
          const expected = expectedCover(granted, requested, null);
          if (policy !== expected) {
            mismatches.push(
              `${JSON.stringify({ granted, requested })}: policy ${policy}, ts ${expected}`,
            );
          }
        }
      }
      expectNoMismatch(mismatches, total);
    },
    ORACLE_TIMEOUT_MS,
  );

  it(
    "covers a workspace path exactly as capabilityMatchesPath() does, and refuses unsafe paths",
    async () => {
      const engine = await createPolicyEngine(await readFile(WASM));
      const mismatches: string[] = [];
      let total = 0;
      for (const granted of CAPABILITIES) {
        for (const base of ["workspace.write", "tasks.read"]) {
          for (const path of PATHS) {
            total++;
            const policy = covered(engine, facts(base, path, granted));
            const expected = expectedCover(granted, base, path);
            if (policy !== expected) {
              mismatches.push(
                `${JSON.stringify({ granted, base, path })}: policy ${policy}, ts ${expected}`,
              );
            }
          }
        }
      }
      expectNoMismatch(mismatches, total);
    },
    ORACLE_TIMEOUT_MS,
  );

  it(
    "agrees on a seeded random corpus of patterns and texts",
    async () => {
      const engine = await createPolicyEngine(await readFile(WASM));
      let seed = 20261013;
      const next = (): number => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 2 ** 32;
      };
      const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
      const ALPHABET = [
        "a",
        "b",
        "c",
        ".",
        "+",
        "(",
        ")",
        "|",
        "^",
        "$",
        "[",
        "]",
        "{",
        "}",
        "\\",
        "!",
        "*",
        "*",
        "?",
        "-",
        "é",
      ];
      const SEGMENT_JOINERS = ["/", "/", "/**/", "/**"];
      const word = (n: number): string => Array.from({ length: n }, () => pick(ALPHABET)).join("");
      const text = (): string => {
        const segments = Array.from({ length: 1 + Math.floor(next() * 4) }, () =>
          word(1 + Math.floor(next() * 3)).replace(/\*/g, pick(["*", "a"])),
        );
        return segments.join("/");
      };
      const mismatches: string[] = [];
      let total = 0;
      for (let i = 0; i < 3000; i++) {
        const pattern = text() + (next() < 0.3 ? pick(SEGMENT_JOINERS) + word(2) : "");
        const subject =
          next() < 0.5
            ? text()
            : pattern
                .replace(/\*+/g, () => word(1 + Math.floor(next() * 3)).replace(/[*/]/g, "a"))
                .replace(/\?/g, "a");
        for (const base of ["workspace.write", "github.create_pull_request"]) {
          const granted = `${base}:${pattern}`;
          const requested = `${base}:${subject}`;
          total++;
          const policy = covered(engine, facts(requested, null, granted));
          const expected = expectedCover(granted, requested, null);
          if (policy !== expected) {
            mismatches.push(
              `${JSON.stringify({ granted, requested })}: policy ${policy}, ts ${expected}`,
            );
          }
        }
      }
      expectNoMismatch(mismatches, total);
    },
    ORACLE_TIMEOUT_MS,
  );

  it("differs only for astral characters, where Rego counts code points and the TypeScript UTF-16 units", async () => {
    const engine = await createPolicyEngine(await readFile(WASM));
    // `?` is one code point in Rego and one UTF-16 unit in the TypeScript: an emoji is two units.
    const granted = "github.create_pull_request:a?";
    const requested = "github.create_pull_request:a\u{1F600}";
    expect(capabilityMatches(granted, requested)).toBe(false);
    expect(covered(engine, facts(requested, null, granted))).toBe("covered");
  });
});
