import type { PoolClient } from "@crossover/db";
import { hashRequest, withIdempotency } from "@crossover/ledger";
import { CrossoverError, newId } from "@crossover/protocol";
import { z } from "zod";
import type { CommandResult, Dispatcher, EmittedEvent } from "../../dispatcher.js";
import type { Principal } from "../../principal.js";
import { deliverInbox } from "../inbox/inbox.js";
import { loadAuthorKinds, provenanceOf } from "../provenance.js";

/** How long an approval can be given (§22.2). */
export const APPROVAL_TTL_HOURS = 24;
export const DEFAULT_APPROVALS_PAGE = 50;
export const MAX_APPROVALS_PAGE = 100;

export type ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED" | "WITHDRAWN" | "EXPIRED";

export interface ApprovalRow {
  id: string;
  room_id: string;
  requester_id: string;
  method: string;
  params: unknown;
  idempotency_key: string;
  idempotency_hash: string;
  capability: string;
  status: ApprovalStatus;
  created_at: Date;
  expires_at: Date;
  decided_by: string | null;
  decided_at: Date | null;
  note: string | null;
  /** Computed by the query: a pending approval past its time. */
  lapsed: boolean;
}

const COLUMNS = `id, room_id, requester_id, method, params, idempotency_key, idempotency_hash, capability, status,
  created_at, expires_at, decided_by, decided_at, note, (status = 'PENDING' AND expires_at <= clock_timestamp()) AS lapsed`;

export interface ApprovalView {
  id: string;
  requester_id: string;
  method: string;
  params: unknown;
  capability: string;
  status: ApprovalStatus;
  created_at: string;
  expires_at: string;
  decided_by: string | null;
  decided_at: string | null;
  note: string | null;
}

export const approvalView = (r: ApprovalRow): ApprovalView => ({
  id: r.id,
  requester_id: r.requester_id,
  method: r.method,
  params: r.params,
  capability: r.capability,
  status: r.lapsed ? "EXPIRED" : r.status,
  created_at: r.created_at.toISOString(),
  expires_at: r.expires_at.toISOString(),
  decided_by: r.decided_by,
  decided_at: r.decided_at ? r.decided_at.toISOString() : null,
  note: r.note,
});

/**
 * Keep a command that an approval gate stopped (§22.2), and tell the people who can decide on it:
 * the owner and the admins, never the lead (an agent approving other agents' gated actions would
 * defeat the gate), except the requester, get an `APPROVAL` inbox item. A retry of the same
 * request while it waits finds the same approval. A retry (same idempotency key and request)
 * of one that was already decided never runs again: approved is `already_approved`, rejected or
 * withdrawn says so (`rejected`, `withdrawn`). Runs in a transaction of the dispatcher's own,
 * after the refused command rolled back.
 */
export async function queueApproval(
  client: PoolClient,
  requester: Principal,
  request: {
    method: string;
    params: unknown;
    idempotency_key: string;
    idempotency_hash: string;
    capability: string;
  },
): Promise<{ approval: ApprovalView; created: boolean }> {
  const room_id = requester.room_id;
  const request_hash = hashRequest({ method: request.method, params: request.params });
  const { rows: decided } = await client.query<ApprovalRow>(
    `SELECT ${COLUMNS} FROM approvals
     WHERE room_id = $1 AND requester_id = $2 AND idempotency_key = $3 AND idempotency_hash = $4
       AND status IN ('APPROVED', 'REJECTED', 'WITHDRAWN')
     ORDER BY created_at DESC LIMIT 1`,
    [room_id, requester.participant_id, request.idempotency_key, request.idempotency_hash],
  );
  if (decided[0]) {
    const reason = { APPROVED: "already_approved", REJECTED: "rejected", WITHDRAWN: "withdrawn" }[
      decided[0].status as "APPROVED" | "REJECTED" | "WITHDRAWN"
    ];
    throw new CrossoverError(
      "VALIDATION",
      decided[0].status === "APPROVED"
        ? "That request was already approved and has run"
        : `That request was ${decided[0].status.toLowerCase()}`,
      { details: { reason, approval_id: decided[0].id } },
    );
  }
  const { rows } = await client.query<ApprovalRow>(
    `SELECT ${COLUMNS} FROM approvals
     WHERE room_id = $1 AND requester_id = $2 AND request_hash = $3
       AND status = 'PENDING' AND expires_at > clock_timestamp()
     ORDER BY created_at DESC LIMIT 1`,
    [room_id, requester.participant_id, request_hash],
  );
  if (rows[0]) return { approval: approvalView(rows[0]), created: false };

  // A lapsed one no longer holds its place in the unique index.
  await client.query(
    `UPDATE approvals SET status = 'EXPIRED'
     WHERE room_id = $1 AND requester_id = $2 AND request_hash = $3
       AND status = 'PENDING' AND expires_at <= clock_timestamp()`,
    [room_id, requester.participant_id, request_hash],
  );
  const id = newId("appr");
  const inserted = await client.query<ApprovalRow>(
    `INSERT INTO approvals (id, room_id, requester_id, method, params, idempotency_key,
                            idempotency_hash, request_hash, capability, expires_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9,
             clock_timestamp() + make_interval(hours => $10))
     RETURNING ${COLUMNS}`,
    [
      id,
      room_id,
      requester.participant_id,
      request.method,
      JSON.stringify(request.params ?? null),
      request.idempotency_key,
      request.idempotency_hash,
      request_hash,
      request.capability.slice(0, 512),
      APPROVAL_TTL_HOURS,
    ],
  );
  const { rows: deciders } = await client.query<{ id: string }>(
    `SELECT id FROM participants
     WHERE room_id = $1 AND status = 'ACTIVE' AND id <> $2 AND authority IN ('OWNER', 'ADMIN')
     ORDER BY id`,
    [room_id, requester.participant_id],
  );
  for (const { id: decider } of deciders) {
    await deliverInbox(client, room_id, decider, {
      kind: "APPROVAL",
      ref: { kind: "approval", id },
      author_id: "system",
      summary: `${requester.participant_id} asks to run ${request.method}, which needs approval`,
    });
  }
  return { approval: approvalView(inserted.rows[0]!), created: true };
}

export const approvalsListParams = z.strictObject({
  /** Default: the ones still waiting. */
  status: z.enum(["PENDING", "APPROVED", "REJECTED", "WITHDRAWN", "EXPIRED"]).default("PENDING"),
  limit: z.number().int().min(1).max(MAX_APPROVALS_PAGE).default(DEFAULT_APPROVALS_PAGE),
  /** Continue after this approval id (the last of the previous page). */
  after: z.string().min(1).max(100).optional(),
});

export const approvalsWithdrawParams = z.strictObject({
  approval_id: z.string().min(1).max(100),
});

export const approvalsDecideParams = z.strictObject({
  approval_id: z.string().min(1).max(100),
  decision: z.enum(["approve", "reject"]),
  note: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .refine((v) => !v.includes("\0"), "Text contains NUL")
    .optional(),
});

/**
 * Register `approvals.list`, `approvals.decide` and `approvals.withdraw` (T905, §22.2).
 *
 * - **list**: the owner and admins see every approval of the room, with its params; anyone else
 *   only their own requests; by status (default pending), oldest first, paged with `after`. A
 *   pending approval past its 24 hours reads as `EXPIRED`. Each carries the requester's
 *   provenance, since its params are their words.
 * - **decide**: the owner or an admin (by the policy; the lead is not a decider, so that an
 *   agent lead can't approve other agents' gated actions) approves or rejects a pending approval;
 *   never their own request (`FORBIDDEN`, `self_approval`). **Approving runs the stored command,
 *   once, as its requester**, in the same transaction, and records the result under the
 *   requester's idempotency key, so a retry of the original request replays it rather than
 *   running it again. Its events (authored by the requester) follow `approval.decided`. If it
 *   fails now (its params no longer validate, the requester has lost the capability) nothing
 *   changes and the approval stays pending; a refusal names the requester and, as
 *   `on_behalf_of`, the approver. Only the approval gate is lifted. Rejecting, or approving
 *   after the 24 hours, never runs it (`VALIDATION`, `expired`, for the latter). The requester
 *   gets an `APPROVAL` inbox item with the outcome.
 * - **withdraw**: the requester takes back their own pending request; it can never run, and a
 *   retry with the same key says so.
 */
export function registerApprovalCommands(dispatcher: Dispatcher): void {
  dispatcher.registerCommand({
    method: "approvals.list",
    action: "approvals.read",
    mutating: false,
    view: "participant",
    params: approvalsListParams,
    execute: async (ctx, p) => {
      const { rows: me } = await ctx.client.query<{ authority: string }>(
        "SELECT authority FROM participants WHERE id = $1 AND room_id = $2",
        [ctx.principal.participant_id, ctx.room_id],
      );
      // The owner and admins decide, so they see every request in full; anyone else, only their own.
      const sees = me[0]?.authority === "OWNER" || me[0]?.authority === "ADMIN";
      const values: unknown[] = [
        ctx.room_id,
        p.status,
        p.limit + 1,
        sees,
        ctx.principal.participant_id,
      ];
      let where = `room_id = $1 AND ($4::boolean OR requester_id = $5)
        AND (CASE WHEN status = 'PENDING' AND expires_at <= clock_timestamp()
                  THEN 'EXPIRED' ELSE status END) = $2`;
      if (p.after !== undefined) {
        const { rows } = await ctx.client.query<{ ts: string }>(
          `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ts
           FROM approvals WHERE id = $1 AND room_id = $2`,
          [p.after, ctx.room_id],
        );
        if (!rows[0]) throw new CrossoverError("NOT_FOUND", `Approval ${p.after} not found`);
        values.push(rows[0].ts, p.after);
        where += ` AND (created_at, id COLLATE "C") > ($6::timestamptz, $7)`;
      }
      const { rows } = await ctx.client.query<ApprovalRow>(
        `SELECT ${COLUMNS} FROM approvals WHERE ${where}
         ORDER BY created_at, id COLLATE "C" LIMIT $3`,
        values,
      );
      const page = rows.slice(0, p.limit);
      // The params are the requester's own words, shown to whoever decides on them (§16.5).
      const kinds = await loadAuthorKinds(
        ctx.client,
        ctx.room_id,
        page.map((r) => r.requester_id),
      );
      return {
        response: {
          approvals: page.map((r) => ({
            ...approvalView(r),
            provenance: provenanceOf(kinds, r.requester_id),
          })),
          has_more: rows.length > p.limit,
        },
      };
    },
  });

  dispatcher.registerCommand({
    method: "approvals.decide",
    mutating: true,
    params: approvalsDecideParams,
    execute: async (ctx, p) => {
      const { rows } = await ctx.client.query<ApprovalRow>(
        `SELECT ${COLUMNS} FROM approvals WHERE id = $1 AND room_id = $2 FOR UPDATE`,
        [p.approval_id, ctx.room_id],
      );
      const approval = rows[0];
      if (!approval) throw new CrossoverError("NOT_FOUND", `Approval ${p.approval_id} not found`);
      if (approval.requester_id === ctx.principal.participant_id) {
        throw new CrossoverError("FORBIDDEN", "Nobody approves their own request", {
          details: { reason: "self_approval" },
        });
      }
      if (approval.status !== "PENDING") {
        throw new CrossoverError("VALIDATION", "That approval was already decided", {
          details: { reason: "already_decided", status: approval.status },
        });
      }
      if (approval.lapsed) {
        throw new CrossoverError("VALIDATION", "That approval has expired", {
          details: { reason: "expired" },
        });
      }
      const decided = {
        type: "approval.decided" as const,
        payload: {
          approval_id: approval.id,
          requester_id: approval.requester_id,
          method: approval.method,
          decision: p.decision,
        },
      };
      let events: EmittedEvent[] = [];
      let executed: unknown;
      if (p.decision === "approve") {
        // Run it under the requester's own idempotency key, so that key now stands for this
        // result: a retry of the original request replays it instead of running it again.
        let inner: CommandResult<unknown> | undefined;
        const stored = await withIdempotency(
          ctx.client,
          approval.requester_id,
          approval.idempotency_key,
          approval.idempotency_hash,
          async () => {
            inner = await dispatcher.runApproved(ctx, approval);
            return { response: inner.response ?? null, events: [] };
          },
        );
        executed = stored.response;
        events = (inner?.events ?? []).map((e) => ({
          ...e,
          actor_id: e.actor_id ?? approval.requester_id,
        }));
      }
      const { rows: updated } = await ctx.client.query<ApprovalRow>(
        `UPDATE approvals SET status = $3, decided_by = $4, decided_at = clock_timestamp(), note = $5
         WHERE id = $1 AND room_id = $2 RETURNING ${COLUMNS}`,
        [
          approval.id,
          ctx.room_id,
          p.decision === "approve" ? "APPROVED" : "REJECTED",
          ctx.principal.participant_id,
          p.note ?? null,
        ],
      );
      await deliverInbox(ctx.client, ctx.room_id, approval.requester_id, {
        kind: "APPROVAL",
        ref: { kind: "approval", id: approval.id },
        author_id: "system",
        summary: `Your request to run ${approval.method} was ${p.decision === "approve" ? "approved and has run" : "rejected"}`,
      });
      return {
        response: {
          approval: approvalView(updated[0]!),
          ...(executed === undefined ? {} : { result: executed }),
        },
        events: [decided, ...events],
      };
    },
  });

  dispatcher.registerCommand({
    method: "approvals.withdraw",
    action: "approvals.read",
    mutating: true,
    params: approvalsWithdrawParams,
    execute: async (ctx, p) => {
      const { rows } = await ctx.client.query<ApprovalRow>(
        `SELECT ${COLUMNS} FROM approvals WHERE id = $1 AND room_id = $2 FOR UPDATE`,
        [p.approval_id, ctx.room_id],
      );
      const approval = rows[0];
      // Someone else's request looks the same as one that isn't there.
      if (!approval || approval.requester_id !== ctx.principal.participant_id) {
        throw new CrossoverError("NOT_FOUND", `Approval ${p.approval_id} not found`);
      }
      if (approval.status !== "PENDING" || approval.lapsed) {
        throw new CrossoverError("VALIDATION", "That approval is no longer waiting", {
          details: {
            reason: approval.lapsed ? "expired" : "already_decided",
            status: approval.status,
          },
        });
      }
      const { rows: updated } = await ctx.client.query<ApprovalRow>(
        `UPDATE approvals SET status = 'WITHDRAWN', decided_by = $3, decided_at = clock_timestamp()
         WHERE id = $1 AND room_id = $2 RETURNING ${COLUMNS}`,
        [approval.id, ctx.room_id, ctx.principal.participant_id],
      );
      return {
        response: { approval: approvalView(updated[0]!) },
        events: [
          {
            type: "approval.decided" as const,
            payload: {
              approval_id: approval.id,
              requester_id: approval.requester_id,
              method: approval.method,
              decision: "withdraw",
            },
          },
        ],
      };
    },
  });
}
