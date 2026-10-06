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

it("accepts exactly 500 operations and rejects the 501st", () => {
  const operations = Array.from({ length: 500 }, (_, index) => ({
    type: "delete",
    path: `file${index}`,
  }));
  expect(changesetParamsSchema.safeParse({ ...params, operations }).success).toBe(true);
  expect(
    changesetParamsSchema.safeParse({
      ...params,
      operations: [...operations, { type: "delete", path: "overflow" }],
    }).success,
  ).toBe(false);
});

it("accepts exactly 25 MiB across UTF-8 contents, patches and rename replacements, then rejects one extra byte", () => {
  const operations = [
    { type: "create", path: "one", content: "é".repeat(4 * 1024 * 1024) },
    { type: "modify", path: "two", patch: "p".repeat(7 * 1024 * 1024) },
    { type: "rename", from: "old", to: "new", content: "r".repeat(10 * 1024 * 1024) },
  ];
  expect(changesetParamsSchema.safeParse({ ...params, operations }).success).toBe(true);
  expect(
    changesetParamsSchema.safeParse({
      ...params,
      operations: [...operations, { type: "create", path: "overflow", content: "x" }],
    }).success,
  ).toBe(false);
});

it("counts base64 decoded bytes at exactly 25 MiB rather than its larger wire representation", () => {
  const content = Buffer.alloc(25 * 1024 * 1024, 120).toString("base64");
  const operations = [{ type: "create", path: "binary", content, encoding: "base64" }];
  expect(content.length).toBeGreaterThan(25 * 1024 * 1024);
  expect(changesetParamsSchema.safeParse({ ...params, operations }).success).toBe(true);
  expect(
    changesetParamsSchema.safeParse({
      ...params,
      operations: [...operations, { type: "create", path: "overflow", content: "x" }],
    }).success,
  ).toBe(false);
});
