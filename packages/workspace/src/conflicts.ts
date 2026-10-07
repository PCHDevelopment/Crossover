import { readMergeBlob } from "./binary.js";
import { extractHunks } from "./hunks.js";
import type { ConflictHunk } from "./hunks.js";
import type { MergeMessage, MergeResult } from "./merge.js";

export type ConflictKind = "CONTENT" | "MODIFY_DELETE" | "RENAME" | "ADD_ADD" | "BINARY" | "PARSE";
export interface ClassifiedConflict {
  path: string;
  kind: ConflictKind;
  hunks: ConflictHunk[];
  messages: MergeMessage[];
}

/** Classify Git's conflict messages; ours is candidate/stage 3, theirs head/stage 2 (§11.1). */
export async function classifyConflicts(
  repo: string,
  result: Extract<MergeResult, { clean: false }>,
): Promise<ClassifiedConflict[]> {
  const files = new Map(result.conflicts.files.map((file) => [file.path, file]));
  for (const message of result.conflicts.messages) {
    if (message.type.startsWith("CONFLICT")) {
      for (const path of message.paths) if (!files.has(path)) files.set(path, { path, stages: [] });
    }
  }
  return Promise.all(
    [...files.values()].map(async (file) => {
      const messages = result.conflicts.messages.filter((message) =>
        message.paths.includes(file.path),
      );
      const types = messages.map((message) => message.type);
      const blobs = new Map(
        await Promise.all(
          file.stages
            .filter((entry) => entry.mode !== "160000")
            .map(async (entry) => {
              return [entry.stage, await readMergeBlob(repo, entry.oid)] as const;
            }),
        ),
      );
      const stages = new Set(file.stages.map((entry) => entry.stage));
      let kind: ConflictKind;
      if (types.some((type) => type === "CONFLICT (parse)")) kind = "PARSE";
      else if (
        types.some((type) => type.includes("binary")) ||
        [...blobs.values()].some((blob) => blob.binary)
      )
        kind = "BINARY";
      else if (types.some((type) => type.includes("rename"))) kind = "RENAME";
      else if (types.some((type) => type.includes("modify/delete"))) kind = "MODIFY_DELETE";
      else if (types.some((type) => type.includes("add/add"))) kind = "ADD_ADD";
      else if (!stages.has(2) || !stages.has(3)) kind = "MODIFY_DELETE";
      else if (!stages.has(1)) kind = "ADD_ADD";
      else kind = "CONTENT";
      const hunks =
        kind === "CONTENT" && blobs.size === 3
          ? await extractHunks(
              blobs.get(1)!.content!.toString("utf8"),
              blobs.get(3)!.content!.toString("utf8"),
              blobs.get(2)!.content!.toString("utf8"),
            )
          : [];
      return { path: file.path, kind, hunks, messages };
    }),
  );
}
