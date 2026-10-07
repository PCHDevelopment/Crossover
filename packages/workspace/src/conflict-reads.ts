import type { CommandContext, Dispatcher } from "@crossover/kernel";
import { CrossoverError } from "@crossover/protocol";
import { z } from "zod";
import type { ClassifiedConflict, ConflictKind } from "./conflicts.js";

const status = z.enum(["OPEN", "ESCALATED", "RESOLVED", "ABANDONED"]);
export const conflictsListParamsSchema = z.strictObject({
  status: z.union([status, z.array(status).min(1).max(4)]).optional(),
  submitter_id: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(512).optional(),
});
export const conflictsGetParamsSchema = z.strictObject({ conflict_id: z.string().min(1) });

interface ConflictRow {
  id: string;
  changeset_id: string;
  submitter_id: string;
  base_revision: string;
  head_revision_at_detection: string;
  files: ClassifiedConflict[];
  counterparty_changesets: string[];
  status: z.infer<typeof status>;
  attempts: number;
  resolver_id: string | null;
  resolution_changeset_id: string | null;
  created_at: Date;
  created_at_text: string;
  escalated_at: Date | null;
  resolved_at: Date | null;
}

const CREATED_AT_TEXT = `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const CURSOR = /^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z)\|([^|]+)$/;

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw new CrossoverError("VALIDATION", "Invalid cursor", {
      details: { reason: "invalid_cursor" },
    });
  }
  const match = CURSOR.exec(decoded);
  if (!match)
    throw new CrossoverError("VALIDATION", "Invalid cursor", {
      details: { reason: "invalid_cursor" },
    });
  return { createdAt: match[1]!, id: match[2]! };
}

async function redactedView(ctx: CommandContext, row: ConflictRow) {
  let allPathsAuthorized = true;
  const files: (ClassifiedConflict | { path: null; kind: ConflictKind; reason: "unauthorized" })[] =
    [];
  for (const conflict of row.files) {
    let authorized = true;
    for (const path of new Set([
      conflict.path,
      ...conflict.messages.flatMap((message) => message.paths),
    ])) {
      try {
        await ctx.authorize("workspace.read", { path });
      } catch (error) {
        if (!(error instanceof CrossoverError) || error.code !== "FORBIDDEN") throw error;
        authorized = false;
      }
    }
    if (authorized) files.push(conflict);
    else {
      allPathsAuthorized = false;
      files.push({ path: null, kind: conflict.kind, reason: "unauthorized" });
    }
  }
  return {
    id: row.id,
    changeset_id: row.changeset_id,
    submitter_id: row.submitter_id,
    base_revision: Number(row.base_revision),
    head_revision_at_detection: Number(row.head_revision_at_detection),
    files,
    ...(allPathsAuthorized ? { counterparty_changesets: row.counterparty_changesets } : {}),
    status: row.status,
    attempts: row.attempts,
    resolver_id: row.resolver_id,
    resolution_changeset_id: row.resolution_changeset_id,
    created_at: row.created_at.toISOString(),
    escalated_at: row.escalated_at?.toISOString() ?? null,
    resolved_at: row.resolved_at?.toISOString() ?? null,
  };
}

/** Register room-scoped conflict reads, applying per-viewer path redaction (§11.1, T602). */
export function registerWorkspaceConflictReads(dispatcher: Dispatcher): void {
  dispatcher.registerCommand({
    method: "conflicts.list",
    action: "workspace.read",
    perPathAuthorize: true,
    mutating: false,
    params: conflictsListParamsSchema,
    execute: async (ctx, params) => {
      const where = ["room_id = $1"];
      const values: unknown[] = [ctx.room_id];
      const add = (clause: (index: number) => string, value: unknown) => {
        values.push(value);
        where.push(clause(values.length));
      };
      if (params.status) {
        const statuses = Array.isArray(params.status) ? params.status : [params.status];
        add((index) => `status = ANY($${index}::text[])`, statuses);
      }
      if (params.submitter_id) add((index) => `submitter_id = $${index}`, params.submitter_id);
      if (params.cursor) {
        const cursor = decodeCursor(params.cursor);
        values.push(cursor.createdAt, cursor.id);
        where.push(`(created_at, id) < ($${values.length - 1}::timestamptz, $${values.length})`);
      }
      values.push(params.limit + 1);
      const { rows } = await ctx.client.query<ConflictRow>(
        `SELECT id, changeset_id, submitter_id, base_revision, head_revision_at_detection,
                files, counterparty_changesets, status, attempts, resolver_id,
                resolution_changeset_id, created_at, ${CREATED_AT_TEXT} AS created_at_text,
                escalated_at, resolved_at
         FROM conflicts WHERE ${where.join(" AND ")}
         ORDER BY created_at DESC, id DESC LIMIT $${values.length}`,
        values,
      );
      const page = rows.slice(0, params.limit);
      const last = page.at(-1);
      return {
        response: {
          conflicts: await Promise.all(page.map((row) => redactedView(ctx, row))),
          next_cursor:
            rows.length > params.limit && last ? encodeCursor(last.created_at_text, last.id) : null,
        },
      };
    },
  });

  dispatcher.registerCommand({
    method: "conflicts.get",
    action: "workspace.read",
    perPathAuthorize: true,
    mutating: false,
    params: conflictsGetParamsSchema,
    execute: async (ctx, params) => {
      const { rows } = await ctx.client.query<ConflictRow>(
        `SELECT id, changeset_id, submitter_id, base_revision, head_revision_at_detection,
                files, counterparty_changesets, status, attempts, resolver_id,
                resolution_changeset_id, created_at, ${CREATED_AT_TEXT} AS created_at_text,
                escalated_at, resolved_at
         FROM conflicts WHERE room_id = $1 AND id = $2`,
        [ctx.room_id, params.conflict_id],
      );
      const conflict = rows[0];
      if (!conflict) throw new CrossoverError("NOT_FOUND", "Conflict not found");
      return { response: await redactedView(ctx, conflict) };
    },
  });
}
