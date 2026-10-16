import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withTransaction } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { allowAll, Dispatcher } from "@crossover/kernel";
import { newId } from "@crossover/protocol";
import { afterAll, beforeAll, expect, it } from "vitest";
import { registerWorkspaceCommands } from "./apply.js";
import { changesetParamsSchema } from "./changeset.js";
import { contentSize } from "./content.js";
import { git } from "./git.js";
import { provisionWorkspace } from "./provision.js";

let db: TestDatabase;
let root: string;
beforeAll(async () => {
  db = await createTestDatabase();
  root = await mkdtemp(join(tmpdir(), "crossover-binary-apply-"));
});
afterAll(async () => {
  await db.drop();
  await rm(root, { recursive: true, force: true });
});

// Measured (T1529): idle 3525 ms, 3x load 2146 ms; budget 7x.
it("applies and replays arbitrary binary bytes while keeping the durable payload JSONB-safe", async () => {
  const room = newId("room");
  await db.pool.query(
    "INSERT INTO rooms (id,slug,name,objective,owner_id) VALUES ($1,$1,'Room','Ship','actor')",
    [room],
  );
  await withTransaction(db.pool, (client) => provisionWorkspace(client, room, root));
  const repo = (await db.pool.query("SELECT repo_path FROM workspaces WHERE room_id = $1", [room]))
    .rows[0].repo_path as string;
  const d = new Dispatcher({ pool: db.pool, authorize: allowAll, nodeId: room });
  registerWorkspaceCommands(d);
  const principal = {
    room_id: room,
    participant_id: "actor",
    kind: "HUMAN" as const,
    authority: "OWNER" as const,
    role: "LEAD" as const,
  };
  for (const [index, type] of ["create", "modify", "rename"].entries()) {
    const bytes = Buffer.from([255, 128, 0, index, 10]);
    const content = bytes.toString("base64");
    const op =
      type === "rename"
        ? { type, from: "file", to: "renamed", content, encoding: "base64" }
        : { type, path: "file", content, encoding: "base64" };
    const input = {
      id: newId("cmd"),
      method: "workspace.apply_changeset",
      idempotency_key: newId("cmd"),
      params: {
        source: "API",
        message: "Binary",
        base_workspace_revision: index,
        operations: [op],
      },
    };
    const result = await d.dispatch(principal, input);
    expect(result.response).toMatchObject({ status: "APPLIED", applied_revision: index + 1 });
    expect(await d.dispatch(principal, { ...input, id: newId("cmd") })).toEqual({
      ...result,
      replayed: true,
    });
    const { stdout } = await git(
      ["show", `refs/room/canonical:${type === "rename" ? "renamed" : "file"}`],
      { gitDir: repo, timeoutMs: 5000, encoding: "buffer" },
    );
    expect(stdout).toEqual(bytes);
    const row = (
      await db.pool.query(
        "SELECT payload FROM changesets WHERE room_id = $1 AND applied_revision = $2",
        [room, index + 1],
      )
    ).rows[0];
    expect(row.payload.operations).toEqual([op]);
  }
  expect(
    (await db.pool.query("SELECT count(*) FROM events WHERE room_id = $1", [room])).rows[0].count,
  ).toBe("3");
  await expect(
    d.dispatch(principal, {
      id: newId("cmd"),
      method: "workspace.apply_changeset",
      idempotency_key: newId("cmd"),
      params: {
        source: "API",
        message: "Binary",
        base_workspace_revision: 3,
        operations: [{ type: "create", path: "bad", content: "raw\0byte" }],
      },
    }),
  ).rejects.toMatchObject({ code: "VALIDATION", details: { reason: "binary_requires_base64" } });
}, 20_000);

it.each(["A", "!!!!", "Zg", "Zh==", "Zm9=", "Zg==\n"])(
  "rejects malformed/noncanonical base64 %j",
  (content) => {
    expect(() => contentSize(content, "base64")).toThrow();
  },
);
it("measures decoded bytes and rejects NUL metadata/patches", () => {
  expect(contentSize("AP8=", "base64")).toBe(2);
  expect(contentSize(Buffer.from([0, 255]))).toBe(2);
  const value = { source: "API", message: "Edit", base_workspace_revision: 0, operations: [] };
  for (const field of ["message", "task_id", "conflict_id"])
    expect(changesetParamsSchema.safeParse({ ...value, [field]: "bad\0value" }).success).toBe(
      false,
    );
  expect(
    changesetParamsSchema.safeParse({
      ...value,
      operations: [{ type: "modify", path: "file", patch: "bad\0patch" }],
    }).success,
  ).toBe(false);
});

it("caps decoded aggregate bytes rather than the longer base64 representation", () => {
  const content = Buffer.alloc(8 * 1024 * 1024).toString("base64");
  const value = {
    source: "API",
    message: "Binary",
    base_workspace_revision: 0,
    operations: Array.from({ length: 3 }, (_, index) => ({
      type: "create",
      path: String(index),
      content,
      encoding: "base64",
    })),
  };
  expect(changesetParamsSchema.safeParse(value).success).toBe(true); // 24 MiB decoded, 32 MiB encoded
  expect(
    changesetParamsSchema.safeParse({
      ...value,
      operations: [...value.operations, value.operations[0]],
    }).success,
  ).toBe(false);
});
