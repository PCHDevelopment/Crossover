import { withTransaction } from "@crossover/db";
import { appendEvents, hashRequest, withIdempotency, type NewEvent } from "@crossover/ledger";
import {
  commandEnvelopeSchema,
  CrossoverError,
  type CommandEnvelope,
  type RoomEvent,
} from "@crossover/protocol";
import type { z } from "zod";
import type { Principal } from "../principal.js";
import type { DispatcherCore } from "./core.js";
import { afterCommitWork, publish } from "./delivery.js";
import { gateLifted, queueForApproval } from "./approvals.js";
import { errorFromBody, validation } from "./errors.js";
import { enforceBudgets, isReplay, requestHashOf } from "./budget-gate.js";
import { recordDenial } from "./denials.js";
import {
  type CommandContext,
  type CommandDefinition,
  type DispatchResult,
  type DispatchResultWithCommittedError,
  type StoredCommandResult,
} from "./types.js";

export async function dispatch(
  core: DispatcherCore,
  principal: Principal,
  envelopeInput: unknown,
): Promise<DispatchResult> {
  const parsedEnvelope = commandEnvelopeSchema.safeParse(envelopeInput);
  if (!parsedEnvelope.success) {
    throw validation("Invalid command envelope", parsedEnvelope.error.issues);
  }
  const envelope = parsedEnvelope.data;

  const registered = core.commands.get(envelope.method);
  if (!registered) {
    throw new CrossoverError("NOT_FOUND", `Unknown method ${envelope.method}`, {
      details: { method: envelope.method },
    });
  }
  const { def, action } = registered;

  const parsedParams = def.params.safeParse(envelope.params);
  if (!parsedParams.success) {
    throw validation(`Invalid params for ${envelope.method}`, parsedParams.error.issues);
  }
  const params: unknown = parsedParams.data;

  await enforceBudgets(core, principal, envelope);
  return def.mutating
    ? runMutating(core, principal, envelope, def, action, params)
    : runRead(core, principal, envelope, def, action, params);
}

export async function runRead(
  core: DispatcherCore,
  principal: Principal,
  envelope: CommandEnvelope,
  def: CommandDefinition<z.ZodType, unknown>,
  action: string,
  params: unknown,
): Promise<DispatchResult> {
  const client = await core.pool.connect();
  try {
    const room_id = principal.room_id;
    await core.authorize(
      principal,
      action,
      { room_id },
      {
        method: envelope.method,
        params,
        client,
        ...(def.perPathAuthorize ? { perPath: true } : {}),
      },
    );
    const ctx: CommandContext = {
      client,
      principal,
      room_id,
      command_id: envelope.id,
      idempotency_key: envelope.idempotency_key,
      authorize: (a, resource, options) =>
        core.disguised(
          () =>
            core.authorize(
              principal,
              a,
              { ...resource, room_id },
              {
                method: envelope.method,
                params,
                client,
                ...(options?.anyScope ? { perPath: true } : {}),
              },
            ),
          options,
        ),
      authorizeAs: async (participantId, a, resource, options) =>
        core
          .authorize(
            await core.principalOf(client, room_id, participantId),
            a,
            { ...resource, room_id },
            {
              method: envelope.method,
              params,
              client,
              ...(options?.anyScope ? { perPath: true } : {}),
            },
          )
          .catch((error: unknown) => core.onBehalfOf(error, participantId)),
      afterCommit: () => {
        throw new Error(`${envelope.method} is read-only: afterCommit needs a transaction`);
      },
    };
    const out = await def.execute(ctx, params);
    if (out.committedError) {
      throw new CrossoverError("VALIDATION", `${envelope.method} cannot return a committed error`);
    }
    if (out.events && out.events.length > 0) {
      throw new Error(`${envelope.method} is read-only but emitted events`);
    }
    return { response: out.response, events: [], replayed: false };
  } catch (error) {
    if (typeof error === "object" && error !== null && core.denials.has(error)) {
      // Writing the event takes the room's turn and lease; the read itself didn't.
      await core.actors
        .get(principal.room_id)
        .submit(async () =>
          recordDenial(
            core,
            principal,
            envelope,
            error,
            await core.leases.ensure(principal.room_id),
          ),
        )
        .catch(() => undefined);
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function runMutating(
  core: DispatcherCore,
  principal: Principal,
  envelope: CommandEnvelope,
  def: CommandDefinition<z.ZodType, unknown>,
  action: string,
  params: unknown,
): Promise<DispatchResult> {
  if (!def.prepare) return runMutatingIn(core, principal, envelope, def, action, params, undefined);
  const key = envelope.idempotency_key;
  let prepared: unknown;
  let ran = false;
  try {
    // Only for a principal who may run it, and not for a replay of a request that already ran.
    // A refusal here is left for the command's own authorization to report and record.
    const lifted = await gateLifted(core, principal, envelope, def);
    const allowed = await mayPrepare(core, principal, envelope, action, def, params);
    if (allowed && key !== undefined && !(await isReplay(core, principal, envelope))) {
      ran = true;
      prepared = await def.prepare(
        {
          pool: core.pool,
          principal,
          room_id: principal.room_id,
          command_id: envelope.id,
          idempotency_key: key,
          request_hash: requestHashOf(principal, envelope),
          isAllowed: (a, resource, options) =>
            isAllowed(
              core,
              principal,
              envelope.method,
              params,
              a,
              resource,
              options?.anyScope,
              lifted,
            ),
        },
        params,
      );
    }
    return await runMutatingIn(core, principal, envelope, def, action, params, prepared);
  } finally {
    if (ran && prepared !== undefined && def.disposePrepared) {
      await def.disposePrepared(prepared).catch(() => undefined);
    }
  }
}

/** Whether `principal` may do `action` now, without recording a denial; a failure that isn't a refusal is thrown. */
export async function isAllowed(
  core: DispatcherCore,
  principal: Principal,
  method: string,
  params: unknown,
  action: string,
  resource: Record<string, unknown> = {},
  anyScope = false,
  approved = false,
): Promise<boolean> {
  const client = await core.pool.connect();
  try {
    await core.authorizer(
      principal,
      action,
      { ...resource, room_id: principal.room_id },
      {
        method,
        params,
        client,
        ...(anyScope ? { perPath: true } : {}),
        ...(approved ? { approved: true } : {}),
      },
    );
    return true;
  } catch (error) {
    if (error instanceof CrossoverError) return false;
    throw new CrossoverError("STALE_FENCE", "Couldn't check the request just now; retry it", {
      retryable: true,
      details: { reason: "prepare_unavailable" },
      cause: error,
    });
  } finally {
    client.release();
  }
}

/** Whether the principal passes the command's authorization now, without recording a denial. */
export async function mayPrepare(
  core: DispatcherCore,
  principal: Principal,
  envelope: CommandEnvelope,
  action: string,
  def: CommandDefinition<z.ZodType, unknown>,
  params: unknown,
): Promise<boolean> {
  const client = await core.pool.connect();
  try {
    await core.authorizer(
      principal,
      action,
      { room_id: principal.room_id },
      {
        method: envelope.method,
        params,
        client,
        ...(def.perPathAuthorize ? { perPath: true } : {}),
      },
    );
    return true;
  } catch (error) {
    // A refusal is the command's own authorization to report (and record). Anything else (the
    // database unreachable, say) is not a refusal: say to retry, not "internal error".
    if (error instanceof CrossoverError) return false;
    throw new CrossoverError("STALE_FENCE", "Couldn't check the request just now; retry it", {
      retryable: true,
      details: { reason: "prepare_unavailable" },
      cause: error,
    });
  } finally {
    client.release();
  }
}

/**
 * Execute one room command in its actor and transaction. A command marked `spawnsRoom` may
 * insert one child room here: both ledgers commit together, and the child's lease is adopted
 * only after commit. An idempotent replay does not append or publish child events.
 */
export function runMutatingIn(
  core: DispatcherCore,
  principal: Principal,
  envelope: CommandEnvelope,
  def: CommandDefinition<z.ZodType, unknown>,
  action: string,
  params: unknown,
  prepared: unknown,
): Promise<DispatchResult> {
  const key = envelope.idempotency_key;
  if (key === undefined) {
    // The envelope schema already requires it for mutating methods.
    throw validation("idempotency_key is required", []);
  }
  const room_id = principal.room_id;
  let requestHash: string;
  try {
    requestHash = hashRequest({ room_id, method: envelope.method, params: envelope.params });
  } catch (err) {
    // canonicalJson refuses values JSON can't represent (undefined, Date, functions, …).
    throw validation("params must be plain JSON data", [{ message: (err as Error).message }]);
  }

  return core.actors.get(room_id).submit(async () => {
    const token = await core.leases.ensure(room_id);
    const lifted = await gateLifted(core, principal, envelope, def);
    const afterCommit: (() => void | Promise<void>)[] = [];
    let oneTime: unknown;
    let spawned: { room_id: string; token: number; events: RoomEvent[] } | undefined;
    let result: DispatchResultWithCommittedError;
    try {
      result = await withTransaction(core.pool, async (client) => {
        // Authorize before the idempotency lookup: a principal who is no longer allowed
        // must not be able to read a stored response, and FORBIDDEN is never cached.
        await core.authorize(
          principal,
          action,
          { room_id },
          {
            method: envelope.method,
            params,
            client,
            ...(def.perPathAuthorize ? { perPath: true } : {}),
          },
        );

        let ran = false;
        const stored = await withIdempotency<StoredCommandResult>(
          client,
          principal.participant_id,
          key,
          requestHash,
          async () => {
            ran = true;
            const ctx: CommandContext = {
              client,
              principal,
              room_id,
              command_id: envelope.id,
              idempotency_key: key,
              ...(prepared === undefined ? {} : { prepared }),
              authorize: (a, resource, options) =>
                core.disguised(
                  () =>
                    core.authorize(
                      principal,
                      a,
                      { ...resource, room_id },
                      {
                        method: envelope.method,
                        params,
                        client,
                        ...(options?.anyScope ? { perPath: true } : {}),
                        ...(lifted ? { approved: true } : {}),
                      },
                    ),
                  options,
                ),
              authorizeAs: async (participantId, a, resource, options) =>
                core
                  .authorize(
                    await core.principalOf(client, room_id, participantId),
                    a,
                    { ...resource, room_id },
                    {
                      method: envelope.method,
                      params,
                      client,
                      ...(options?.anyScope ? { perPath: true } : {}),
                    },
                  )
                  .catch((error: unknown) => core.onBehalfOf(error, participantId)),
              afterCommit: (callback) => void afterCommit.push(callback),
            };
            const out = await def.execute(ctx, params);
            if (out.committedError && out.oneTime !== undefined) {
              throw new CrossoverError(
                "VALIDATION",
                `${envelope.method} cannot return both a committed error and a one-time result`,
              );
            }
            if (out.afterCommit) afterCommit.push(out.afterCommit);
            oneTime = out.oneTime;
            const emitted: NewEvent[] = (out.events ?? []).map((e) => ({
              type: e.type,
              actor_id: e.actor_id ?? principal.participant_id,
              causation_id: envelope.id,
              ...(e.payload !== undefined ? { payload: e.payload } : {}),
              ...(e.schema_version !== undefined ? { schema_version: e.schema_version } : {}),
            }));
            const events = await appendEvents(client, room_id, emitted, token);
            if (out.spawnRoom) {
              if (!def.spawnsRoom) {
                throw new Error(`${envelope.method} returned spawnRoom without spawnsRoom`);
              }
              const child = out.spawnRoom;
              if (child.room_id === room_id) {
                throw new Error(`${envelope.method} cannot spawn its own room`);
              }
              const childEvents: NewEvent[] = child.events.map((event) => {
                if (event.actor_id === undefined) {
                  throw new Error(`${envelope.method}: spawned room events need an actor_id`);
                }
                return {
                  type: event.type,
                  actor_id: event.actor_id,
                  causation_id: envelope.id,
                  ...(event.payload !== undefined ? { payload: event.payload } : {}),
                  ...(event.schema_version !== undefined
                    ? { schema_version: event.schema_version }
                    : {}),
                };
              });
              const childToken = await core.leases.acquireFor(client, child.room_id);
              spawned = {
                room_id: child.room_id,
                token: childToken,
                events: await appendEvents(client, child.room_id, childEvents, childToken),
              };
            }
            return {
              response: out.response,
              events,
              ...(out.committedError
                ? { committed_error: out.committedError.toErrorBody().error }
                : {}),
            };
          },
        );
        const result: DispatchResultWithCommittedError = {
          response: stored.response,
          events: stored.events,
          replayed: !ran,
          ...(stored.committed_error ? { committed_error: stored.committed_error } : {}),
        };
        return result;
      });
    } catch (err) {
      // Our token is no good any more (takeover or expiry): re-acquire on the next command.
      if (err instanceof CrossoverError && err.code === "STALE_FENCE") core.leases.forget(room_id);
      await recordDenial(core, principal, envelope, err, token);
      if (
        err instanceof CrossoverError &&
        err.code === "APPROVAL_REQUIRED" &&
        err.details?.["approval_id"] === undefined
      ) {
        const queued = await queueForApproval(
          core,
          principal,
          envelope,
          def,
          params,
          { key, hash: requestHash },
          err,
          token,
        );
        if (queued.replay) return queued.replay;
        throw queued.error;
      }
      throw err;
    }

    await afterCommitWork(core, room_id, envelope, afterCommit, result);
    if (!result.replayed && spawned) {
      core.leases.adopt(spawned.room_id, spawned.token);
      if (core.publisher) {
        await publish(core, core.publisher, spawned.room_id, envelope, spawned.events);
      }
    }
    const committedError = result.committed_error;
    if (committedError) throw errorFromBody(committedError);
    // The one-time secret rides back to this caller only; it is not part of `stored`.
    return oneTime === undefined || result.replayed ? result : { ...result, one_time: oneTime };
  });
}
