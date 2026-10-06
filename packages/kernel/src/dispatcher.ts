import { withTransaction, type Pool, type PoolClient } from "@crossover/db";
import { appendEvents, hashRequest, withIdempotency, type NewEvent } from "@crossover/ledger";
import {
  commandEnvelopeSchema,
  CrossoverError,
  isMethodName,
  METHODS,
  type CommandEnvelope,
  type EventType,
  type RoomEvent,
} from "@crossover/protocol";
import type { z } from "zod";
import { RoomActorRegistry } from "./actor.js";
import { RoomLeases } from "./leases.js";

/** Who is issuing a command. T201/T208 extend this with kind, authority and role. */
export interface Principal {
  participant_id: string;
  /** The room the command is for (the gateway checks it against the path and token). */
  room_id: string;
}

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
  private readonly pool: Pool;
  private readonly authorize: Authorizer;
  private readonly onAfterCommitError: NonNullable<DispatcherOptions["onAfterCommitError"]>;
  readonly actors: RoomActorRegistry;
  readonly leases: RoomLeases;

  constructor(options: DispatcherOptions) {
    this.pool = options.pool;
    this.authorize = options.authorize;
    this.onAfterCommitError =
      options.onAfterCommitError ??
      ((error, info) =>
        console.error(`afterCommit callback failed for ${info.method}`, info, error));
    this.actors = options.actors ?? new RoomActorRegistry();
    this.leases =
      options.leases ?? new RoomLeases(options.pool, options.nodeId, options.leaseTtlMs);
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
    if (this.commands.has(def.method)) {
      throw new Error(`registerCommand: ${def.method} is already registered`);
    }
    this.commands.set(def.method, {
      def: def as unknown as CommandDefinition<z.ZodType, unknown>,
      action: def.action ?? def.method,
    });
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

      // Committed. Run the callbacks on the actor, so no other command for this room can
      // slip in between the commit and (say) the Git ref update. A replay registers none.
      for (const callback of afterCommit) {
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
      return result;
    });
  }
}

function validation(message: string, issues: unknown): CrossoverError {
  return new CrossoverError("VALIDATION", message, { details: { issues } });
}
