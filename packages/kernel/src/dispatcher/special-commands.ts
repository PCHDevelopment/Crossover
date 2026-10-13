import { withTransaction, type PoolClient } from "@crossover/db";
import { appendEvents, hashRequest, withIdempotency, type NewEvent } from "@crossover/ledger";
import { commandEnvelopeSchema, CrossoverError, newId, type RoomEvent } from "@crossover/protocol";
import type { DispatcherCore } from "./core.js";
import { afterCommitWork } from "./delivery.js";
import { validation } from "./errors.js";
import {
  type EmittedEvent,
  type UserPrincipal,
  type RoomlessContext,
  type AnonymousContext,
  type DispatchResult,
} from "./types.js";

/**
 * Run a roomless command (e.g. `room.create`) for a platform user. Like a mutating
 * command, but the room doesn't exist yet: one transaction contains the idempotency check
 * (scoped to the user), `execute` (which inserts the room), the new room's lease (acquired
 * inside the transaction) and the events (sequence 1, 2, …). After the commit this node
 * keeps the lease, so the room's first command doesn't need to acquire it again.
 *
 * Creating a room needs no capability beyond being an authenticated user; there is no
 * authorizer hook here.
 */
export async function dispatchRoomless(
  core: DispatcherCore,
  user: UserPrincipal,
  envelopeInput: unknown,
): Promise<DispatchResult> {
  if (
    !user ||
    typeof user.user_id !== "string" ||
    user.user_id === "" ||
    typeof user.display_name !== "string" ||
    user.display_name === ""
  ) {
    throw validation("A user with a user_id and display_name is required", []);
  }
  const parsedEnvelope = commandEnvelopeSchema.safeParse(envelopeInput);
  if (!parsedEnvelope.success) {
    throw validation("Invalid command envelope", parsedEnvelope.error.issues);
  }
  const envelope = parsedEnvelope.data;

  const def = core.roomlessCommands.get(envelope.method);
  if (!def) {
    throw new CrossoverError("NOT_FOUND", `Unknown method ${envelope.method}`, {
      details: { method: envelope.method },
    });
  }
  const parsedParams = def.params.safeParse(envelope.params);
  if (!parsedParams.success) {
    throw validation(`Invalid params for ${envelope.method}`, parsedParams.error.issues);
  }
  const params: unknown = parsedParams.data;
  const key = envelope.idempotency_key;
  if (key === undefined) throw validation("idempotency_key is required", []);

  let requestHash: string;
  try {
    requestHash = hashRequest({
      user_id: user.user_id,
      method: envelope.method,
      params: envelope.params,
    });
  } catch (err) {
    throw validation("params must be plain JSON data", [{ message: (err as Error).message }]);
  }

  // The room id is reserved up front. A replay returns the stored response (which names the
  // room that was created the first time), so this id is simply unused then.
  const room_id = newId("room");
  const afterCommit: (() => void | Promise<void>)[] = [];
  let token: number | undefined;

  const result = await withTransaction(core.pool, async (client): Promise<DispatchResult> => {
    let ran = false;
    const stored = await withIdempotency(
      client,
      `user:${user.user_id}`,
      key,
      requestHash,
      async () => {
        ran = true;
        const ctx: RoomlessContext = {
          client,
          user,
          room_id,
          command_id: envelope.id,
          idempotency_key: key,
          afterCommit: (callback) => void afterCommit.push(callback),
        };
        const out = await def.execute(ctx, params);
        if (out.committedError) {
          throw new CrossoverError(
            "VALIDATION",
            `${envelope.method} cannot return a committed error`,
          );
        }
        if (out.afterCommit) afterCommit.push(out.afterCommit);
        // The room row exists now, so its lease can be taken (and seen by appendEvents)
        // inside this transaction.
        token = await core.leases.acquireFor(client, room_id);
        const emitted: NewEvent[] = (out.events ?? []).map((e) => {
          if (e.actor_id === undefined) {
            throw new Error(`${envelope.method}: events of a roomless command need an actor_id`);
          }
          return {
            type: e.type,
            actor_id: e.actor_id,
            causation_id: envelope.id,
            ...(e.payload !== undefined ? { payload: e.payload } : {}),
            ...(e.schema_version !== undefined ? { schema_version: e.schema_version } : {}),
          };
        });
        const events = await appendEvents(client, room_id, emitted, token);
        return { response: out.response, events };
      },
    );
    return { response: stored.response, events: stored.events, replayed: !ran };
  });

  if (!result.replayed && token !== undefined) core.leases.adopt(room_id, token);
  // Callbacks and publishing happen outside any room actor here: the room is new and nothing
  // else can be addressing it yet.
  await afterCommitWork(core, room_id, envelope, afterCommit, result);
  return result;
}

/**
 * Run an anonymous command: validate the params, find the room, then (on that room's actor,
 * holding its lease) one transaction with `execute` and the events it returns, appended with
 * the fencing token. There is no authorizer and no idempotency key: the credential the
 * command consumes is single use, so a retry is refused by the command itself.
 *
 * Params are validated before anything is consumed, so a validation error never burns a
 * credential. `UNAUTHENTICATED` when the command can't resolve a room, or (with
 * `expectedRoomId`, e.g. from a URL path) resolves a different one: nothing is consumed and
 * the answer is the same generic one as for an unknown credential.
 */
export async function dispatchAnonymous(
  core: DispatcherCore,
  method: string,
  input: unknown,
  expectedRoomId?: string,
): Promise<DispatchResult> {
  const def = core.anonymousCommands.get(method);
  if (!def) {
    throw new CrossoverError("NOT_FOUND", `Unknown method ${method}`, { details: { method } });
  }
  const parsed = def.params.safeParse(input);
  if (!parsed.success) throw validation(`Invalid params for ${method}`, parsed.error.issues);
  const params: unknown = parsed.data;

  const room_id = await def.resolveRoom(core.pool, params);
  if (room_id === undefined || (expectedRoomId !== undefined && room_id !== expectedRoomId)) {
    throw new CrossoverError("UNAUTHENTICATED", "Invalid or expired token");
  }
  const command_id = newId("cmd");
  const envelope = { method, id: command_id };

  return core.actors.get(room_id).submit(async () => {
    const token = await core.leases.ensure(room_id);
    const afterCommit: (() => void | Promise<void>)[] = [];
    let oneTime: unknown;
    let result: DispatchResult;
    try {
      result = await withTransaction(core.pool, async (client): Promise<DispatchResult> => {
        const ctx: AnonymousContext = {
          client,
          room_id,
          command_id,
          afterCommit: (callback) => void afterCommit.push(callback),
        };
        const out = await def.execute(ctx, params);
        if (out.committedError) {
          throw new CrossoverError("VALIDATION", `${method} cannot return a committed error`);
        }
        if (out.afterCommit) afterCommit.push(out.afterCommit);
        oneTime = out.oneTime;
        const emitted: NewEvent[] = (out.events ?? []).map((e) => {
          if (e.actor_id === undefined) {
            throw new Error(`${method}: events of an anonymous command need an actor_id`);
          }
          return {
            type: e.type,
            actor_id: e.actor_id,
            causation_id: command_id,
            ...(e.payload !== undefined ? { payload: e.payload } : {}),
            ...(e.schema_version !== undefined ? { schema_version: e.schema_version } : {}),
          };
        });
        const events = await appendEvents(client, room_id, emitted, token);
        return { response: out.response, events, replayed: false };
      });
    } catch (err) {
      if (err instanceof CrossoverError && err.code === "STALE_FENCE") core.leases.forget(room_id);
      throw err;
    }
    await afterCommitWork(core, room_id, envelope, afterCommit, result);
    return oneTime === undefined ? result : { ...result, one_time: oneTime };
  });
}

/**
 * Run work the platform itself does in a room, such as the task lease sweeper (T311): on the
 * room's actor, holding its lease, in one transaction that also appends the events `execute`
 * returns (each with an explicit `actor_id`), which are published after the commit. There is
 * no principal, no authorizer and no idempotency key; `name` is only for logs and errors.
 *
 * **A room that isn't `ACTIVE` is frozen** (§5, §22.1): by default the platform doesn't change
 * it either. `allowReadOnly` is for platform audit events caused by reads, such as an export;
 * it permits `PAUSED` and `ARCHIVED`, never `DELETED`. The status is read under a lock inside
 * the transaction, so a freeze that commits first wins, and `execute` doesn't run:
 * `whenFrozen()` gives the result (no events), or, if you passed none, the call fails with
 * `ROOM_PAUSED` carrying `details.room_status`.
 */
export async function runSystem<R>(
  core: DispatcherCore,
  room_id: string,
  name: string,
  execute: (ctx: {
    client: PoolClient;
    room_id: string;
    command_id: string;
  }) => Promise<{ result: R; events: (EmittedEvent & { actor_id: string })[] }>,
  options: { whenFrozen?: () => R; allowReadOnly?: boolean } = {},
): Promise<{ result: R; events: RoomEvent[] }> {
  const command_id = newId("cmd");
  return core.actors.get(room_id).submit(async () => {
    const token = await core.leases.ensure(room_id);
    let out: { result: R; events: RoomEvent[] };
    try {
      out = await withTransaction(core.pool, async (client) => {
        const { rows: room } = await client.query<{ status: string }>(
          "SELECT status FROM rooms WHERE id = $1 FOR SHARE",
          [room_id],
        );
        const status = room[0]?.status;
        if (
          status !== "ACTIVE" &&
          !(options.allowReadOnly && (status === "PAUSED" || status === "ARCHIVED"))
        ) {
          if (options.whenFrozen) return { result: options.whenFrozen(), events: [] };
          throw new CrossoverError("ROOM_PAUSED", `Room ${room_id} is ${status ?? "missing"}`, {
            details: { room_status: status ?? null },
          });
        }
        const done = await execute({ client, room_id, command_id });
        const events = await appendEvents(
          client,
          room_id,
          done.events.map((e) => ({
            type: e.type,
            actor_id: e.actor_id,
            causation_id: command_id,
            ...(e.payload !== undefined ? { payload: e.payload } : {}),
            ...(e.schema_version !== undefined ? { schema_version: e.schema_version } : {}),
          })),
          token,
        );
        return { result: done.result, events };
      });
    } catch (err) {
      if (err instanceof CrossoverError && err.code === "STALE_FENCE") core.leases.forget(room_id);
      throw err;
    }
    await afterCommitWork(core, room_id, { method: name, id: command_id }, [], {
      response: undefined,
      events: out.events,
      replayed: false,
    });
    return out;
  });
}
