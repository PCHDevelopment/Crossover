import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { parseCapability } from "./capability.js";
import { createPolicyEngine, type PolicyEngine } from "./engine.js";
import { capabilityTier } from "./tiers.js";

const WASM = new URL("../policy/policy.wasm", import.meta.url);

let engine: PolicyEngine;
beforeAll(async () => {
  engine = await createPolicyEngine(await readFile(WASM));
});

const CAPABILITIES = [
  "messages.read",
  "messages.send",
  "aws.deploy_lambda:staging-x",
  "aws.deploy_lambda:prod",
  "capabilities.grant_tier3",
  "nuclear.launch",
] as const;

const EXPIRIES_IN_MS: (number | null)[] = [null, -1, 0, 1, 3600000, 86400000, 86400001];

/** The grant checks from capabilities.grant before T1509 3b moved them into Rego. */
function grantCheckReference(capability: string, expiresInMs: number | null) {
  const { base, scope } = parseCapability(capability);
  const tier = capabilityTier(base, scope);
  if (expiresInMs !== null && expiresInMs <= 0) {
    return { allow: false, reason: "expiry_not_in_future" } as const;
  }
  if (tier === 3 && expiresInMs === null) {
    return { allow: false, reason: "tier3_needs_expiry" } as const;
  }
  if (tier === 3 && expiresInMs !== null && expiresInMs > 86400000) {
    return { allow: false, reason: "tier3_expiry_too_long" } as const;
  }
  return { allow: true } as const;
}

describe("grant rules: policy against the TypeScript reference", () => {
  it("agrees for every listed capability and expiry", () => {
    let cases = 0;
    for (const capability of CAPABILITIES) {
      const { base, scope } = parseCapability(capability);
      for (const expiresInMs of EXPIRIES_IN_MS) {
        expect(
          engine.grantCheck(base, scope, expiresInMs),
          JSON.stringify([capability, expiresInMs]),
        ).toEqual(grantCheckReference(capability, expiresInMs));
        cases++;
      }
    }
    expect(cases).toBe(42);
  });
});
