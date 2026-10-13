import { CrossoverError } from "@crossover/protocol";
import { describe, expect, it } from "vitest";

describe("tierOf() before the policy is loaded", () => {
  it("is UNAVAILABLE, not a tier (fail closed)", async () => {
    // A fresh module graph: nothing in this file loads the policy.
    const { tierOf } = await import("./capability.js");
    for (const capability of [
      "tasks.read",
      "aws.deploy_lambda:staging-api",
      "acme.launch_rocket",
    ]) {
      expect(() => tierOf(capability), capability).toThrow(CrossoverError);
      try {
        tierOf(capability);
      } catch (error) {
        expect((error as CrossoverError).code).toBe("UNAVAILABLE");
      }
    }
  });

  it("still rejects a malformed capability as VALIDATION, which needs no policy", async () => {
    const { tierOf } = await import("./capability.js");
    try {
      tierOf("tasks.*");
      expect.unreachable();
    } catch (error) {
      expect((error as CrossoverError).code).toBe("VALIDATION");
    }
  });
});
