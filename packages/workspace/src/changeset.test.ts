import { expect, it } from "vitest";
import { changesetParamsSchema } from "./changeset.js";

const params = { source: "API", message: "Edit", base_workspace_revision: 0, operations: [] };
it("normalizes paths and supplies the base-file map", () => {
  expect(
    changesetParamsSchema.parse({
      ...params,
      operations: [{ type: "rename", from: "./old", to: "cafe\u0301.txt" }],
    }),
  ).toMatchObject({
    base_file_revisions: {},
    operations: [{ type: "rename", from: "old", to: "café.txt" }],
  });
});
it("rejects extra identity fields and ambiguous operations", () => {
  for (const value of [
    { ...params, workspace_id: "wrong-room" },
    { ...params, actor_id: "forged" },
    { ...params, operations: [{ type: "modify", path: "file", content: "x", patch: "patch" }] },
    {
      ...params,
      operations: Array.from({ length: 501 }, () => ({ type: "delete", path: "file" })),
    },
    { ...params, base_workspace_revision: Number.MAX_SAFE_INTEGER + 1 },
  ])
    expect(changesetParamsSchema.safeParse(value).success).toBe(false);
});
it("enforces the aggregate UTF-8 text limit", () => {
  const content = "é".repeat(7 * 1024 * 1024);
  expect(
    changesetParamsSchema.safeParse({
      ...params,
      operations: [
        { type: "create", path: "one", content },
        { type: "create", path: "two", content },
      ],
    }).success,
  ).toBe(false);
});
