import { loadAuthorKinds, provenanceOf, type Dispatcher } from "@crossover/kernel";
import type { PoolClient } from "@crossover/db";
import { CrossoverError, newId } from "@crossover/protocol";
import { z } from "zod";

export const MAX_SNAPSHOTS_PER_ROOM = 50;
export const MAX_COPIED_MEMORY_ENTRIES = 2_000;
export const MAX_COPIED_MEMORY_BYTES = 16 * 1024 * 1024;
export const DEFAULT_SNAPSHOT_PAGE = 50;
export const MAX_SNAPSHOT_PAGE = 100;
const DEFAULT_MEMORY_PAGE = 100;
const MAX_MEMORY_PAGE = 200;

export interface CopyableMemoryEntry {
  key: string;
  revision: number;
  value: string;
  content_type: "text/markdown" | "application/json";
  author_id: string;
  source_refs: { kind: string; id: string }[];
}

/**
 * The room's live, unredacted memory outside `agents/*`, ordered by key (the part of memory a
 * snapshot or a branch copies, T1603/T1605). `VALIDATION` `snapshot_memory_too_large` past
 * {@link MAX_COPIED_MEMORY_ENTRIES} entries or {@link MAX_COPIED_MEMORY_BYTES} bytes of value.
 */
export async function copyableMemory(
  client: PoolClient,
  roomId: string,
): Promise<CopyableMemoryEntry[]> {
  const { rows } = await client.query<CopyableMemoryEntry>(
    `SELECT key, revision, value, content_type, author_id, source_refs
       FROM memory_entries
      WHERE room_id = $1 AND NOT deleted AND NOT redacted AND key NOT LIKE 'agents/%'
      ORDER BY key COLLATE "C"`,
    [roomId],
  );
  const bytes = rows.reduce((sum, row) => sum + Buffer.byteLength(row.value), 0);
  if (rows.length > MAX_COPIED_MEMORY_ENTRIES || bytes > MAX_COPIED_MEMORY_BYTES) {
    throw new CrossoverError("VALIDATION", "The room's memory is too large to copy", {
      details: {
        reason: "snapshot_memory_too_large",
        entries: rows.length,
        bytes,
        limit_entries: MAX_COPIED_MEMORY_ENTRIES,
        limit_bytes: MAX_COPIED_MEMORY_BYTES,
      },
    });
  }
  return rows;
}

const noNul = (value: string) => !value.includes("\0");

export const snapshotCreateParams = z.strictObject({
  name: z.string().trim().min(1).max(100).refine(noNul, "Text contains NUL"),
  description: z.string().max(2000).refine(noNul, "Text contains NUL").default(""),
  /** The revision to mark; default: the head. */
  revision: z.number().int().min(1).optional(),
});

export const snapshotListParams = z.strictObject({
  limit: z.number().int().min(1).max(MAX_SNAPSHOT_PAGE).default(DEFAULT_SNAPSHOT_PAGE),
  /** Continue after this snapshot id (the last of the previous page). */
  after: z.string().min(1).max(100).optional(),
});

export const snapshotGetParams = z.strictObject({
  snapshot_id: z.string().min(1).max(100),
  /** Continue the memory listing after this key. */
  memory_after: z.string().min(1).max(200).optional(),
  memory_limit: z.number().int().min(1).max(MAX_MEMORY_PAGE).default(DEFAULT_MEMORY_PAGE),
});

export const snapshotDeleteParams = z.strictObject({ snapshot_id: z.string().min(1).max(100) });

interface Row {
  id: string;
  name: string;
  description: string;
  revision: string;
  created_by: string;
  memory_entries: number;
  memory_bytes: string;
  created_at: Date;
}

const COLUMNS =
  "id, name, description, revision, created_by, memory_entries, memory_bytes, created_at";

const view = (r: Row) => ({
  id: r.id,
  name: r.name,
  description: r.description,
  revision: Number(r.revision),
  created_by: r.created_by,
  memory_entries: r.memory_entries,
  memory_bytes: Number(r.memory_bytes),
  created_at: r.created_at.toISOString(),
});

const NAME_UNIQUE = "workspace_snapshots_room_id_name_key";

/**
 * Register `workspace.snapshot.create|list|get|delete` (T1603, §9.7).
 *
 * - **create** (lead or owner) marks a workspace revision (the head by default) and copies the
 *   room's **current** live memory outside `agents/*`: memory is not versioned by workspace
 *   revision (§18), so naming an older revision still copies today's memory. Refused as
 *   `VALIDATION` for an empty workspace (`empty_workspace`), a revision past the head
 *   (`unknown_revision`), 50 snapshots already (`too_many_snapshots`), a name in use
 *   (`name_taken`) and too much memory (`snapshot_memory_too_large`). Emits
 *   `workspace.snapshot.created`; the description is not in the event.
 * - **list** and **get** (every member) read the marks and their memory copy, oldest first and by
 *   key, labelled by provenance (§16.5).
 * - **delete** (the owner) removes a snapshot and its memory copy; branch rooms made from it are
 *   unaffected. Emits `workspace.snapshot.deleted`.
 */
export function registerSnapshotCommands(dispatcher: Dispatcher): void {
  dispatcher.registerCommand({
    method: "workspace.snapshot.create",
    action: "snapshots.create",
    mutating: true,
    params: snapshotCreateParams,
    execute: async (ctx, p) => {
      const { client, room_id } = ctx;
      // Lock the workspace (as every apply does) so the head can't move under the snapshot.
      const { rows: locked } = await client.query<{ id: string }>(
        "SELECT id FROM workspaces WHERE room_id = $1 FOR UPDATE",
        [room_id],
      );
      const workspaceId = locked[0]?.id;
      if (!workspaceId) throw new CrossoverError("NOT_FOUND", "Workspace not provisioned");
      const { rows: heads } = await client.query<{ revision: string }>(
        `SELECT coalesce(max(revision), 0) AS revision FROM workspace_revisions
          WHERE room_id = $1 AND workspace_id = $2`,
        [room_id, workspaceId],
      );
      const head = Number(heads[0]?.revision ?? 0);
      if (head < 1)
        throw new CrossoverError("VALIDATION", "The workspace has no revision to mark yet", {
          details: { reason: "empty_workspace" },
        });
      const revision = p.revision ?? head;
      if (revision > head)
        throw new CrossoverError("VALIDATION", "The workspace has no such revision", {
          details: { reason: "unknown_revision", revision, head },
        });
      const { rows: counted } = await client.query<{ n: string; taken: boolean }>(
        `SELECT count(*) AS n, coalesce(bool_or(name = $2), false) AS taken
           FROM workspace_snapshots WHERE room_id = $1`,
        [room_id, p.name],
      );
      if (counted[0]?.taken)
        throw new CrossoverError("VALIDATION", "A snapshot with this name already exists", {
          details: { reason: "name_taken" },
        });
      if (Number(counted[0]?.n ?? 0) >= MAX_SNAPSHOTS_PER_ROOM)
        throw new CrossoverError("VALIDATION", "The room has the most snapshots it can hold", {
          details: { reason: "too_many_snapshots", limit: MAX_SNAPSHOTS_PER_ROOM },
        });
      const memory = await copyableMemory(client, room_id);
      const bytes = memory.reduce((sum, entry) => sum + Buffer.byteLength(entry.value), 0);
      const id = newId("snap");
      let row: Row;
      try {
        const { rows } = await client.query<Row>(
          `INSERT INTO workspace_snapshots (id, room_id, workspace_id, revision, name, description,
                                            created_by, memory_entries, memory_bytes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${COLUMNS}`,
          [
            id,
            room_id,
            workspaceId,
            revision,
            p.name,
            p.description,
            ctx.principal.participant_id,
            memory.length,
            bytes,
          ],
        );
        row = rows[0]!;
      } catch (error) {
        const e = error as { code?: string; constraint?: string } | null;
        if (e?.code === "23505" && e.constraint === NAME_UNIQUE)
          throw new CrossoverError("VALIDATION", "A snapshot with this name already exists", {
            details: { reason: "name_taken" },
          });
        throw error;
      }
      await client.query(
        `INSERT INTO workspace_snapshot_memory
           (room_id, snapshot_id, key, revision, value, content_type, author_id, source_refs)
         SELECT $1, $2, key, revision, value, content_type, author_id, source_refs
           FROM memory_entries
          WHERE room_id = $1 AND NOT deleted AND NOT redacted AND key NOT LIKE 'agents/%'`,
        [room_id, id],
      );
      const snapshot = view(row);
      const kinds = await loadAuthorKinds(client, room_id, [snapshot.created_by]);
      return {
        response: { ...snapshot, provenance: provenanceOf(kinds, snapshot.created_by) },
        events: [
          {
            type: "workspace.snapshot.created" as const,
            payload: {
              snapshot_id: id,
              name: snapshot.name,
              revision,
              memory_entries: snapshot.memory_entries,
              memory_bytes: snapshot.memory_bytes,
              created_by: snapshot.created_by,
            },
          },
        ],
      };
    },
  });

  dispatcher.registerCommand({
    method: "workspace.snapshot.list",
    action: "snapshots.read",
    mutating: false,
    view: "none",
    view_reason:
      "snapshots are room-level marks; their memory is readable by every member, like memory.read",
    params: snapshotListParams,
    execute: async (ctx, p) => {
      const values: unknown[] = [ctx.room_id, p.limit + 1];
      let where = "room_id = $1";
      if (p.after !== undefined) {
        const { rows } = await ctx.client.query<{ ts: string }>(
          `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ts
             FROM workspace_snapshots WHERE id = $1 AND room_id = $2`,
          [p.after, ctx.room_id],
        );
        if (!rows[0]) throw new CrossoverError("NOT_FOUND", `Snapshot ${p.after} not found`);
        values.push(rows[0].ts, p.after);
        where += ` AND (created_at, id COLLATE "C") > ($3::timestamptz, $4)`;
      }
      const { rows } = await ctx.client.query<Row>(
        `SELECT ${COLUMNS} FROM workspace_snapshots WHERE ${where}
          ORDER BY created_at, id COLLATE "C" LIMIT $2`,
        values,
      );
      const page = rows.slice(0, p.limit);
      const kinds = await loadAuthorKinds(
        ctx.client,
        ctx.room_id,
        page.map((r) => r.created_by),
      );
      return {
        response: {
          snapshots: page.map((r) => ({
            ...view(r),
            provenance: provenanceOf(kinds, r.created_by),
          })),
          has_more: rows.length > p.limit,
        },
      };
    },
  });

  dispatcher.registerCommand({
    method: "workspace.snapshot.get",
    action: "snapshots.read",
    mutating: false,
    view: "none",
    view_reason:
      "snapshots are room-level marks; their memory is readable by every member, like memory.read",
    params: snapshotGetParams,
    execute: async (ctx, p) => {
      const { rows } = await ctx.client.query<Row>(
        `SELECT ${COLUMNS} FROM workspace_snapshots WHERE id = $1 AND room_id = $2`,
        [p.snapshot_id, ctx.room_id],
      );
      const found = rows[0];
      if (!found) throw new CrossoverError("NOT_FOUND", `Snapshot ${p.snapshot_id} not found`);
      const values: unknown[] = [ctx.room_id, p.snapshot_id, p.memory_limit + 1];
      let where = "room_id = $1 AND snapshot_id = $2";
      if (p.memory_after !== undefined) {
        values.push(p.memory_after);
        where += ` AND key COLLATE "C" > $4`;
      }
      const { rows: memory } = await ctx.client.query<{
        key: string;
        revision: number;
        value: string;
        content_type: string;
        source_refs: unknown;
        redacted: boolean;
        author_id: string;
      }>(
        `SELECT key, revision, value, content_type, source_refs, redacted, author_id
           FROM workspace_snapshot_memory WHERE ${where}
          ORDER BY key COLLATE "C" LIMIT $3`,
        values,
      );
      const page = memory.slice(0, p.memory_limit);
      const kinds = await loadAuthorKinds(ctx.client, ctx.room_id, [
        found.created_by,
        ...page.map((r) => r.author_id),
      ]);
      return {
        response: {
          snapshot: { ...view(found), provenance: provenanceOf(kinds, found.created_by) },
          memory: {
            entries: page.map((r) => ({
              key: r.key,
              revision: r.revision,
              value: r.value,
              content_type: r.content_type,
              source_refs: r.source_refs,
              redacted: r.redacted,
              provenance: provenanceOf(kinds, r.author_id),
            })),
            has_more: memory.length > p.memory_limit,
          },
        },
      };
    },
  });

  dispatcher.registerCommand({
    method: "workspace.snapshot.delete",
    action: "snapshots.delete",
    mutating: true,
    params: snapshotDeleteParams,
    execute: async (ctx, p) => {
      const { client, room_id } = ctx;
      const { rows } = await client.query<{ name: string }>(
        "SELECT name FROM workspace_snapshots WHERE id = $1 AND room_id = $2 FOR UPDATE",
        [p.snapshot_id, room_id],
      );
      const found = rows[0];
      if (!found) throw new CrossoverError("NOT_FOUND", `Snapshot ${p.snapshot_id} not found`);
      await client.query(
        "DELETE FROM workspace_snapshot_memory WHERE room_id = $1 AND snapshot_id = $2",
        [room_id, p.snapshot_id],
      );
      await client.query("DELETE FROM workspace_snapshots WHERE room_id = $1 AND id = $2", [
        room_id,
        p.snapshot_id,
      ]);
      return {
        response: { deleted: true, snapshot_id: p.snapshot_id },
        events: [
          {
            type: "workspace.snapshot.deleted" as const,
            payload: { snapshot_id: p.snapshot_id, name: found.name },
          },
        ],
      };
    },
  });
}
