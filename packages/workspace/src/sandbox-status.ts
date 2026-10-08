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

export interface PorcelainStatusAccumulator {
  /** Consume one stdout chunk; false means the consumer reached its output limit. */
  write(chunk: string): boolean;
  /** Flush the final unterminated record and return the accumulated bounded result. */
  finish(): SandboxFileChanges;
}

/** Incrementally parse porcelain records without retaining the complete helper output. */
export function createPorcelainStatusAccumulator(): PorcelainStatusAccumulator {
  const changes: SandboxFileChanges = { modified: [], added: [], deleted: [], truncated: false };
  let pending = "";
  let stopped = false;

  const addRecord = (record: string): boolean => {
    if (!record) return true;
    if (record.length < 4 || record[2] !== " ")
      throw new Error("Git returned invalid porcelain status output");

    const state = record.slice(0, 2);
    const path = record.slice(3);
    if (!path) throw new Error("Git returned a status entry without a path");
    if (state === "!!") return true;
    if (state.includes("R") || state.includes("C"))
      throw new Error("Git rename detection must be disabled for sandbox status");

    if (
      changes.modified.length + changes.added.length + changes.deleted.length >=
      MAX_STATUS_ENTRIES
    ) {
      changes.truncated = true;
      stopped = true;
      return false;
    }
    if (state === "??" || state.includes("A")) changes.added.push(path);
    else if (state.includes("D")) changes.deleted.push(path);
    else changes.modified.push(path);
    return true;
  };

  return {
    write(chunk) {
      if (stopped) return false;
      let start = 0;
      let delimiter = chunk.indexOf("\0", start);
      while (delimiter !== -1) {
        const record = pending + chunk.slice(start, delimiter);
        pending = "";
        if (!addRecord(record)) return false;
        start = delimiter + 1;
        delimiter = chunk.indexOf("\0", start);
      }
      pending += chunk.slice(start);
      return true;
    },
    finish() {
      if (!stopped && pending) addRecord(pending);
      pending = "";
      changes.modified.sort();
      changes.added.sort();
      changes.deleted.sort();
      return changes;
    },
  };
}

/** Parse `git status --porcelain=v1 -z --untracked-files=all --no-renames`. */
export function parsePorcelainStatus(output: string): SandboxFileChanges {
  const accumulator = createPorcelainStatusAccumulator();
  accumulator.write(output);
  return accumulator.finish();
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
