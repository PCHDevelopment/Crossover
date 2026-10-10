import type { Dispatcher } from "@crossover/kernel";
import { z } from "zod";
import type { ExecutionService } from "./execution.js";

export interface SandboxFileChanges {
  modified: string[];
  added: string[];
  deleted: string[];
  truncated: boolean;
}

export const MAX_STATUS_ENTRIES = 10_000;
export const MAX_STATUS_OUTPUT_BYTES = 16 * 1024 * 1024;

export type SandboxChangeKind = "modified" | "added" | "deleted";

export interface SandboxFileChangesAccumulator {
  /** Add one change, or return false once the entry or byte budget is exhausted. */
  add(kind: SandboxChangeKind, path: string): boolean;
  /** Mark unconsumed status as truncated when a separate output limit is exhausted. */
  truncate(): void;
  finish(): SandboxFileChanges;
}

/** Bound all status sources with the same entry and encoded-output limits. */
export function createSandboxFileChangesAccumulator(): SandboxFileChangesAccumulator {
  const changes: SandboxFileChanges = { modified: [], added: [], deleted: [], truncated: false };
  let entryCount = 0;
  let outputBytes = 0;
  let stopped = false;

  return {
    add(kind, path) {
      if (stopped) return false;
      // Porcelain v1 records encode each path as "XY path\\0".
      const bytes = Buffer.byteLength(path) + 4;
      if (entryCount >= MAX_STATUS_ENTRIES || outputBytes + bytes > MAX_STATUS_OUTPUT_BYTES) {
        changes.truncated = true;
        stopped = true;
        return false;
      }
      changes[kind].push(path);
      entryCount += 1;
      outputBytes += bytes;
      return true;
    },
    truncate() {
      stopped = true;
      changes.truncated = true;
    },
    finish() {
      changes.modified.sort();
      changes.added.sort();
      changes.deleted.sort();
      return changes;
    },
  };
}

export interface PorcelainStatusAccumulator {
  /** Consume one stdout chunk; false means the consumer reached its output limit. */
  write(chunk: string): boolean;
  /** Mark unconsumed status as truncated when the byte budget is exhausted. */
  truncate(): void;
  /** Flush the final unterminated record and return the accumulated bounded result. */
  finish(): SandboxFileChanges;
}

/** Incrementally parse porcelain records without retaining the complete helper output. */
export function createPorcelainStatusAccumulator(): PorcelainStatusAccumulator {
  const changes = createSandboxFileChangesAccumulator();
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

    const kind =
      state === "??" || state.includes("A")
        ? "added"
        : state.includes("D")
          ? "deleted"
          : "modified";
    const keepReading = changes.add(kind, path);
    if (!keepReading) stopped = true;
    return keepReading;
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
    truncate() {
      stopped = true;
      pending = "";
      changes.truncate();
    },
    finish() {
      if (!stopped && pending) addRecord(pending);
      pending = "";
      return changes.finish();
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
