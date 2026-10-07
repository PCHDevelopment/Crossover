import { createHmac } from "node:crypto";
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
  revision: 7,
  expires_at: 2_000,
};

describe("sandbox read tokens", () => {
  it("round trips room, participant, sandbox, and expiry claims", () => {
    const token = createSandboxReadToken(claims, secret, 1_000);

    expect(verifySandboxReadToken(token, secret, 1_999)).toEqual(claims);
  });

  it("rejects an expired token, a wrong secret, and a modified token", () => {
    const token = createSandboxReadToken(claims, secret, 1_000);
    const [payload, signature] = token.split(".");
    const tampered = `${payload}.${signature!.startsWith("A") ? "B" : "A"}${signature!.slice(1)}`;

    expect(verifySandboxReadToken(token, secret, 2_000)).toBeNull();
    expect(verifySandboxReadToken(token, `${secret}!`, 1_999)).toBeNull();
    expect(verifySandboxReadToken(tampered, secret, 1_999)).toBeNull();
  });

  it("rejects a signed token with more than five minutes remaining", () => {
    const payload = Buffer.from(JSON.stringify({ ...claims, expires_at: 301_001 })).toString(
      "base64url",
    );
    const signature = createHmac("sha256", secret)
      .update(`crossover-sandbox-workspace-read-v1\0${payload}`)
      .digest("base64url");

    expect(verifySandboxReadToken(`${payload}.${signature}`, secret, 1_000)).toBeNull();
  });

  it("refuses short signing secrets and malformed claims", () => {
    expect(() => createSandboxReadToken(claims, "short")).toThrow(/at least 32 bytes/);
    expect(() => createSandboxReadToken({ ...claims, participant_id: "" }, secret, 1_000)).toThrow(
      /Invalid sandbox read token claims/,
    );
    expect(() => createSandboxReadToken({ ...claims, revision: -1 }, secret, 1_000)).toThrow(
      /Invalid sandbox read token claims/,
    );
    expect(() => createSandboxReadToken({ ...claims, expires_at: 301_001 }, secret, 1_000)).toThrow(
      /Invalid sandbox read token claims/,
    );
  });
});
