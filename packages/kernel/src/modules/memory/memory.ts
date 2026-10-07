import { CrossoverError } from "@crossover/protocol";
import type { PoolClient } from "@crossover/db";
import {
  loadAuthorKinds,
  provenanceOf,
  type AuthorKinds,
  type Provenance,
  principalKinds,
} from "../provenance.js";
import { z } from "zod";
import type { Dispatcher } from "../../dispatcher.js";

export const MAX_MEMORY_VALUE_BYTES = 64 * 1024;
export const MAX_MEMORY_SOURCE_REFS = 20;
export const SYSTEM_MEMORY_AUTHOR = "system";

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * A memory key is a path: 1 to 8 segments joined by `/`, each starting with a letter or digit
 * (so no `.` or `..`), 200 characters at most, no empty segment and no leading or trailing `/`.
 */
export const memoryKey = z
  .string()
  .max(200)
  .refine((key) => {
    const segments = key.split("/");
    return segments.length <= 8 && segments.every((s) => SEGMENT.test(s));
  }, "A memory key is a path of up to 8 segments like architecture/database");

const sourceRef = z.strictObject({
  /** `task`, `decision`, `changeset`, `file`, `message`… */
  kind: z.string().regex(/^[a-z][a-z_]{0,31}$/),
  id: z.string().min(1).max(512),
});

export const memoryPutParams = z.strictObject({
  key: memoryKey,
  /** Text, or JSON text when `content_type` is `application/json`. At most 64 KiB. */
  value: z.string().refine((v) => Buffer.byteLength(v, "utf8") <= MAX_MEMORY_VALUE_BYTES, {
    message: `A memory value is at most ${MAX_MEMORY_VALUE_BYTES} bytes; put larger content in a workspace file and link it with source_refs`,
  }),
  content_type: z.enum(["text/markdown", "application/json"]).default("text/markdown"),
  /** The revision you last saw; `0` creates. A mismatch is `CONFLICT_VERSION` with the current entry. */
  expected_revision: z.number().int().min(0),
  source_refs: z.array(sourceRef).max(MAX_MEMORY_SOURCE_REFS).default([]),
});

interface EntryRow {
  key: string;
  value: string;
  content_type: string;
  author_id: string;
  revision: number;
  source_refs: { kind: string; id: string }[];
  deleted: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface MemoryEntryView extends Omit<EntryRow, "created_at" | "updated_at"> {
  created_at: string;
  updated_at: string;
}

export const MEMORY_COLUMNS =
  "key, value, content_type, author_id, revision, source_refs, deleted, created_at, updated_at";

export function memoryEntryView(row: EntryRow): MemoryEntryView {
  return {
    ...row,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

/** A memory entry as a reader gets it: with who wrote it (§16.5). */
export interface LabeledMemoryEntry extends MemoryEntryView {
  provenance: Provenance;
}

export const labelMemory = (entry: MemoryEntryView, kinds: AuthorKinds): LabeledMemoryEntry => ({
  ...entry,
  provenance: provenanceOf(kinds, entry.author_id),
});

/** The stale-write answer: `CONFLICT_VERSION`, carrying the entry as it is now (§18.2). */
export async function memoryConflict(
  client: PoolClient,
  roomId: string,
  current: EntryRow | undefined,
  key: string,
): Promise<CrossoverError> {
  const kinds = current ? await loadAuthorKinds(client, roomId, [current.author_id]) : undefined;
  return new CrossoverError("CONFLICT_VERSION", `Memory key ${key} changed since you read it`, {
    details: { current: current && kinds ? labelMemory(memoryEntryView(current), kinds) : null },
  });
}

/**
 * Who may write `key` (§18.3): `decisions/*` is the platform's alone (the mirror of accepted
 * decisions, §7.4), `agents/<id>/*` belongs to that participant, anything else to whoever holds
 * `memory.write`. Throws `FORBIDDEN` for a participant who may not.
 */
export function assertMemoryWritable(key: string, writerId: string): void {
  const [top, owner] = key.split("/");
  if (top === "decisions") {
    throw new CrossoverError("FORBIDDEN", "The decisions/ namespace is written by the platform", {
      details: { reason: "reserved_namespace", namespace: "decisions" },
    });
  }
  if (top === "agents" && owner !== writerId) {
    throw new CrossoverError(
      "FORBIDDEN",
      "Only a participant can write under their own agents/<id>/ namespace",
      { details: { reason: "not_namespace_owner", namespace: `agents/${owner ?? ""}` } },
    );
  }
}

/**
 * Write `key` with compare-and-set on `expectedRevision` (0 creates), inside the caller's
 * transaction, appending the revision to the history. A stale or contested write is
 * `CONFLICT_VERSION` with the current entry. Putting over a tombstone needs its revision, and
 * brings the key back. Shared by `memory.put` and the decision mirror (T407).
 */
export async function putMemory(
  client: PoolClient,
  roomId: string,
  authorId: string,
  p: {
    key: string;
    value: string;
    content_type: "text/markdown" | "application/json";
    expected_revision: number;
    source_refs: { kind: string; id: string }[];
  },
): Promise<MemoryEntryView> {
  const refs = JSON.stringify(p.source_refs);
  let row: EntryRow | undefined;
  if (p.expected_revision === 0) {
    const { rows } = await client.query<EntryRow>(
      `INSERT INTO memory_entries (room_id, key, value, content_type, author_id, revision, source_refs)
       VALUES ($1, $2, $3, $4, $5, 1, $6::jsonb)
       ON CONFLICT (room_id, key) DO NOTHING
       RETURNING ${MEMORY_COLUMNS}`,
      [roomId, p.key, p.value, p.content_type, authorId, refs],
    );
    row = rows[0];
  } else {
    const { rows } = await client.query<EntryRow>(
      `UPDATE memory_entries
       SET value = $3, content_type = $4, author_id = $5, source_refs = $6::jsonb,
           revision = revision + 1, deleted = false, updated_at = clock_timestamp()
       WHERE room_id = $1 AND key = $2 AND revision = $7
       RETURNING ${MEMORY_COLUMNS}`,
      [roomId, p.key, p.value, p.content_type, authorId, refs, p.expected_revision],
    );
    row = rows[0];
  }
  if (!row) {
    const { rows } = await client.query<EntryRow>(
      `SELECT ${MEMORY_COLUMNS} FROM memory_entries WHERE room_id = $1 AND key = $2`,
      [roomId, p.key],
    );
    throw await memoryConflict(client, roomId, rows[0], p.key);
  }
  await client.query(
    `INSERT INTO memory_revisions (room_id, key, revision, value, content_type, author_id, source_refs, deleted)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
    [roomId, row.key, row.revision, row.value, row.content_type, row.author_id, refs, row.deleted],
  );
  return memoryEntryView(row);
}

/**
 * Register `memory.put` (T408, §18): write a key of the room's shared memory with
 * compare-and-set. `expected_revision` is the revision you last saw (`0` creates); when two
 * writers race on the same revision exactly one wins and the other gets `CONFLICT_VERSION` with
 * the entry as it is now. Every revision is kept. The value is at most 64 KiB, and
 * `application/json` values must parse. The event (`memory.updated`) names the key, revision
 * and size but doesn't repeat the value: read it with `memory.get` (T409).
 */
export function registerMemoryCommands(dispatcher: Dispatcher): void {
  dispatcher.registerCommand({
    method: "memory.put",
    action: "memory.write",
    mutating: true,
    params: memoryPutParams,
    execute: async (ctx, p) => {
      assertMemoryWritable(p.key, ctx.principal.participant_id);
      if (p.content_type === "application/json") {
        try {
          JSON.parse(p.value);
        } catch {
          throw new CrossoverError("VALIDATION", "The value isn't valid JSON", {
            details: { content_type: p.content_type },
          });
        }
      }
      const entry = await putMemory(ctx.client, ctx.room_id, ctx.principal.participant_id, p);
      return {
        response: labelMemory(entry, principalKinds(ctx.principal)),
        events: [
          {
            type: "memory.updated" as const,
            payload: {
              key: entry.key,
              revision: entry.revision,
              previous_revision: p.expected_revision,
              content_type: entry.content_type,
              bytes: Buffer.byteLength(entry.value, "utf8"),
              author_id: entry.author_id,
              source_refs: entry.source_refs,
            },
          },
        ],
      };
    },
  });
}
