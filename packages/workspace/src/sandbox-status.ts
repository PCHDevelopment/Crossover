import type { Dispatcher } from "@crossover/kernel";
import { z } from "zod";
import type { ExecutionService } from "./execution.js";

export interface SandboxFileChanges {
  modified: string[];
  added: string[];
  deleted: string[];
  truncated: boolean;
}

const MAX_STATUS_ENTRIES = 10_000;

/** Parse `git status --porcelain=v1 -z --untracked-files=all --no-renames`. */
export function parsePorcelainStatus(output: string): SandboxFileChanges {
  const changes: SandboxFileChanges = { modified: [], added: [], deleted: [], truncated: false };
  for (const record of output.split("\0")) {
    if (!record) continue;
    if (record.length < 4 || record[2] !== " ")
      throw new Error("Git returned invalid porcelain status output");

    const state = record.slice(0, 2);
    const path = record.slice(3);
    if (!path) throw new Error("Git returned a status entry without a path");
    if (state === "!!") continue;
    if (state.includes("R") || state.includes("C"))
      throw new Error("Git rename detection must be disabled for sandbox status");

    if (
      changes.modified.length + changes.added.length + changes.deleted.length >=
      MAX_STATUS_ENTRIES
    ) {
      changes.truncated = true;
      break;
    }
    if (state === "??" || state.includes("A")) changes.added.push(path);
    else if (state.includes("D")) changes.deleted.push(path);
    else changes.modified.push(path);
  }

  changes.modified.sort();
  changes.added.sort();
  changes.deleted.sort();
  return changes;
}

export const sandboxStatusParamsSchema = z.object({});

/** Register the read-only room protocol command for the caller's own working copy. */
export function registerSandboxStatusCommand(
  dispatcher: Dispatcher,
  execution: Pick<ExecutionService, "status">,
): void {
  dispatcher.registerCommand({
    method: "sandbox.status",
    action: "sandbox.read",
    mutating: false,
    view: "own",
    params: sandboxStatusParamsSchema,
    execute: async (ctx) => ({
      response: await execution.status(ctx.room_id, ctx.principal.participant_id),
    }),
  });
}
