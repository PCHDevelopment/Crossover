import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  AUTHORITIES,
  CAPABILITIES,
  effectiveCapabilities,
  isCapability,
  ROLES,
} from "./bundles.js";
import { renderBundlesRego } from "./bundles-rego.js";
import { createPolicyEngine, type AuthzFacts } from "./engine.js";

const WASM = new URL("../policy/policy.wasm", import.meta.url);
const GENERATED = new URL("../policy/bundles.gen.rego", import.meta.url);

/** Everything but the role, authority and capability lets the command through. */
function facts(role: string, authority: string, capability: string): AuthzFacts {
  return {
    room_match: true,
    participant: { status: "ACTIVE", authority, role },
    room_status: "ACTIVE",
    mutating: true,
    approved: false,
    action: capability,
    resource_path: null,
    per_path: false,
    grants: [],
    denies: [],
  };
}

describe("role bundles and authority powers in the compiled policy", () => {
  it("covers exactly what effectiveCapabilities() covers, for every role, authority and capability", async () => {
    const engine = await createPolicyEngine(await readFile(WASM));
    let checked = 0;
    for (const role of ROLES) {
      for (const authority of AUTHORITIES) {
        const covered = effectiveCapabilities(role, authority);
        for (const capability of Object.keys(CAPABILITIES)) {
          expect(
            engine.decide(facts(role, authority, capability)),
            `${role} ${authority} ${capability}`,
          ).toEqual(
            covered.has(capability as never)
              ? { allow: true }
              : { allow: false, code: "FORBIDDEN", reason: "missing_capability" },
          );
          checked++;
        }
      }
    }
    expect(checked).toBe(ROLES.length * AUTHORITIES.length * Object.keys(CAPABILITIES).length);
  });

  it("refuses a capability that is not in the catalog, whoever asks", async () => {
    const engine = await createPolicyEngine(await readFile(WASM));
    const unknown = [
      "",
      "nothing.here",
      "tasks.*",
      "Tasks.read",
      "tasks.read ",
      "__proto__",
      "constructor",
    ];
    for (const capability of unknown) expect(isCapability(capability)).toBe(false);
    for (const role of ROLES) {
      for (const authority of AUTHORITIES) {
        for (const capability of unknown) {
          expect(engine.decide(facts(role, authority, capability))).toEqual({
            allow: false,
            code: "FORBIDDEN",
            reason: "unknown_capability",
          });
        }
      }
    }
  });

  it("refuses a participant whose role or authority the policy does not know", async () => {
    const engine = await createPolicyEngine(await readFile(WASM));
    for (const [role, authority] of [
      ["WIZARD", "MEMBER"],
      ["DEVELOPER", "KING"],
      ["", ""],
      ["developer", "member"],
    ] as const) {
      expect(engine.decide(facts(role, authority, "messages.send"))).toEqual({
        allow: false,
        code: "FORBIDDEN",
        reason: "invalid_participant",
      });
    }
  });

  it("is generated from bundles.ts: the committed Rego data is not stale", async () => {
    // `gen:wasm` formats the generated file with `opa fmt`, which only moves whitespace.
    const squash = (text: string): string => text.replace(/\s+/g, "");
    expect(squash(await readFile(GENERATED, "utf8"))).toBe(squash(renderBundlesRego()));
  });
});
