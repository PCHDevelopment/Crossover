import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { CAPABILITIES } from "./bundles.js";
import { parseCapability, tierOf } from "./capability.js";
import { createPolicyEngine, initPolicy, type PolicyEngine } from "./engine.js";
import { capabilityTier, CATALOG_TIER_3, EXTERNAL_TIERS, SCOPED_TIER_RULES } from "./tiers.js";

/**
 * The tier rules of the compiled policy (policy/tiers.rego) against the TypeScript reference
 * (`capabilityTier` in tiers.ts) they replaced at decision time. The two must never drift apart,
 * so this runs in CI for good: every catalog capability, every external one and every scoped one,
 * each against a corpus of scopes, then a seeded random corpus of bases and scopes.
 */
const WASM = new URL("../policy/policy.wasm", import.meta.url);

let engine: PolicyEngine;
beforeAll(async () => {
  engine = await createPolicyEngine(await readFile(WASM));
  await initPolicy(); // `tierOf` reads the shipped engine
});

/**
 * An explicit budget for the two big comparisons (T1527 rule: a test that loops thousands of cases
 * gets a measured timeout). Measured on 4 cores, alone: 43 and 49 ms for the 1,900 base x scope
 * cases, 96 and 84 ms for the 5,000 random ones (file 0.15 s). The shared CI runner has been seen
 * at 4x the local time under load (scope-oracle.test.ts, T1527); 30 s is over 200x the slower
 * measurement.
 */
const ORACLE_TIMEOUT_MS = 30_000;

const SCOPES: (string | undefined)[] = [
  undefined,
  "",
  "*",
  "staging-",
  "staging-api",
  "staging-api:v2",
  "staging-*",
  "Staging-api",
  "STAGING-api",
  " staging-api",
  "staging",
  "stagin",
  "prod-api",
  "function/staging-*",
  "arn:aws:lambda:eu-west-1:123456789012:function:staging-api",
  "org/repo",
  "src/**",
  "staging-ünï",
  "staging-😀",
  "😀staging-",
];

const BASES = [
  ...Object.keys(CAPABILITIES),
  ...Object.keys(EXTERNAL_TIERS),
  ...Object.keys(SCOPED_TIER_RULES),
  ...CATALOG_TIER_3,
  // Not classified: tier 3.
  "acme.launch_rocket",
  "workspace.explode",
  "github.delete_repository",
  "aws.deploy_lambdas",
  "aws.deploy_lambd",
  "AWS.deploy_lambda",
  "tasks.READ",
  "",
  ".",
  "constructor",
  "__proto__",
  "toString",
  "hasOwnProperty",
  "valueOf",
  "tasks.read ",
  " tasks.read",
  "tasks.read\n",
];

describe("tier rules: the policy against capabilityTier()", () => {
  it(
    "agrees on every base against every scope",
    () => {
      let cases = 0;
      for (const base of BASES) {
        for (const scope of SCOPES) {
          expect(engine.tier(base, scope), `${base} ${scope}`).toBe(capabilityTier(base, scope));
          cases++;
        }
      }
      expect(cases).toBeGreaterThan(1_500);
    },
    ORACLE_TIMEOUT_MS,
  );

  it(
    "agrees on a seeded random corpus",
    () => {
      let seed = 0x7e57;
      const next = (n: number): number => {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        return seed % n;
      };
      const pieces = [
        "staging-",
        "stag",
        "ing-",
        "prod",
        "-",
        "x",
        "/",
        ":",
        "*",
        "Ü",
        "😀",
        " ",
        "",
      ];
      const word = (): string =>
        Array.from({ length: next(5) }, () => pieces[next(pieces.length)]).join("");
      const interesting = [...BASES, ...Object.keys(SCOPED_TIER_RULES)];
      for (let i = 0; i < 5_000; i++) {
        const base = next(3) === 0 ? word() : interesting[next(interesting.length)]!;
        const scope =
          next(4) === 0
            ? undefined
            : next(2) === 0
              ? `${SCOPED_TIER_RULES["aws.deploy_lambda"]!.prefix}${word()}`
              : word();
        expect(engine.tier(base, scope), `${JSON.stringify([base, scope])}`).toBe(
          capabilityTier(base, scope),
        );
      }
    },
    ORACLE_TIMEOUT_MS,
  );

  it("classifies the cases the rules exist for", () => {
    expect(engine.tier("tasks.read", undefined)).toBe(0);
    expect(engine.tier("messages.send", undefined)).toBe(1);
    expect(engine.tier("slack.post_message", undefined)).toBe(2);
    expect(engine.tier("aws.deploy_lambda", "staging-api")).toBe(2);
    expect(engine.tier("aws.deploy_lambda", "prod-api")).toBe(3);
    expect(engine.tier("aws.deploy_lambda", undefined)).toBe(3);
    expect(engine.tier("capabilities.grant_tier3", undefined)).toBe(3);
    expect(engine.tier("acme.launch_rocket", undefined)).toBe(3);
  });

  it("gives every catalog capability a tier: reads 0, writes 1, grant_tier3 3", () => {
    for (const [name, def] of Object.entries(CAPABILITIES)) {
      const expected = CATALOG_TIER_3.has(name) ? 3 : def.mutating ? 1 : 0;
      expect(engine.tier(name, undefined), name).toBe(expected);
    }
  });
});

describe("tierOf() is the policy's tier of the parsed capability", () => {
  it("equals capabilityTier() of the parsed base and scope", () => {
    for (const base of BASES.filter((b) => /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(b))) {
      for (const scope of [undefined, "staging-api", "prod-api", "org/repo", "src/**", "x:y"]) {
        const capability = scope === undefined ? base : `${base}:${scope}`;
        const parsed = parseCapability(capability);
        expect(tierOf(capability), capability).toBe(capabilityTier(parsed.base, parsed.scope));
      }
    }
  });
});
