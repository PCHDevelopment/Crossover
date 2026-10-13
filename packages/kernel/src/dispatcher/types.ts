import { type Pool, type PoolClient } from "@crossover/db";
import type { CrossoverError } from "@crossover/protocol";
import { type ErrorBody, type EventType, type RoomEvent } from "@crossover/protocol";
import type { z } from "zod";
import type { RoomActorRegistry } from "../actor.js";
import { type BudgetLimiter } from "../budgets.js";
import type { RoomLeases } from "../leases.js";
import { type RoomLeasesOptions } from "../leases.js";
import type { Principal } from "../principal.js";
import type { EventPublisher } from "../publisher.js";

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
  /** What the command's `prepare` returned (T807), if it has one and ran. */
  prepared?: unknown;
  /**
   * Run the policy check again for a finer-grained resource (e.g. each path of a ChangeSet).
   * Same principal, same transaction; `room_id` is filled in. Throws `FORBIDDEN` to deny.
   * With `anyScope`, holding a grant of the capability for *some* scope is enough (to list what
   * someone may use at all, say); the specific scope is checked on use.
   */
  authorize(
    action: string,
    resource?: Record<string, unknown>,
    options?: AuthorizeOptions,
  ): Promise<void>;
  /**
   * Like {@link authorize}, but asks whether *another participant of this room* could do
   * `action` (say, whether someone offered the lead can accept it). It goes through the same
   * configured authorizer, in the same transaction, with the participant's current kind,
   * authority and role. `NOT_FOUND` if they aren't in this room.
   */
  authorizeAs(
    participantId: string,
    action: string,
    resource?: Record<string, unknown>,
    options?: AuthorizeOptions,
  ): Promise<void>;
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
  /** Commit the response and events but return this error to the caller (T903). */
  committedError?: CrossoverError;
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
  /**
   * Opt in (T218) only if `execute` calls `ctx.authorize(action, { path })` for **every** path
   * it reads, writes or reveals. The command-level gate then also lets in a participant who
   * holds only scoped grants of the capability (`workspace.write:docs/**`); without the flag a
   * scoped grant never opens the gate, because it doesn't cover the unscoped capability.
   * Declaring it on a command that doesn't check each path hands scoped holders everything.
   */
  perPathAuthorize?: boolean;
  /**
   * The command hands back a one-time secret (`oneTime`). It can't be kept for approval (T905):
   * the secret would go to the approver, not the requester.
   */
  returnsOneTime?: boolean;
  /**
   * The request contains secret data that must not be copied into the approvals table. Commands
   * with this flag can't be queued for approval; `returnsOneTime` implies the same restriction.
   */
  notApprovable?: boolean;
  /**
   * How a **read** command keeps one participant from seeing what another may not (§34.5,
   * T1301). Required for every non-mutating command; checked at registration.
   * - `participant`: what it returns can differ by reader (events, paths, denials) and goes
   *   through a kernel participant-view function, or authorizes each path for the caller.
   * - `own`: it returns the caller's own records only.
   * - `none`: what it returns is the same for every member of the room, with no events, paths
   *   or denials in it. A one-line `view_reason` saying why is required.
   */
  view?: ReadView;
  /** Required with `view: "none"`: why nothing in the output needs a per-reader view. */
  view_reason?: string;
  /**
   * Arguments the egress conformance test (T1301) calls this read with when `{}` isn't valid,
   * to see what it returns to a reader. A `participant` command must answer them (or
   * `NOT_FOUND` for a placeholder id); one that rejects them fails the test.
   */
  view_probe?: Record<string, unknown>;
  /**
   * Slow work that needs no lock (T807): a network fetch, say. Runs **before** the command's
   * transaction, off the room's actor, so it doesn't hold the room lease or any row lock and
   * other commands for the room carry on meanwhile. Its result reaches `execute` as
   * `ctx.prepared`. The principal was authorized first (a refusal skips `prepare`, and the
   * command then fails in the usual way), and it isn't run for a replay of a command that
   * already ran. **The room may change while it runs**: `execute` must re-check whatever
   * `prepare` assumed, and refuse with `CONFLICT_VERSION` if that no longer holds. Mutating
   * commands only.
   */
  prepare?(ctx: PrepareContext, params: z.infer<S>): Promise<unknown>;
  /**
   * For a command that must not run inside the approver's transaction (it has a side effect that
   * can't be rolled back): approving only lifts the gate for the requester's retry of the same
   * request (same idempotency key and params), which then runs through the ordinary path.
   */
  approvalLiftsGate?: boolean;
  /** Release what `prepare` made (a temporary directory), whatever `execute` did. Never throws into the command. */
  disposePrepared?(prepared: unknown): Promise<void>;
  execute(ctx: CommandContext, params: z.infer<S>): Promise<CommandResult<R>>;
}

export interface AuthorizeOptions {
  anyScope?: boolean;
  /**
   * On a refusal, throw the error this returns instead of the authorizer's, and record the denial
   * (`capability.denied`) all the same: for an answer that must not say what the authorizer knew.
   */
  refuseAs?: (refusal: CrossoverError) => CrossoverError;
}

/** What {@link CommandDefinition.prepare} gets: no transaction, no lease, just the pool. */
export interface PrepareContext {
  pool: Pool;
  principal: Principal;
  room_id: string;
  command_id: string;
  idempotency_key: string;
  /** The hash the dispatcher keeps the envelope's idempotency key under (room, method, raw params). */
  request_hash: string;
  /**
   * Whether the principal may do `action` on `resource` right now, for a check `prepare` needs
   * before something slow or external. A refusal is just `false`: nothing is recorded, and
   * `execute` runs the real check in the transaction. `anyScope` as in `CommandContext.authorize`.
   */
  isAllowed(
    action: string,
    resource?: Record<string, unknown>,
    options?: { anyScope?: boolean },
  ): Promise<boolean>;
}

/** How a read command applies the participant view (§34.5). */
export type ReadView = "participant" | "own" | "none";
export const READ_VIEWS: readonly ReadView[] = ["participant", "own", "none"];

/** What the dispatcher knows about a registered command, for conformance checks and docs. */
export interface CommandInfo {
  method: string;
  mutating: boolean;
  action: string;
  view: ReadView | undefined;
  view_reason: string | undefined;
  view_probe: Record<string, unknown> | undefined;
}

/**
 * Policy hook (T208). Resolve to allow; throw `CrossoverError("FORBIDDEN", …)` to deny.
 * Mutating commands call it inside the transaction, so it can read consistent state.
 */
export type Authorizer = (
  principal: Principal,
  action: string,
  resource: { room_id: string; [key: string]: unknown },
  context: {
    method: string;
    params: unknown;
    client: PoolClient;
    perPath?: boolean;
    approved?: boolean;
  },
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

export type DispatchResultWithCommittedError = DispatchResult & {
  committed_error?: ErrorBody["error"];
};

export type StoredCommandResult = {
  response: unknown;
  events: RoomEvent[];
  committed_error?: ErrorBody["error"];
};

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
  /**
   * Called when a `capability.denied` event (T215) could not be appended. The command's
   * `FORBIDDEN` is returned regardless. Defaults to `console.error`.
   */
  onDenialRecordError?: (
    error: unknown,
    info: { method: string; command_id: string; room_id: string; action: string },
  ) => void;
  /**
   * Per-agent budgets (§22.3), counted before a command's transaction. Without one, nothing is
   * limited.
   */
  budgets?: BudgetLimiter;
  /** Called when the limiter fails (Redis down): the command goes ahead. Defaults to `console.warn`. */
  onBudgetError?: (error: unknown, info: { method: string; room_id: string }) => void;
  /** Called when an `afterCommit` callback throws. Defaults to `console.error`. */
  onAfterCommitError?: (
    error: unknown,
    info: { method: string; command_id: string; room_id: string },
  ) => void;
}
