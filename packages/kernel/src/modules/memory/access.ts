import { CrossoverError } from "@crossover/protocol";
import { z } from "zod";
import type { Dispatcher } from "../../dispatcher.js";
import {
  assertMemoryWritable,
  MEMORY_COLUMNS,
  memoryConflict,
  memoryEntryView,
  memoryKey,
  type MemoryEntryView,
} from "./memory.js";

export const DEFAULT_MEMORY_PAGE = 50;
export const MAX_MEMORY_PAGE = 100;

export const memoryGetParams = z.strictObject({ key: memoryKey });

export const memoryListParams = z.strictObject({
  /** Only keys starting with this (`architecture/`). Default: every key. */
  prefix: z.string().max(200).default(""),
  /** Include tombstones (deleted keys). Default false. */
  include_deleted: z.boolean().default(false),
  /** Continue after this key (the last of the previous page). */
  after: z.string().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(MAX_MEMORY_PAGE).default(DEFAULT_MEMORY_PAGE),
});

export const memoryHistoryParams = z.strictObject({
  key: memoryKey,
  /** Continue after this revision number (the last of the previous page). */
  after_revision: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(MAX_MEMORY_PAGE).default(DEFAULT_MEMORY_PAGE),
});

export const memoryDeleteParams = z.strictObject({
  key: memoryKey,
  /** The revision you last saw; a stale one is `CONFLICT_VERSION` with the current entry. */
  expected_revision: z.number().int().min(1),
});

interface RevisionRow {
  revision: number;
  value: string;
  content_type: string;
  author_id: string;
  source_refs: { kind: string; id: string }[];
  deleted: boolean;
  created_at: Date;
}

/** `LIKE` patterns treat `%` and `_` as wildcards; prefixes are literal text. */
const likePrefix = (prefix: string) => `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * Register `memory.get`, `memory.list`, `memory.history` and `memory.delete` (T409, §18.2-18.3).
 *
 * - **get** returns one entry with its value. A deleted key is `NOT_FOUND` with
 *   `details.deleted: true` and the tombstone's revision (what a revival `memory.put` needs as
 *   its `expected_revision`).
 * - **list** pages keys in order, optionally under a `prefix`, without the values (read one with
 *   `get`); tombstones only with `include_deleted`. `next_after` is set when there may be more.
 * - **history** returns every revision of a key, oldest first, **including the tombstone**; it
 *   works on deleted keys too. An unknown key is `NOT_FOUND`.
 * - **delete** writes a tombstone with compare-and-set on `expected_revision`: the entry keeps
 *   its key, its revision moves on, the value is cleared (the earlier revisions stay in the
 *   history), and `memory.deleted` is emitted. The namespace rules of `put` apply
 *   (`decisions/*` and other participants' `agents/<id>/*` are `FORBIDDEN`); an unknown key is
 *   `NOT_FOUND`, a stale revision `CONFLICT_VERSION`, an already deleted one `VALIDATION`.
 */
export function registerMemoryAccessCommands(dispatcher: Dispatcher): void {
  dispatcher.registerCommand({
    method: "memory.get",
    action: "memory.read",
    mutating: false,
    params: memoryGetParams,
    execute: async (ctx, p) => {
      const { rows } = await ctx.client.query<Parameters<typeof memoryEntryView>[0]>(
        `SELECT ${MEMORY_COLUMNS} FROM memory_entries WHERE room_id = $1 AND key = $2`,
        [ctx.room_id, p.key],
      );
      const row = rows[0];
      if (!row) throw new CrossoverError("NOT_FOUND", `Memory key ${p.key} not found`);
      if (row.deleted) {
        throw new CrossoverError("NOT_FOUND", `Memory key ${p.key} was deleted`, {
          details: { deleted: true, revision: row.revision },
        });
      }
      return { response: memoryEntryView(row) };
    },
  });

  dispatcher.registerCommand({
    method: "memory.list",
    action: "memory.read",
    mutating: false,
    params: memoryListParams,
    execute: async (ctx, p) => {
      const { rows } = await ctx.client.query<
        Omit<Parameters<typeof memoryEntryView>[0], "value"> & { bytes: number }
      >(
        `SELECT key, content_type, author_id, revision, source_refs, deleted, created_at, updated_at,
                octet_length(value) AS bytes
         FROM memory_entries
         WHERE room_id = $1 AND key LIKE $2 ESCAPE '\\'
           AND ($3 OR NOT deleted)
           AND ($4::text IS NULL OR key > $4)
         ORDER BY key
         LIMIT $5`,
        [ctx.room_id, likePrefix(p.prefix), p.include_deleted, p.after ?? null, p.limit],
      );
      const last = rows[rows.length - 1];
      return {
        response: {
          entries: rows.map((r) => ({
            ...r,
            created_at: r.created_at.toISOString(),
            updated_at: r.updated_at.toISOString(),
          })),
          next_after: rows.length === p.limit && last ? last.key : null,
        },
      };
    },
  });

  dispatcher.registerCommand({
    method: "memory.history",
    action: "memory.read",
    mutating: false,
    params: memoryHistoryParams,
    execute: async (ctx, p) => {
      const { rowCount } = await ctx.client.query(
        "SELECT 1 FROM memory_entries WHERE room_id = $1 AND key = $2",
        [ctx.room_id, p.key],
      );
      if (!rowCount) throw new CrossoverError("NOT_FOUND", `Memory key ${p.key} not found`);
      const { rows } = await ctx.client.query<RevisionRow>(
        `SELECT revision, value, content_type, author_id, source_refs, deleted, created_at
         FROM memory_revisions
         WHERE room_id = $1 AND key = $2 AND revision > $3
         ORDER BY revision
         LIMIT $4`,
        [ctx.room_id, p.key, p.after_revision, p.limit],
      );
      const last = rows[rows.length - 1];
      return {
        response: {
          key: p.key,
          revisions: rows.map((r) => ({ ...r, created_at: r.created_at.toISOString() })),
          next_after: rows.length === p.limit && last ? last.revision : null,
        },
      };
    },
  });

  dispatcher.registerCommand({
    method: "memory.delete",
    action: "memory.write",
    mutating: true,
    params: memoryDeleteParams,
    execute: async (ctx, p) => {
      const me = ctx.principal.participant_id;
      assertMemoryWritable(p.key, me);
      const { rows: found } = await ctx.client.query<Parameters<typeof memoryEntryView>[0]>(
        `SELECT ${MEMORY_COLUMNS} FROM memory_entries WHERE room_id = $1 AND key = $2 FOR UPDATE`,
        [ctx.room_id, p.key],
      );
      const current = found[0];
      if (!current) throw new CrossoverError("NOT_FOUND", `Memory key ${p.key} not found`);
      if (current.revision !== p.expected_revision) throw memoryConflict(current, p.key);
      if (current.deleted) {
        throw new CrossoverError("VALIDATION", `Memory key ${p.key} is already deleted`, {
          details: { revision: current.revision },
        });
      }
      const { rows } = await ctx.client.query<Parameters<typeof memoryEntryView>[0]>(
        `UPDATE memory_entries
         SET value = '', deleted = true, author_id = $3, revision = revision + 1,
             updated_at = clock_timestamp()
         WHERE room_id = $1 AND key = $2 AND revision = $4
         RETURNING ${MEMORY_COLUMNS}`,
        [ctx.room_id, p.key, me, p.expected_revision],
      );
      const tombstone = rows[0];
      if (!tombstone) throw memoryConflict(current, p.key);
      await ctx.client.query(
        `INSERT INTO memory_revisions (room_id, key, revision, value, content_type, author_id, source_refs, deleted)
         VALUES ($1, $2, $3, '', $4, $5, $6::jsonb, true)`,
        [
          ctx.room_id,
          p.key,
          tombstone.revision,
          tombstone.content_type,
          me,
          JSON.stringify(tombstone.source_refs),
        ],
      );
      const entry: MemoryEntryView = memoryEntryView(tombstone);
      return {
        response: entry,
        events: [
          {
            type: "memory.deleted" as const,
            payload: {
              key: p.key,
              revision: entry.revision,
              previous_revision: p.expected_revision,
              author_id: me,
            },
          },
        ],
      };
    },
  });
}
