import { describe, expect, it } from "vitest";
import {
  createSandboxReadToken,
  verifySandboxReadToken,
  type SandboxReadTokenClaims,
} from "./sandbox-read-token.js";

const secret = "a sufficiently long sandbox read token signing secret";
const claims: SandboxReadTokenClaims = {
  room_id: "room_01JABC",
  participant_id: "part_01JDEF",
  sandbox_id: "sandbox_01JGHI",
  expires_at: 2_000,
};

describe("sandbox read tokens", () => {
  it("round trips room, participant, sandbox, and expiry claims", () => {
    const token = createSandboxReadToken(claims, secret, 1_000);

    expect(verifySandboxReadToken(token, secret, 1_999)).toEqual(claims);
  });

  it("rejects an expired token, a wrong secret, and a modified token", () => {
    const token = createSandboxReadToken(claims, secret, 1_000);

    expect(verifySandboxReadToken(token, secret, 2_000)).toBeNull();
    expect(verifySandboxReadToken(token, `${secret}!`, 1_999)).toBeNull();
    expect(verifySandboxReadToken(`${token.slice(0, -1)}x`, secret, 1_999)).toBeNull();
  });

  it("refuses short signing secrets and malformed claims", () => {
    expect(() => createSandboxReadToken(claims, "short")).toThrow(/at least 32 bytes/);
    expect(() => createSandboxReadToken({ ...claims, participant_id: "" }, secret, 1_000)).toThrow(
      /Invalid sandbox read token claims/,
    );
    expect(() => createSandboxReadToken({ ...claims, expires_at: 301_001 }, secret, 1_000)).toThrow(
      /Invalid sandbox read token claims/,
    );
  });
});
