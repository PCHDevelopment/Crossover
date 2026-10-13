import { withTransaction } from "@crossover/db";
import { appendEvents, hashRequest, IDEMPOTENCY_TTL_HOURS } from "@crossover/ledger";
import { CrossoverError, type ErrorBody, type RoomEvent } from "@crossover/protocol";
import type { z } from "zod";
import { queueApproval, type ApprovalRow } from "../modules/approvals/approvals.js";
import type { Principal } from "../principal.js";
import type { DispatcherCore } from "./core.js";
import { afterCommitWork } from "./delivery.js";
import {
  type CommandContext,
  type CommandResult,
  type CommandDefinition,
  type DispatchResult,
} from "./types.js";

import { errorFromBody, validation } from "./errors.js";

/**
 * The command was stopped by an approval gate (§22.2) and rolled back: keep it for the owner
 * or an admin in a transaction of its own (`approval.requested`, inbox items), and return the
 * error to throw, now naming the approval. If it can't be kept, the original error stands.
 */
export async function queueForApproval(
  core: DispatcherCore,

  principal: Principal,
  envelope: { method: string; id: string },
  def: CommandDefinition<z.ZodType, unknown>,
  params: unknown,
  idempotency: { key: string; hash: string },
  error: CrossoverError,
  token: number,
): Promise<
  { error: CrossoverError; replay?: undefined } | { replay: DispatchResult; error?: undefined }
> {
  if (def.returnsOneTime || def.notApprovable) {
    return {
      error: new CrossoverError("VALIDATION", `${envelope.method} can't wait for approval`, {
        details: { reason: "not_approvable", method: envelope.method },
      }),
    };
  }
  // The authorization came first, ahead of the idempotency lookup, so a request that already ran
  // (approved earlier, the gate still on) would be queued again: replay its stored result.
  const { rows: used } = await core.pool.query<{
    request_hash: string;
    response: {
      response: unknown;
      events: RoomEvent[];
      committed_error?: ErrorBody["error"];
    } | null;
  }>(
    `SELECT request_hash, response FROM idempotency_keys
     WHERE participant_id = $1 AND idempotency_key = $2
       AND created_at >= clock_timestamp() - make_interval(hours => $3)`,
    [principal.participant_id, idempotency.key, IDEMPOTENCY_TTL_HOURS],
  );
  // The key stands for the request it first ran: reusing it for another, gated one is the usual
  // key-reuse error, and must not leave an approval nobody could decide.
  if (used[0] && used[0].request_hash !== idempotency.hash) {
    return {
      error: new CrossoverError(
        "VALIDATION",
        "Idempotency key was already used with a different request",
        { details: { idempotency_key: idempotency.key } },
      ),
    };
  }
  const stored = used[0]?.response;
  if (stored) {
    if (stored.committed_error) return { error: errorFromBody(stored.committed_error) };
    return {
      replay: {
        response: stored.response,
        events: stored.events ?? [],
        replayed: true,
      },
    };
  }
  const capability =
    typeof error.details?.["capability"] === "string"
      ? error.details["capability"]
      : envelope.method;
  try {
    const queued = await withTransaction(core.pool, async (client) => {
      const {
        approval,
        created,
        events: inboxEvents,
      } = await queueApproval(client, principal, {
        method: envelope.method,
        params,
        idempotency_key: idempotency.key,
        idempotency_hash: idempotency.hash,
        capability,
      });
      const events = created
        ? await appendEvents(
            client,
            principal.room_id,
            [
              {
                type: "approval.requested",
                actor_id: principal.participant_id,
                causation_id: envelope.id,
                payload: {
                  approval_id: approval.id,
                  method: envelope.method,
                  capability,
                  expires_at: approval.expires_at,
                },
              },
              ...inboxEvents.map((event) => ({
                type: event.type,
                actor_id: event.actor_id ?? "system",
                causation_id: envelope.id,
                ...(event.payload !== undefined ? { payload: event.payload } : {}),
                ...(event.schema_version !== undefined
                  ? { schema_version: event.schema_version }
                  : {}),
              })),
            ],
            token,
          )
        : [];
      return { approval, events };
    });
    await afterCommitWork(core, principal.room_id, envelope, [], {
      response: undefined,
      events: queued.events,
      replayed: false,
    });
    return {
      error: new CrossoverError("APPROVAL_REQUIRED", error.message, {
        details: {
          ...error.details,
          approval_id: queued.approval.id,
          expires_at: queued.approval.expires_at,
        },
      }),
    };
  } catch (queueError) {
    if (queueError instanceof CrossoverError && queueError.code === "VALIDATION") {
      return { error: queueError };
    }
    // Without an approval there is nothing to wait for: say so, don't answer "queued".
    core.onDenialRecordError(queueError, {
      method: envelope.method,
      command_id: envelope.id,
      room_id: principal.room_id,
      action: "approval.requested",
    });
    return {
      error: new CrossoverError("STALE_FENCE", "The request couldn't be queued; retry it", {
        retryable: true,
      }),
    };
  }
}

/**
 * Run the command an approval kept (T905), as its requester, inside the approver's
 * transaction (`outer`). The approval gate is lifted for it; every other check still applies.
 * Returns what the command returned, for the caller to append its events. A command that
 * returns a one-time secret can't run this way (`VALIDATION`, `one_time_result`).
 */
export async function runApproved(
  core: DispatcherCore,
  outer: CommandContext,
  approval: ApprovalRow,
): Promise<CommandResult<unknown>> {
  const registered = core.commands.get(approval.method);
  if (!registered || !registered.def.mutating) {
    throw new CrossoverError("VALIDATION", `Approval is for a method that isn't available now`, {
      details: { reason: "unknown_method", method: approval.method },
    });
  }
  const { def, action } = registered;
  const parsed = def.params.safeParse(approval.params);
  if (!parsed.success)
    throw validation(`Invalid params for ${approval.method}`, parsed.error.issues);
  const params: unknown = parsed.data;
  const { client, room_id } = outer;
  const requester = await core.principalOf(client, room_id, approval.requester_id);
  // A refusal while running the approved command is the requester's, so it names them; the
  // approver, whose transaction this is, is who the denial is recorded against.
  const check = (principal: Principal, a: string, resource: Record<string, unknown>, extra = {}) =>
    core
      .authorize(
        principal,
        a,
        { ...resource, room_id },
        { method: approval.method, params, client, approved: true, ...extra },
      )
      .catch((error: unknown) => core.onBehalfOf(error, principal.participant_id));
  await check(requester, action, {}, def.perPathAuthorize ? { perPath: true } : {});
  const ctx: CommandContext = {
    client,
    principal: requester,
    room_id,
    command_id: outer.command_id,
    idempotency_key: approval.idempotency_key,
    authorize: (a, resource, options) =>
      check(requester, a, resource ?? {}, options?.anyScope ? { perPath: true } : {}),
    authorizeAs: async (participantId, a, resource, options) =>
      check(
        await core.principalOf(client, room_id, participantId),
        a,
        resource ?? {},
        options?.anyScope ? { perPath: true } : {},
      ).catch((error: unknown) => core.onBehalfOf(error, participantId)),
    afterCommit: outer.afterCommit,
  };
  const out = await def.execute(ctx, params);
  if (out.oneTime !== undefined) {
    throw new CrossoverError("VALIDATION", "That command returns a one-time secret", {
      details: { reason: "one_time_result", method: approval.method },
    });
  }
  if (out.afterCommit) outer.afterCommit(out.afterCommit);
  return out;
}

/**
 * Whether an owner or admin approved this very request (same requester, idempotency key and
 * params) for a command that waits for the requester's retry instead of running on approval.
 */
export async function gateLifted(
  core: DispatcherCore,

  principal: Principal,
  envelope: { method: string; idempotency_key?: string | undefined; params?: unknown },
  def: CommandDefinition<z.ZodType, unknown>,
): Promise<boolean> {
  if (!def.approvalLiftsGate || envelope.idempotency_key === undefined) return false;
  let hash: string;
  try {
    hash = hashRequest({
      room_id: principal.room_id,
      method: envelope.method,
      params: envelope.params,
    });
  } catch {
    return false;
  }
  const { rowCount } = await core.pool.query(
    `SELECT 1 FROM approvals
     WHERE room_id = $1 AND requester_id = $2 AND idempotency_key = $3 AND idempotency_hash = $4
       AND status = 'APPROVED'
       AND decided_at >= clock_timestamp() - make_interval(hours => $5)`,
    [
      principal.room_id,
      principal.participant_id,
      envelope.idempotency_key,
      hash,
      IDEMPOTENCY_TTL_HOURS,
    ],
  );
  return (rowCount ?? 0) > 0;
}

/** Whether `method` runs when an approval is granted (the usual case), or waits for the requester's retry. */
export function runsOnApproval(core: DispatcherCore, method: string): boolean {
  return !core.commands.get(method)?.def.approvalLiftsGate;
}
