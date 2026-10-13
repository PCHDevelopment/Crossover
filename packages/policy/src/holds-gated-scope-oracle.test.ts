import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createPolicyEngine,
  type GatedDeny,
  type GatedGrant,
  type PolicyEngine,
} from "./engine.js";

const WASM = new URL("../policy/policy.wasm", import.meta.url);
const BASES = [
  "tools.invoke",
  "workspace.read",
  "aws.deploy_lambda",
  "messages.read",
  "tasks.approve",
] as const;
const SCOPE_PARTS = ["", "repo/main", "prod", "staging-x", "x:y", "2"] as const;

let engine: PolicyEngine;
beforeAll(async () => {
  engine = await createPolicyEngine(await readFile(WASM));
});

/** Exact TypeScript implementation from tools.ts before the policy move. */
function holdsGatedScopeReference(
  capability: string,
  grants: GatedGrant[],
  denies: GatedDeny[],
): boolean {
  const covers = (candidate: string) =>
    candidate === capability || candidate.startsWith(`${capability}:`);
  return (
    grants.some((grant) => grant.requires_approval && covers(grant.capability)) &&
    !denies.some((deny) => deny.capability === capability)
  );
}

describe("gated-scope policy against the old TypeScript function", () => {
  it("agrees on a seeded corpus of 2,000 capabilities and grant sets", () => {
    let seed = 0x15093c;
    const next = (size: number): number => {
      seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
      return seed % size;
    };
    const randomScope = (): string => SCOPE_PARTS[next(SCOPE_PARTS.length)]!;
    const randomWord = (): string => Array.from({ length: next(4) + 1 }, randomScope).join("");
    const randomTarget = (index: number): string => {
      // Pin each base with and without a scope, plus the two prefix look-alikes.
      if (index < BASES.length * 2) {
        const base = BASES[Math.floor(index / 2)]!;
        return index % 2 === 0 ? base : `${base}:repo/main`;
      }
      if (index === BASES.length * 2) return "tools.invoke2";
      if (index === BASES.length * 2 + 1) return "tools.invoke:";

      const base = BASES[next(BASES.length)]!;
      return next(3) === 0 ? base : `${base}:${randomScope()}`;
    };
    const relatedCapability = (capability: string): string => {
      switch (next(7)) {
        case 0:
          return capability;
        case 1:
          return `${capability}:${randomWord()}`;
        case 2:
          return `${capability}:`;
        case 3:
          return `${capability}2`;
        case 4:
          return BASES[next(BASES.length)]!;
        case 5:
          return `${BASES[next(BASES.length)]!}:${randomWord()}`;
        default:
          return next(2) === 0 ? "tools.invoke2" : "tools.invoke:";
      }
    };

    let cases = 0;
    for (let index = 0; index < 2_000; index++) {
      const capability = randomTarget(index);
      const grants: GatedGrant[] = [
        { capability: relatedCapability(capability), requires_approval: true },
        { capability: relatedCapability(capability), requires_approval: false },
        ...Array.from({ length: next(5) }, () => ({
          capability: relatedCapability(capability),
          requires_approval: next(2) === 0,
        })),
      ];
      const denies: GatedDeny[] = [
        {
          capability: index % 2 === 0 ? capability : `${capability}:${randomWord()}`,
        },
        ...Array.from({ length: next(4) }, () => ({
          capability: relatedCapability(capability),
        })),
      ];

      expect(
        engine.holdsGatedScope(capability, grants, denies),
        `case ${index}: ${JSON.stringify({ capability, grants, denies })}`,
      ).toBe(holdsGatedScopeReference(capability, grants, denies));
      cases++;
    }
    expect(cases).toBe(2_000);
  });
});
