import { z } from "zod";
import { normalizePath } from "./path.js";
import { CrossoverError } from "@crossover/protocol";
import { contentSize } from "./content.js";

const path = z.string().transform(normalizePath);
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const encoding = z.enum(["utf8", "base64"]).optional();
const text = z.string().refine((value) => !value.includes("\0"), "Text contains NUL");
const operation = z
  .union([
    z.strictObject({ type: z.literal("create"), path, content: z.string(), encoding }),
    z.strictObject({ type: z.literal("modify"), path, content: z.string(), encoding }),
    z.strictObject({ type: z.literal("modify"), path, patch: text }),
    z.strictObject({ type: z.literal("delete"), path }),
    z.strictObject({
      type: z.literal("rename"),
      from: path,
      to: path,
      content: z.string().optional(),
      encoding,
    }),
  ])
  .transform((op) => {
    if ("content" in op && op.content !== undefined) {
      if (op.encoding !== "base64" && op.content.includes("\0"))
        throw new CrossoverError("VALIDATION", "Binary content requires base64", {
          details: { reason: "binary_requires_base64" },
        });
      contentSize(op.content, op.encoding);
    } else if ("encoding" in op && op.encoding !== undefined) {
      throw new CrossoverError("VALIDATION", "Encoding requires content");
    }
    return op;
  });

/** Client-owned §10.1 fields; room, actor, key and ChangeSet id come from the dispatcher. */
export const changesetInputSchema = z.strictObject({
  source: z.enum(["EDITOR", "SANDBOX", "API", "UPSTREAM", "RESOLUTION"]),
  message: text,
  base_workspace_revision: revision,
  base_file_revisions: z.record(path, revision).default({}),
  operations: z.array(operation).max(500),
  task_id: text.min(1).optional(),
  conflict_id: text.min(1).optional(),
});

export const changesetParamsSchema = changesetInputSchema.refine(
  (value) =>
    value.operations.reduce(
      (total, op) =>
        total +
        ("content" in op && op.content !== undefined
          ? contentSize(op.content, op.encoding)
          : "patch" in op
            ? Buffer.byteLength(op.patch)
            : 0),
      0,
    ) <=
    25 * 1024 * 1024,
  "ChangeSet text exceeds 25 MiB",
);

export type ChangesetParams = z.infer<typeof changesetParamsSchema>;
