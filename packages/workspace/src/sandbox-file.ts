import { isUtf8 } from "node:buffer";
import type { Dispatcher } from "@crossover/kernel";
import { CrossoverError } from "@crossover/protocol";
import { z } from "zod";
import { BINARY_SIZE } from "./binary.js";
import { contentBytes, contentSize } from "./content.js";
import type { ExecutionService } from "./execution.js";
import { pathSchema } from "./reads.js";

export const SANDBOX_FILE_READ_LIMIT_BYTES = 1024 * 1024;
export const SANDBOX_FILE_WRITE_LIMIT_BYTES = 512 * 1024;

export const sandboxFileReadParamsSchema = z.strictObject({ path: pathSchema() });
export const sandboxFileWriteInputSchema = z.strictObject({
  path: pathSchema(),
  content: z.string().max(1024 * 1024),
  encoding: z.enum(["utf8", "base64"]).optional(),
});
export const sandboxFileWriteParamsSchema = sandboxFileWriteInputSchema.transform((params) => {
  if (params.encoding !== "base64" && params.content.includes("\0"))
    throw new CrossoverError("VALIDATION", "Binary content requires base64", {
      details: { reason: "binary_requires_base64" },
    });
  const size = contentSize(params.content, params.encoding);
  if (size > SANDBOX_FILE_WRITE_LIMIT_BYTES)
    throw new CrossoverError("VALIDATION", "Sandbox file exceeds the 512 KiB write limit", {
      details: { reason: "file_too_large", size, limit: SANDBOX_FILE_WRITE_LIMIT_BYTES },
    });
  return params;
});

/** Register path-scoped reads and writes for the caller's own sandbox working copy. */
export function registerSandboxFileCommands(
  dispatcher: Dispatcher,
  execution: ExecutionService,
): void {
  dispatcher.registerCommand({
    method: "sandbox.file.read",
    action: "workspace.read",
    perPathAuthorize: true,
    mutating: false,
    view: "own",
    params: sandboxFileReadParamsSchema,
    execute: async (ctx, params) => {
      await ctx.authorize("workspace.read", { path: params.path });
      const file = await execution.readWorkingCopyFile(
        ctx.room_id,
        ctx.principal.participant_id,
        params.path,
        SANDBOX_FILE_READ_LIMIT_BYTES,
      );
      const encoding =
        file.content.length > BINARY_SIZE ||
        file.content.subarray(0, 8192).includes(0) ||
        !isUtf8(file.content)
          ? "base64"
          : "utf8";
      return {
        response: {
          path: params.path,
          content: file.content.toString(encoding),
          encoding,
          size: file.content.length,
        },
      };
    },
  });

  dispatcher.registerCommand({
    method: "sandbox.file.write",
    action: "workspace.write",
    perPathAuthorize: true,
    mutating: true,
    params: sandboxFileWriteParamsSchema,
    prepare: async (ctx, params) => {
      if (!(await ctx.isAllowed("workspace.write", { path: params.path }))) return { denied: true };
      const content = contentBytes(params.content, params.encoding);
      await execution.writeWorkingCopyFile(
        ctx.room_id,
        ctx.principal.participant_id,
        params.path,
        content,
      );
      return { response: { path: params.path, written_bytes: content.length } };
    },
    execute: async (ctx, params) => {
      await ctx.authorize("workspace.write", { path: params.path });
      const prepared = ctx.prepared as
        { denied: true } | { response: { path: string; written_bytes: number } } | undefined;
      if (!prepared || "denied" in prepared)
        throw new CrossoverError("UNAVAILABLE", "Sandbox file write was not prepared");
      return { response: prepared.response };
    },
  });
}
