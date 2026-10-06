import { z } from "zod";
import { normalizePath } from "./path.js";

const path = z.string().transform(normalizePath);
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const operation = z.union([
  z.strictObject({ type: z.literal("create"), path, content: z.string() }),
  z.strictObject({ type: z.literal("modify"), path, content: z.string() }),
  z.strictObject({ type: z.literal("modify"), path, patch: z.string() }),
  z.strictObject({ type: z.literal("delete"), path }),
  z.strictObject({
    type: z.literal("rename"),
    from: path,
    to: path,
    content: z.string().optional(),
  }),
]);

/** Client-owned §10.1 fields; room, actor, key and ChangeSet id come from the dispatcher. */
export const changesetParamsSchema = z
  .strictObject({
    source: z.enum(["EDITOR", "SANDBOX", "API", "UPSTREAM", "RESOLUTION"]),
    message: z.string(),
    base_workspace_revision: revision,
    base_file_revisions: z.record(path, revision).default({}),
    operations: z.array(operation).max(500),
    task_id: z.string().min(1).optional(),
    conflict_id: z.string().min(1).optional(),
  })
  .refine(
    (value) =>
      value.operations.reduce(
        (total, op) =>
          total +
          Buffer.byteLength("content" in op ? (op.content ?? "") : "patch" in op ? op.patch : ""),
        0,
      ) <=
      25 * 1024 * 1024,
    "ChangeSet text exceeds 25 MiB",
  );

export type ChangesetParams = z.infer<typeof changesetParamsSchema>;
