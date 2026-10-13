import { CrossoverError } from "@crossover/protocol";
import { describe, expect, it, vi } from "vitest";

// The grant decision comes from the policy; when it cannot be had, validation must not read that
// as "the capability field reports it".
vi.mock("@crossover/policy", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  grantCheck: () => {
    throw new CrossoverError("UNAVAILABLE", "The authorization policy is not loaded");
  },
}));

const { capabilitiesGrantParams } = await import("./grants.js");

describe("capabilities.grant when the policy cannot check a grant", () => {
  it("fails with UNAVAILABLE instead of passing validation", () => {
    expect(() =>
      capabilitiesGrantParams.safeParse({
        participant_id: "part_0000000000",
        capability: "aws.deploy_lambda:staging-api",
      }),
    ).toThrow(expect.objectContaining({ code: "UNAVAILABLE" }));
  });
});
