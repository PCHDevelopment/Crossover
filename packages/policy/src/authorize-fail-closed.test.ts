import type { PoolClient } from "@crossover/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authorize } from "./authorize.js";
import * as engine from "./engine.js";
import type * as Engine from "./engine.js";

vi.mock("./engine.js", async (importOriginal) => ({
  ...(await importOriginal<typeof Engine>()),
  policyEngine: vi.fn(),
}));

const policyEngine = vi.mocked(engine.policyEngine);

/** A client that answers the two lookups with an active, fully capable developer. */
const client = {
  query: vi.fn(async (sql: string) =>
    sql.includes("FROM participants")
      ? {
          rows: [
            { authority: "MEMBER", role: "DEVELOPER", status: "ACTIVE", room_status: "ACTIVE" },
          ],
        }
      : { rows: [] },
  ),
} as unknown as PoolClient;

const run = () =>
  authorize(
    { participant_id: "part_1", room_id: "room_1" },
    "tasks.list",
    { room_id: "room_1" },
    { method: "tasks.list", params: {}, client },
  );

beforeEach(() => {
  policyEngine.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("authorize() fails closed when the policy cannot answer", () => {
  it("allows when the policy says so (the control for the cases below)", async () => {
    policyEngine.mockResolvedValue({ decide: () => ({ allow: true }) });
    await expect(run()).resolves.toBeUndefined();
  });

  it.each([
    ["the module cannot be loaded", () => policyEngine.mockRejectedValue(new Error("no wasm"))],
    [
      "evaluation throws",
      () =>
        policyEngine.mockResolvedValue({
          decide: () => {
            throw new engine.PolicyEngineError("boom");
          },
        }),
    ],
    [
      "it refuses with a reason this code does not know",
      () =>
        policyEngine.mockResolvedValue({
          decide: () => ({ allow: false, code: "FORBIDDEN", reason: "a_new_reason" }),
        }),
    ],
    [
      "it says the facts were invalid",
      () =>
        policyEngine.mockResolvedValue({
          decide: () => ({ allow: false, code: "FORBIDDEN", reason: "invalid_input" }),
        }),
    ],
  ])("refuses with UNAVAILABLE when %s", async (_name, arrange) => {
    arrange();
    await expect(run()).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
});
