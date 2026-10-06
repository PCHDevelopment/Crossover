import { withTransaction, type Pool, type PoolClient } from "@crossover/db";
import { appendEvents, hashRequest, withIdempotency, type NewEvent } from "@crossover/ledger";
import {
  commandEnvelopeSchema,
  CrossoverError,
  isMethodName,
  METHODS,
  newId,
  type CommandEnvelope,
  type EventType,
  type RoomEvent,
} from "@crossover/protocol";
import type { z } from "zod";
import { RoomActorRegistry } from "./actor.js";
import { RoomLeases, type RoomLeasesOptions } from "./leases.js";
import type { Principal } from "./principal.js";
import type { EventPublisher } from "./publisher.js";

/** An event emitted by a command; the dispatcher adds the sequence, hash and causation id. */
export interface EmittedEvent {
  type: EventType;
  payload?: Record<string, unknown>;
  /** Defaults to the principal's participant id; set it for system-generated events. */
  actor_id?: string;
  schema_version?: number;
}

export interface CommandContext {
  /** In a transaction for mutating commands; do all writes through it. */
  client: PoolClient;
  principal: Principal;
  room_id: string;
  /** The command envelope's id; it becomes the events' `causation_id`. */
  command_id: string;
  /** The envelope's idempotency key: always set for mutating commands, undefined for reads. */
  idempotency_key: string | undefined;
  /**
   * Run the policy check again for a finer-grained resource (e.g. each path of a ChangeSet).
   * Same principal, same transaction; `room_id` is filled in. Throws `FORBIDDEN` to deny.
   */
  authorize(action: string, resource?: Record<string, unknown>): Promise<void>;
  /**
   * Run `callback` once this command's transaction has committed, still on the room's actor
   * (so nothing else for the room runs in between). Not run if the command fails or rolls
   * back, nor when an idempotent duplicate is replayed. A callback that throws can't undo
   * the commit: the error goes to `onAfterCommitError` and the command still succeeds
   * (PostgreSQL wins, §19.4). Mutating commands only. Use it for the canonical Git ref
   * update (§19.4 step 3) and for publishing events (T118).
   */
  afterCommit(callback: () => void | Promise<void>): void;
}

/** A platform user acting outside any room, e.g. to create one (no participant exists yet). */
export interface UserPrincipal {
  user_id: string;
  display_name: string;
}

/** What a roomless command gets while it runs inside the transaction that creates its room. */
export interface RoomlessContext {
  client: PoolClient;
  user: UserPrincipal;
  /** The id reserved for the room this command creates; `execute` must insert that room. */
  room_id: string;
  command_id: string;
  idempotency_key: string;
  /** Run once the transaction has committed (see `CommandContext.afterCommit`). */
  afterCommit(callback: () => void | Promise<void>): void;
}

export interface RoomlessCommandDefinition<S extends z.ZodType, R> {
  /** A method in the catalog, marked mutating. */
  method: string;
  params: S;
  /**
   * Must create the room row with id `ctx.room_id` (and whatever else it needs, such as its
   * owner). The dispatcher then takes the new room's lease and appends the returned events
   * as sequence 1, 2, … in the same transaction. Events need an explicit `actor_id`: there is
   * no principal yet.
   */
  execute(ctx: RoomlessContext, params: z.infer<S>): Promise<CommandResult<R>>;
}

/** What an anonymous command gets: the credential it carries is its only authority. */
export interface AnonymousContext {
  client: PoolClient;
  room_id: string;
  /** A fresh id for this call; it becomes the events' `causation_id`. */
  command_id: string;
  afterCommit(callback: () => void | Promise<void>): void;
}

export interface AnonymousCommandDefinition<S extends z.ZodType, R> {
  /** Free-form name (these commands are not in the §16.1 catalog and take no envelope). */
  method: string;
  params: S;
  /**
   * Find the room this call is for, from its params (typically by looking up a token).
   * Return `undefined` if there is none; the dispatcher then answers `UNAUTHENTICATED`
   * with a generic message, so callers can't tell a bad credential from a missing room.
   */
  resolveRoom(pool: Pool, params: z.infer<S>): Promise<string | undefined>;
  /** Runs in the room's transaction. Events need an explicit `actor_id`. */
  execute(ctx: AnonymousContext, params: z.infer<S>): Promise<CommandResult<R>>;
}

export interface CommandResult<R> {
  /** Returned to the caller; stored with the idempotency key, so it must be plain JSON data. */
  response: R;
  /** Appended to the room's ledger in the same transaction. Not allowed for reads. */
  events?: EmittedEvent[];
  /**
   * Same as `ctx.afterCommit(…)`, for a command that only knows what to run once it has
   * finished executing. Runs after any callbacks registered through `ctx`.
   */
  afterCommit?: () => void | Promise<void>;
  /**
   * A secret to hand to the caller exactly once, such as a freshly minted token. Returned as
   * `DispatchResult.one_time` on the first execution only: it is **never** stored with the
   * idempotency key, appended to the ledger, published, or logged, so an idempotent replay
   * gets the stored `response` but no `one_time`. Mutating room commands only.
   */
  oneTime?: unknown;
}

export interface CommandDefinition<S extends z.ZodType, R> {
  /** A §16.1 method name. */
  method: string;
  /** Validates `envelope.params`. */
  params: S;
  /** Must equal the method's flag in `METHODS`. */
  mutating: boolean;
  /** The capability the policy checks (T208); defaults to the method name. */
  action?: string;
  execute(ctx: CommandContext, params: z.infer<S>): Promise<CommandResult<R>>;
}

/**
 * Policy hook (T208). Resolve to allow; throw `CrossoverError("FORBIDDEN", …)` to deny.
 * Mutating commands call it inside the transaction, so it can read consistent state.
 */
export type Authorizer = (
  principal: Principal,
  action: string,
  resource: { room_id: string; [key: string]: unknown },
  context: { method: string; params: unknown; client: PoolClient },
) => Promise<void>;

/** Allows everything. For tests only; production wiring must pass the real policy. */
export const allowAll: Authorizer = async () => {};

export interface DispatchResult<R = unknown> {
  response: R;
  /** The events this command appended (empty for reads). */
  events: RoomEvent[];
  /** True when an idempotent duplicate returned the stored result; nothing ran or was written. */
  replayed: boolean;
  /** See `CommandResult.oneTime`. Present only on the first execution of a command. */
  one_time?: unknown;
}

export interface DispatcherOptions {
  pool: Pool;
  /** Required: there is deliberately no default. See {@link allowAll}. */
  authorize: Authorizer;
  /** Unique per process; identifies this node in `room_leases`. */
  nodeId: string;
  actors?: RoomActorRegistry;
  leases?: RoomLeases;
  leaseTtlMs?: number;
  /** Runs when this node acquires a room's lease, before its first command. See {@link RoomLeasesOptions}. */
  onLeaseAcquire?: RoomLeasesOptions["onAcquire"];
  /**
   * Publishes the events of each committed command (after its `afterCommit` callbacks),
   * never for a rollback, a replay or a read. A failure is reported and never fails the
   * command: the events table is the outbox (§19.2).
   */
  publisher?: EventPublisher;
  /** Give up on a publish after this long, so a hung Redis can't stall the room. Default 1000 ms. */
  publishTimeoutMs?: number;
  /** Called when publishing fails or times out. Defaults to `console.error`. */
  onPublishError?: (
    error: unknown,
    info: { method: string; command_id: string; room_id: string },
  ) => void;
  /** Called when an `afterCommit` callback throws. Defaults to `console.error`. */
  onAfterCommitError?: (
    error: unknown,
    info: { method: string; command_id: string; room_id: string },
  ) => void;
}

interface Registered {
  def: CommandDefinition<z.ZodType, unknown>;
  action: string;
}

/**
 * Runs commands (ARCHITECTURE §16.2, §19.2).
 *
 * A mutating command: validate the envelope and params → run on the room's actor → ensure
 * this node holds the room lease → one transaction containing authorization, then
 * idempotency (`execute` + `appendEvents` with the lease's fencing token and the command id as
 * `causation_id`). If anything throws, nothing is persisted: no events, no state, no
 * idempotency record. A read skips the actor, lease and transaction.
 */
export class Dispatcher {
  private readonly commands = new Map<string, Registered>();
  private readonly roomlessCommands = new Map<
    string,
    RoomlessCommandDefinition<z.ZodType, unknown>
  >();
  private readonly anonymousCommands = new Map<
    string,
    AnonymousCommandDefinition<z.ZodType, unknown>
  >();
  private readonly pool: Pool;
  private readonly authorize: Authorizer;
  private readonly onAfterCommitError: NonNullable<DispatcherOptions["onAfterCommitError"]>;
  private readonly onPublishError: NonNullable<DispatcherOptions["onPublishError"]>;
  private readonly publisher: EventPublisher | undefined;
  private readonly publishTimeoutMs: number;
  readonly actors: RoomActorRegistry;
  readonly leases: RoomLeases;

  constructor(options: DispatcherOptions) {
    this.pool = options.pool;
    this.authorize = options.authorize;
    this.publisher = options.publisher;
    this.publishTimeoutMs = options.publishTimeoutMs ?? 1_000;
    this.onPublishError =
      options.onPublishError ??
      ((error, info) => console.error(`publishing events failed for ${info.method}`, info, error));
    this.onAfterCommitError =
      options.onAfterCommitError ??
      ((error, info) =>
        console.error(`afterCommit callback failed for ${info.method}`, info, error));
    this.actors = options.actors ?? new RoomActorRegistry();
    this.leases =
      options.leases ??
      new RoomLeases(options.pool, options.nodeId, options.leaseTtlMs, {
        ...(options.onLeaseAcquire ? { onAcquire: options.onLeaseAcquire } : {}),
      });
  }

  registerCommand<S extends z.ZodType, R>(def: CommandDefinition<S, R>): void {
    if (!isMethodName(def.method)) {
      throw new Error(`registerCommand: "${def.method}" is not a method in the §16.1 catalog`);
    }
    if (METHODS[def.method].mutating !== def.mutating) {
      throw new Error(
        `registerCommand: ${def.method} is ${METHODS[def.method].mutating ? "mutating" : "read-only"} in the catalog but registered with mutating: ${def.mutating}`,
      );
    }
    if (this.commands.has(def.method) || this.roomlessCommands.has(def.method)) {
      throw new Error(`registerCommand: ${def.method} is already registered`);
    }
    this.commands.set(def.method, {
      def: def as unknown as CommandDefinition<z.ZodType, unknown>,
      action: def.action ?? def.method,
    });
  }

  /**
   * Register a command that creates its own room (so there is no room to scope it to yet),
   * called through {@link dispatchRoomless}. A method is either room-bound or roomless:
   * `dispatch` answers `NOT_FOUND` for a roomless method and vice versa.
   */
  registerRoomlessCommand<S extends z.ZodType, R>(def: RoomlessCommandDefinition<S, R>): void {
    if (!isMethodName(def.method)) {
      throw new Error(`registerRoomlessCommand: "${def.method}" is not in the method catalog`);
    }
    if (!METHODS[def.method].mutating) {
      throw new Error(`registerRoomlessCommand: ${def.method} must be a mutating method`);
    }
    if (this.commands.has(def.method) || this.roomlessCommands.has(def.method)) {
      throw new Error(`registerRoomlessCommand: ${def.method} is already registered`);
    }
    this.roomlessCommands.set(
      def.method,
      def as unknown as RoomlessCommandDefinition<z.ZodType, unknown>,
    );
  }

  async dispatch(principal: Principal, envelopeInput: unknown): Promise<DispatchResult> {
    const parsedEnvelope = commandEnvelopeSchema.safeParse(envelopeInput);
    if (!parsedEnvelope.success) {
      throw validation("Invalid command envelope", parsedEnvelope.error.issues);
    }
    const envelope = parsedEnvelope.data;

    const registered = this.commands.get(envelope.method);
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

    return def.mutating
      ? this.runMutating(principal, envelope, def, action, params)
      : this.runRead(principal, envelope, def, action, params);
  }

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
  async dispatchRoomless(user: UserPrincipal, envelopeInput: unknown): Promise<DispatchResult> {
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

    const def = this.roomlessCommands.get(envelope.method);
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

    const result = await withTransaction(this.pool, async (client): Promise<DispatchResult> => {
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
          if (out.afterCommit) afterCommit.push(out.afterCommit);
          // The room row exists now, so its lease can be taken (and seen by appendEvents)
          // inside this transaction.
          token = await this.leases.acquireFor(client, room_id);
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

    if (!result.replayed && token !== undefined) this.leases.adopt(room_id, token);
    // Callbacks and publishing happen outside any room actor here: the room is new and nothing
    // else can be addressing it yet.
    await this.afterCommitWork(room_id, envelope, afterCommit, result);
    return result;
  }

  /**
   * Register a command whose caller proves itself with a credential in the params rather than
   * as a participant (joining a room with an invite token). Called through
   * {@link dispatchAnonymous}.
   */
  registerAnonymousCommand<S extends z.ZodType, R>(def: AnonymousCommandDefinition<S, R>): void {
    if (
      this.commands.has(def.method) ||
      this.roomlessCommands.has(def.method) ||
      this.anonymousCommands.has(def.method)
    ) {
      throw new Error(`registerAnonymousCommand: ${def.method} is already registered`);
    }
    this.anonymousCommands.set(
      def.method,
      def as unknown as AnonymousCommandDefinition<z.ZodType, unknown>,
    );
  }

  /**
   * Run an anonymous command: validate the params, find the room, then (on that room's actor,
   * holding its lease) one transaction with `execute` and the events it returns, appended with
   * the fencing token. There is no authorizer and no idempotency key: the credential the
   * command consumes is single use, so a retry is refused by the command itself.
   *
   * Params are validated before anything is consumed, so a validation error never burns a
   * credential. `UNAUTHENTICATED` when the command can't resolve a room.
   */
  async dispatchAnonymous(method: string, input: unknown): Promise<DispatchResult> {
    const def = this.anonymousCommands.get(method);
    if (!def) {
      throw new CrossoverError("NOT_FOUND", `Unknown method ${method}`, { details: { method } });
    }
    const parsed = def.params.safeParse(input);
    if (!parsed.success) throw validation(`Invalid params for ${method}`, parsed.error.issues);
    const params: unknown = parsed.data;

    const room_id = await def.resolveRoom(this.pool, params);
    if (room_id === undefined) {
      throw new CrossoverError("UNAUTHENTICATED", "Invalid or expired token");
    }
    const command_id = newId("cmd");
    const envelope = { method, id: command_id };

    return this.actors.get(room_id).submit(async () => {
      const token = await this.leases.ensure(room_id);
      const afterCommit: (() => void | Promise<void>)[] = [];
      let oneTime: unknown;
      let result: DispatchResult;
      try {
        result = await withTransaction(this.pool, async (client): Promise<DispatchResult> => {
          const ctx: AnonymousContext = {
            client,
            room_id,
            command_id,
            afterCommit: (callback) => void afterCommit.push(callback),
          };
          const out = await def.execute(ctx, params);
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
        if (err instanceof CrossoverError && err.code === "STALE_FENCE")
          this.leases.forget(room_id);
        throw err;
      }
      await this.afterCommitWork(room_id, envelope, afterCommit, result);
      return oneTime === undefined ? result : { ...result, one_time: oneTime };
    });
  }

  /**
   * After a commit: run the command's `afterCommit` callbacks on the actor, so no other
   * command for the room can slip in between the commit and (say) the Git ref update (a
   * replay registers none), then publish the events (never for a replay).
   */
  private async afterCommitWork(
    room_id: string,
    envelope: { method: string; id: string },
    callbacks: readonly (() => void | Promise<void>)[],
    result: DispatchResult,
  ): Promise<void> {
    for (const callback of callbacks) {
      try {
        await callback();
      } catch (error) {
        this.onAfterCommitError(error, {
          method: envelope.method,
          command_id: envelope.id,
          room_id,
        });
      }
    }
    if (this.publisher && !result.replayed && result.events.length > 0) {
      await this.publish(this.publisher, room_id, envelope, result.events);
    }
  }

  private async publish(
    publisher: EventPublisher,
    room_id: string,
    envelope: { method: string; id: string },
    events: RoomEvent[],
  ): Promise<void> {
    const info = { method: envelope.method, command_id: envelope.id, room_id };
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        publisher.publish(room_id, events),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`publish timed out after ${this.publishTimeoutMs} ms`)),
            this.publishTimeoutMs,
          );
        }),
      ]);
    } catch (error) {
      try {
        this.onPublishError(error, info);
      } catch {
        // A broken error handler must not fail a committed command either.
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private async runRead(
    principal: Principal,
    envelope: CommandEnvelope,
    def: CommandDefinition<z.ZodType, unknown>,
    action: string,
    params: unknown,
  ): Promise<DispatchResult> {
    const client = await this.pool.connect();
    try {
      const room_id = principal.room_id;
      await this.authorize(
        principal,
        action,
        { room_id },
        { method: envelope.method, params, client },
      );
      const ctx: CommandContext = {
        client,
        principal,
        room_id,
        command_id: envelope.id,
        idempotency_key: envelope.idempotency_key,
        authorize: (a, resource) =>
          this.authorize(
            principal,
            a,
            { ...resource, room_id },
            { method: envelope.method, params, client },
          ),
        afterCommit: () => {
          throw new Error(`${envelope.method} is read-only: afterCommit needs a transaction`);
        },
      };
      const out = await def.execute(ctx, params);
      if (out.events && out.events.length > 0) {
        throw new Error(`${envelope.method} is read-only but emitted events`);
      }
      return { response: out.response, events: [], replayed: false };
    } finally {
      client.release();
    }
  }

  private runMutating(
    principal: Principal,
    envelope: CommandEnvelope,
    def: CommandDefinition<z.ZodType, unknown>,
    action: string,
    params: unknown,
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

    return this.actors.get(room_id).submit(async () => {
      const token = await this.leases.ensure(room_id);
      const afterCommit: (() => void | Promise<void>)[] = [];
      let oneTime: unknown;
      let result: DispatchResult;
      try {
        result = await withTransaction(this.pool, async (client): Promise<DispatchResult> => {
          // Authorize before the idempotency lookup: a principal who is no longer allowed
          // must not be able to read a stored response, and FORBIDDEN is never cached.
          await this.authorize(
            principal,
            action,
            { room_id },
            { method: envelope.method, params, client },
          );

          let ran = false;
          const stored = await withIdempotency(
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
                authorize: (a, resource) =>
                  this.authorize(
                    principal,
                    a,
                    { ...resource, room_id },
                    { method: envelope.method, params, client },
                  ),
                afterCommit: (callback) => void afterCommit.push(callback),
              };
              const out = await def.execute(ctx, params);
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
              return { response: out.response, events };
            },
          );
          return { response: stored.response, events: stored.events, replayed: !ran };
        });
      } catch (err) {
        // Our token is no good any more (takeover or expiry): re-acquire on the next command.
        if (err instanceof CrossoverError && err.code === "STALE_FENCE")
          this.leases.forget(room_id);
        throw err;
      }

      await this.afterCommitWork(room_id, envelope, afterCommit, result);
      // The one-time secret rides back to this caller only; it is not part of `stored`.
      return oneTime === undefined || result.replayed ? result : { ...result, one_time: oneTime };
    });
  }
}

function validation(message: string, issues: unknown): CrossoverError {
  return new CrossoverError("VALIDATION", message, { details: { issues } });
}
