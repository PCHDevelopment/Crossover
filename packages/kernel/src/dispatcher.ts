import { withTransaction, type PoolClient } from "@crossover/db";
import {
  appendEvents,
  hashRequest,
  IDEMPOTENCY_TTL_HOURS,
  withIdempotency,
  type NewEvent,
} from "@crossover/ledger";
import {
  commandEnvelopeSchema,
  CrossoverError,
  isMethodName,
  METHODS,
  newId,
  type ErrorBody,
  type CommandEnvelope,
  type RoomEvent,
} from "@crossover/protocol";
import type { z } from "zod";
import type { RoomActorRegistry } from "./actor.js";
import { BUDGET_DEFAULTS, budgetsOf, limitFor, readOverrides, type BudgetName } from "./budgets.js";
import type { RoomLeases } from "./leases.js";
import { queueApproval, type ApprovalRow } from "./modules/approvals/approvals.js";
import type { Principal } from "./principal.js";
import { DispatcherCore } from "./dispatcher/core.js";
import { afterCommitWork } from "./dispatcher/delivery.js";
import { recordDenial } from "./dispatcher/denials.js";
import {
  READ_VIEWS,
  type EmittedEvent,
  type CommandContext,
  type UserPrincipal,
  type RoomlessContext,
  type RoomlessCommandDefinition,
  type AnonymousContext,
  type AnonymousCommandDefinition,
  type CommandResult,
  type CommandDefinition,
  type CommandInfo,
  type DispatchResult,
  type DispatchResultWithCommittedError,
  type StoredCommandResult,
  type DispatcherOptions,
} from "./dispatcher/types.js";

// The public surface of this module is unchanged: the types moved to dispatcher/types.ts.
export * from "./dispatcher/types.js";

function errorFromBody(error: ErrorBody["error"]): CrossoverError {
  return new CrossoverError(error.code, error.message, {
    retryable: error.retryable,
    ...(error.details === undefined ? {} : { details: error.details }),
  });
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
  private readonly core: DispatcherCore;
  readonly actors: RoomActorRegistry;
  readonly leases: RoomLeases;

  constructor(options: DispatcherOptions) {
    this.core = new DispatcherCore(options);
    this.actors = this.core.actors;
    this.leases = this.core.leases;
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
    if (this.core.commands.has(def.method) || this.core.roomlessCommands.has(def.method)) {
      throw new Error(`registerCommand: ${def.method} is already registered`);
    }
    if (!def.mutating) {
      // §34.5: every read says how it applies the participant view, so a new one can't ship
      // without the question being asked.
      if (def.view === undefined || !READ_VIEWS.includes(def.view)) {
        throw new Error(
          `registerCommand: read command ${def.method} must declare view: ${READ_VIEWS.join(" | ")}`,
        );
      }
      if (def.view === "none" && !def.view_reason?.trim()) {
        throw new Error(
          `registerCommand: ${def.method} declares view: "none" without a view_reason`,
        );
      }
    } else if (def.view !== undefined) {
      throw new Error(`registerCommand: ${def.method} is mutating, so it declares no view`);
    }
    this.core.commands.set(def.method, {
      def: def as unknown as CommandDefinition<z.ZodType, unknown>,
      action: def.action ?? def.method,
    });
  }

  /** Every registered room command, with how each declares its view (T1301). */
  commandInfo(): CommandInfo[] {
    return [...this.core.commands.values()].map(({ def, action }) => ({
      method: def.method,
      mutating: def.mutating,
      action,
      view: def.view,
      view_reason: def.view_reason,
      view_probe: def.view_probe,
    }));
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
    if (this.core.commands.has(def.method) || this.core.roomlessCommands.has(def.method)) {
      throw new Error(`registerRoomlessCommand: ${def.method} is already registered`);
    }
    this.core.roomlessCommands.set(
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

    const registered = this.core.commands.get(envelope.method);
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

    await this.enforceBudgets(principal, envelope);
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

    const def = this.core.roomlessCommands.get(envelope.method);
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

    const result = await withTransaction(
      this.core.pool,
      async (client): Promise<DispatchResult> => {
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
            token = await this.leases.acquireFor(client, room_id);
            const emitted: NewEvent[] = (out.events ?? []).map((e) => {
              if (e.actor_id === undefined) {
                throw new Error(
                  `${envelope.method}: events of a roomless command need an actor_id`,
                );
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
      },
    );

    if (!result.replayed && token !== undefined) this.leases.adopt(room_id, token);
    // Callbacks and publishing happen outside any room actor here: the room is new and nothing
    // else can be addressing it yet.
    await afterCommitWork(this.core, room_id, envelope, afterCommit, result);
    return result;
  }

  /**
   * Register a command whose caller proves itself with a credential in the params rather than
   * as a participant (joining a room with an invite token). Called through
   * {@link dispatchAnonymous}.
   */
  registerAnonymousCommand<S extends z.ZodType, R>(def: AnonymousCommandDefinition<S, R>): void {
    if (
      this.core.commands.has(def.method) ||
      this.core.roomlessCommands.has(def.method) ||
      this.core.anonymousCommands.has(def.method)
    ) {
      throw new Error(`registerAnonymousCommand: ${def.method} is already registered`);
    }
    this.core.anonymousCommands.set(
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
   * credential. `UNAUTHENTICATED` when the command can't resolve a room, or (with
   * `expectedRoomId`, e.g. from a URL path) resolves a different one: nothing is consumed and
   * the answer is the same generic one as for an unknown credential.
   */
  async dispatchAnonymous(
    method: string,
    input: unknown,
    expectedRoomId?: string,
  ): Promise<DispatchResult> {
    const def = this.core.anonymousCommands.get(method);
    if (!def) {
      throw new CrossoverError("NOT_FOUND", `Unknown method ${method}`, { details: { method } });
    }
    const parsed = def.params.safeParse(input);
    if (!parsed.success) throw validation(`Invalid params for ${method}`, parsed.error.issues);
    const params: unknown = parsed.data;

    const room_id = await def.resolveRoom(this.core.pool, params);
    if (room_id === undefined || (expectedRoomId !== undefined && room_id !== expectedRoomId)) {
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
        result = await withTransaction(this.core.pool, async (client): Promise<DispatchResult> => {
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
        if (err instanceof CrossoverError && err.code === "STALE_FENCE")
          this.leases.forget(room_id);
        throw err;
      }
      await afterCommitWork(this.core, room_id, envelope, afterCommit, result);
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
  async runSystem<R>(
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
    return this.actors.get(room_id).submit(async () => {
      const token = await this.leases.ensure(room_id);
      let out: { result: R; events: RoomEvent[] };
      try {
        out = await withTransaction(this.core.pool, async (client) => {
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
        if (err instanceof CrossoverError && err.code === "STALE_FENCE")
          this.leases.forget(room_id);
        throw err;
      }
      await afterCommitWork(this.core, room_id, { method: name, id: command_id }, [], {
        response: undefined,
        events: out.events,
        replayed: false,
      });
      return out;
    });
  }

  /**
   * The command was stopped by an approval gate (§22.2) and rolled back: keep it for the owner
   * or an admin in a transaction of its own (`approval.requested`, inbox items), and return the
   * error to throw, now naming the approval. If it can't be kept, the original error stands.
   */
  private async queueForApproval(
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
    const { rows: used } = await this.core.pool.query<{
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
      const queued = await withTransaction(this.core.pool, async (client) => {
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
      await afterCommitWork(this.core, principal.room_id, envelope, [], {
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
      this.core.onDenialRecordError(queueError, {
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
  async runApproved(outer: CommandContext, approval: ApprovalRow): Promise<CommandResult<unknown>> {
    const registered = this.core.commands.get(approval.method);
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
    const requester = await this.core.principalOf(client, room_id, approval.requester_id);
    // A refusal while running the approved command is the requester's, so it names them; the
    // approver, whose transaction this is, is who the denial is recorded against.
    const check = (
      principal: Principal,
      a: string,
      resource: Record<string, unknown>,
      extra = {},
    ) =>
      this.core
        .authorize(
          principal,
          a,
          { ...resource, room_id },
          { method: approval.method, params, client, approved: true, ...extra },
        )
        .catch((error: unknown) => this.core.onBehalfOf(error, principal.participant_id));
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
          await this.core.principalOf(client, room_id, participantId),
          a,
          resource ?? {},
          options?.anyScope ? { perPath: true } : {},
        ).catch((error: unknown) => this.core.onBehalfOf(error, participantId)),
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
   * Count the command against the agent's budgets (§22.3) and refuse it with `BUDGET_EXCEEDED`
   * and `retry_after` (seconds) when one is used up. Agents only; the limits are the defaults
   * unless the room's `settings.budgets` or the participant's `budgets` override them. When both
   * have a finite value, the tighter limit applies. The first
   * refusal of a window is also recorded as `budget.exceeded`, so a flood of refused calls
   * writes one event, not one each. If the limiter or its overrides can't be read, the command
   * goes ahead.
   */
  private async enforceBudgets(
    principal: Principal,
    envelope: {
      method: string;
      id: string;
      idempotency_key?: string | undefined;
      params?: unknown;
    },
  ) {
    if (!this.core.budgets || principal.kind !== "AGENT") return;
    const room_id = principal.room_id;
    let refusal:
      { budget: BudgetName; limit: number; retry_after_ms: number; first: boolean } | undefined;
    try {
      // A retry of a command that already ran gets its stored result and costs nothing.
      if (await this.isReplay(principal, envelope)) return;
      const { rows } = await this.core.pool.query<{ room: unknown; mine: unknown }>(
        `SELECT r.settings -> 'budgets' AS room, p.budgets AS mine
         FROM participants p JOIN rooms r ON r.id = p.room_id
         WHERE p.id = $1 AND p.room_id = $2`,
        [principal.participant_id, room_id],
      );
      const room = readOverrides(rows[0]?.room);
      const mine = readOverrides(rows[0]?.mine);
      const keyOf = (budget: BudgetName) => ({
        room_id,
        participant_id: principal.participant_id,
        budget,
      });
      const applicable: { budget: BudgetName; limit: number }[] = [];
      for (const budget of budgetsOf(envelope.method)) {
        const limit = limitFor(budget, room, mine);
        if (limit !== null) applicable.push({ budget, limit });
      }
      // Look at every budget first: a command refused for one spends none of the others, so an
      // agent hammering a refused `messages.send` can still read.
      let exhausted: { budget: BudgetName; limit: number } | undefined;
      for (const item of applicable) {
        const used = await this.core.budgets.peek(
          keyOf(item.budget),
          BUDGET_DEFAULTS[item.budget].windowMs,
        );
        if (used >= item.limit) {
          exhausted = item;
          break;
        }
      }
      for (const item of exhausted ? [exhausted] : applicable) {
        const decision = await this.core.budgets.consume(
          keyOf(item.budget),
          item.limit,
          BUDGET_DEFAULTS[item.budget].windowMs,
        );
        if (!decision.allowed) {
          refusal = { ...item, ...decision };
          break;
        }
      }
    } catch (error) {
      try {
        this.core.onBudgetError(error, { method: envelope.method, room_id });
      } catch {
        // A broken error handler must not change the command's outcome.
      }
      return;
    }
    if (!refusal) return;
    const retryAfter = Math.max(1, Math.ceil(refusal.retry_after_ms / 1000));
    const details = {
      budget: refusal.budget,
      limit: refusal.limit,
      window_seconds: BUDGET_DEFAULTS[refusal.budget].windowMs / 1000,
      retry_after: retryAfter,
    };
    if (refusal.first) await this.recordBudgetExceeded(principal, envelope, details);
    throw new CrossoverError(
      "BUDGET_EXCEEDED",
      `The ${refusal.budget} budget (${refusal.limit} per ${details.window_seconds} s) is used up; retry in ${retryAfter} s`,
      { details },
    );
  }

  private requestHashOf(
    principal: Principal,
    envelope: { method: string; params?: unknown },
  ): string {
    return hashRequest({
      room_id: principal.room_id,
      method: envelope.method,
      params: envelope.params,
    });
  }

  /** Whether this exact request (same participant, key and content) already ran and has a stored result. */
  private async isReplay(
    principal: Principal,
    envelope: { method: string; idempotency_key?: string | undefined; params?: unknown },
  ): Promise<boolean> {
    if (envelope.idempotency_key === undefined) return false;
    let requestHash: string;
    try {
      requestHash = hashRequest({
        room_id: principal.room_id,
        method: envelope.method,
        params: envelope.params,
      });
    } catch {
      return false; // the command itself will say the params are bad
    }
    const { rowCount } = await this.core.pool.query(
      `SELECT 1 FROM idempotency_keys
       WHERE participant_id = $1 AND idempotency_key = $2 AND request_hash = $3
         AND response IS NOT NULL
         AND created_at >= clock_timestamp() - make_interval(hours => $4)`,
      [principal.participant_id, envelope.idempotency_key, requestHash, IDEMPOTENCY_TTL_HOURS],
    );
    return (rowCount ?? 0) > 0;
  }

  /** Append `budget.exceeded` in a transaction of its own. Never throws. */
  private async recordBudgetExceeded(
    principal: Principal,
    envelope: { method: string; id: string },
    details: Record<string, unknown>,
  ): Promise<void> {
    const room_id = principal.room_id;
    try {
      await this.actors.get(room_id).submit(async () => {
        const token = await this.leases.ensure(room_id);
        const events = await withTransaction(this.core.pool, (client) =>
          appendEvents(
            client,
            room_id,
            [
              {
                type: "budget.exceeded",
                actor_id: principal.participant_id,
                causation_id: envelope.id,
                payload: { ...details, method: envelope.method },
              },
            ],
            token,
          ),
        );
        await afterCommitWork(this.core, room_id, envelope, [], {
          response: undefined,
          events,
          replayed: false,
        });
      });
    } catch (error) {
      this.core.onDenialRecordError(error, {
        method: envelope.method,
        command_id: envelope.id,
        room_id,
        action: "budget.exceeded",
      });
    }
  }

  private async runRead(
    principal: Principal,
    envelope: CommandEnvelope,
    def: CommandDefinition<z.ZodType, unknown>,
    action: string,
    params: unknown,
  ): Promise<DispatchResult> {
    const client = await this.core.pool.connect();
    try {
      const room_id = principal.room_id;
      await this.core.authorize(
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
          this.core.disguised(
            () =>
              this.core.authorize(
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
          this.core
            .authorize(
              await this.core.principalOf(client, room_id, participantId),
              a,
              { ...resource, room_id },
              {
                method: envelope.method,
                params,
                client,
                ...(options?.anyScope ? { perPath: true } : {}),
              },
            )
            .catch((error: unknown) => this.core.onBehalfOf(error, participantId)),
        afterCommit: () => {
          throw new Error(`${envelope.method} is read-only: afterCommit needs a transaction`);
        },
      };
      const out = await def.execute(ctx, params);
      if (out.committedError) {
        throw new CrossoverError(
          "VALIDATION",
          `${envelope.method} cannot return a committed error`,
        );
      }
      if (out.events && out.events.length > 0) {
        throw new Error(`${envelope.method} is read-only but emitted events`);
      }
      return { response: out.response, events: [], replayed: false };
    } catch (error) {
      if (typeof error === "object" && error !== null && this.core.denials.has(error)) {
        // Writing the event takes the room's turn and lease; the read itself didn't.
        await this.actors
          .get(principal.room_id)
          .submit(async () =>
            recordDenial(
              this.core,
              principal,
              envelope,
              error,
              await this.leases.ensure(principal.room_id),
            ),
          )
          .catch(() => undefined);
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async runMutating(
    principal: Principal,
    envelope: CommandEnvelope,
    def: CommandDefinition<z.ZodType, unknown>,
    action: string,
    params: unknown,
  ): Promise<DispatchResult> {
    if (!def.prepare)
      return this.runMutatingIn(principal, envelope, def, action, params, undefined);
    const key = envelope.idempotency_key;
    let prepared: unknown;
    let ran = false;
    try {
      // Only for a principal who may run it, and not for a replay of a request that already ran.
      // A refusal here is left for the command's own authorization to report and record.
      const lifted = await this.gateLifted(principal, envelope, def);
      const allowed = await this.mayPrepare(principal, envelope, action, def, params);
      if (allowed && key !== undefined && !(await this.isReplay(principal, envelope))) {
        ran = true;
        prepared = await def.prepare(
          {
            pool: this.core.pool,
            principal,
            room_id: principal.room_id,
            command_id: envelope.id,
            idempotency_key: key,
            request_hash: this.requestHashOf(principal, envelope),
            isAllowed: (a, resource, options) =>
              this.isAllowed(
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
      return await this.runMutatingIn(principal, envelope, def, action, params, prepared);
    } finally {
      if (ran && prepared !== undefined && def.disposePrepared) {
        await def.disposePrepared(prepared).catch(() => undefined);
      }
    }
  }

  /** Whether `principal` may do `action` now, without recording a denial; a failure that isn't a refusal is thrown. */
  private async isAllowed(
    principal: Principal,
    method: string,
    params: unknown,
    action: string,
    resource: Record<string, unknown> = {},
    anyScope = false,
    approved = false,
  ): Promise<boolean> {
    const client = await this.core.pool.connect();
    try {
      await this.core.authorizer(
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

  /**
   * Whether an owner or admin approved this very request (same requester, idempotency key and
   * params) for a command that waits for the requester's retry instead of running on approval.
   */
  private async gateLifted(
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
    const { rowCount } = await this.core.pool.query(
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
  runsOnApproval(method: string): boolean {
    return !this.core.commands.get(method)?.def.approvalLiftsGate;
  }

  /** Whether the principal passes the command's authorization now, without recording a denial. */
  private async mayPrepare(
    principal: Principal,
    envelope: CommandEnvelope,
    action: string,
    def: CommandDefinition<z.ZodType, unknown>,
    params: unknown,
  ): Promise<boolean> {
    const client = await this.core.pool.connect();
    try {
      await this.core.authorizer(
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

  private runMutatingIn(
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

    return this.actors.get(room_id).submit(async () => {
      const token = await this.leases.ensure(room_id);
      const lifted = await this.gateLifted(principal, envelope, def);
      const afterCommit: (() => void | Promise<void>)[] = [];
      let oneTime: unknown;
      let result: DispatchResultWithCommittedError;
      try {
        result = await withTransaction(this.core.pool, async (client) => {
          // Authorize before the idempotency lookup: a principal who is no longer allowed
          // must not be able to read a stored response, and FORBIDDEN is never cached.
          await this.core.authorize(
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
                  this.core.disguised(
                    () =>
                      this.core.authorize(
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
                  this.core
                    .authorize(
                      await this.core.principalOf(client, room_id, participantId),
                      a,
                      { ...resource, room_id },
                      {
                        method: envelope.method,
                        params,
                        client,
                        ...(options?.anyScope ? { perPath: true } : {}),
                      },
                    )
                    .catch((error: unknown) => this.core.onBehalfOf(error, participantId)),
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
        if (err instanceof CrossoverError && err.code === "STALE_FENCE")
          this.leases.forget(room_id);
        await recordDenial(this.core, principal, envelope, err, token);
        if (
          err instanceof CrossoverError &&
          err.code === "APPROVAL_REQUIRED" &&
          err.details?.["approval_id"] === undefined
        ) {
          const queued = await this.queueForApproval(
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

      await afterCommitWork(this.core, room_id, envelope, afterCommit, result);
      const committedError = result.committed_error;
      if (committedError) throw errorFromBody(committedError);
      // The one-time secret rides back to this caller only; it is not part of `stored`.
      return oneTime === undefined || result.replayed ? result : { ...result, one_time: oneTime };
    });
  }
}

function validation(message: string, issues: unknown): CrossoverError {
  return new CrossoverError("VALIDATION", message, { details: { issues } });
}
