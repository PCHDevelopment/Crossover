import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  createPolicyEngine,
  parseDecision,
  PolicyEngineError,
  initPolicy,
  type AuthzFacts,
} from "./engine.js";

const WASM = new URL("../policy/policy.wasm", import.meta.url);

/** An active member of an active room whose role bundle covers the action. */
const allowed: AuthzFacts = {
  room_match: true,
  participant: { status: "ACTIVE", authority: "MEMBER", role: "DEVELOPER" },
  capability: "messages.send",
  room_status: "ACTIVE",
  mutating: true,
  path_invalid: false,
  denied: false,
  covering: { any: false, ungated: false },
  approved: false,
  per_path_gate: false,
};

describe("the compiled policy", () => {
  it("answers the ladder: allow, and a refusal with its code and reason", async () => {
    const engine = await createPolicyEngine(await readFile(WASM));
    expect(engine.decide(allowed)).toEqual({ allow: true });
    expect(engine.decide({ ...allowed, capability: "room.freeze" })).toEqual({
      allow: false,
      code: "FORBIDDEN",
      reason: "missing_capability",
    });
    expect(
      engine.decide({
        ...allowed,
        participant: { status: "PAUSED", authority: "MEMBER", role: "DEVELOPER" },
      }),
    ).toEqual({ allow: false, code: "PARTICIPANT_PAUSED", reason: "participant_paused" });
  });

  it("refuses facts that are missing or of the wrong type instead of guessing", async () => {
    const engine = await createPolicyEngine(await readFile(WASM));
    const { capability: _removed, ...incomplete } = allowed;
    void _removed;
    for (const facts of [
      incomplete,
      { ...allowed, capability: true },
      { ...allowed, covering: null },
      {},
    ]) {
      expect(engine.decide(facts as unknown as AuthzFacts)).toMatchObject({
        allow: false,
        code: "FORBIDDEN",
        reason: "invalid_input",
      });
    }
  });

  it("is unavailable, not permissive, when the module is empty, random or truncated", async () => {
    const real = await readFile(WASM);
    for (const bytes of [
      new Uint8Array(),
      randomBytes(4096),
      real.subarray(0, Math.floor(real.length / 2)),
    ]) {
      await expect(createPolicyEngine(bytes)).rejects.toBeInstanceOf(PolicyEngineError);
    }
  });

  it("evaluates fast: the policy alone is microseconds", async () => {
    const engine = await createPolicyEngine(await readFile(WASM));
    const started = performance.now();
    for (let i = 0; i < 2000; i++) engine.decide(allowed);
    expect((performance.now() - started) / 2000).toBeLessThan(0.5); // ms; about 0.005 measured
  });

  it("reports the digest of the module it runs, for the startup log", async () => {
    const real = await readFile(WASM);
    expect(await initPolicy()).toEqual({
      sha256: createHash("sha256").update(real).digest("hex"),
      bytes: real.length,
    });
  });
});

describe("parseDecision accepts exactly one well-formed answer", () => {
  it("takes an allow and a coded refusal", () => {
    expect(parseDecision([{ result: { allow: true } }])).toEqual({ allow: true });
    expect(
      parseDecision([{ result: { allow: false, code: "ROOM_PAUSED", reason: "room_not_active" } }]),
    ).toEqual({ allow: false, code: "ROOM_PAUSED", reason: "room_not_active" });
  });

  it.each([
    ["no result", undefined],
    ["an empty result set", []],
    ["two results", [{ result: { allow: true } }, { result: { allow: true } }]],
    ["an undefined decision", [{}]],
    ["a non-object decision", [{ result: "allow" }]],
    ["a string allow", [{ result: { allow: "true" } }]],
    ["an allow carrying more than allow", [{ result: { allow: true, code: "FORBIDDEN" } }]],
    ["a refusal without a reason", [{ result: { allow: false, code: "FORBIDDEN" } }]],
    ["a refusal with an unknown code", [{ result: { allow: false, code: "TEAPOT", reason: "x" } }]],
    [
      "a refusal with an internal code",
      [{ result: { allow: false, code: "STALE_FENCE", reason: "x" } }],
    ],
  ])("rejects %s", (_name, result) => {
    expect(() => parseDecision(result)).toThrow(PolicyEngineError);
  });
});
