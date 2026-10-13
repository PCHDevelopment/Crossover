import { type PoolClient } from "@crossover/db";
import { isMethodName, METHODS, type RoomEvent } from "@crossover/protocol";
import type { z } from "zod";
import type { RoomActorRegistry } from "./actor.js";
import type { RoomLeases } from "./leases.js";
import { type ApprovalRow } from "./modules/approvals/approvals.js";
import type { Principal } from "./principal.js";
import { DispatcherCore } from "./dispatcher/core.js";
import { runApproved, runsOnApproval } from "./dispatcher/approvals.js";
import { dispatch } from "./dispatcher/room-commands.js";
import { dispatchAnonymous, dispatchRoomless, runSystem } from "./dispatcher/special-commands.js";
import {
  READ_VIEWS,
  type EmittedEvent,
  type CommandContext,
  type UserPrincipal,
  type RoomlessCommandDefinition,
  type AnonymousCommandDefinition,
  type CommandResult,
  type CommandDefinition,
  type CommandInfo,
  type DispatchResult,
  type DispatcherOptions,
} from "./dispatcher/types.js";

// The public surface of this module is unchanged: these moved to dispatcher/types.ts. Listed by name
// so that what stays internal there (the two local result types) does not become API.
export {
  READ_VIEWS,
  allowAll,
  type AnonymousCommandDefinition,
  type AnonymousContext,
  type Authorizer,
  type AuthorizeOptions,
  type CommandContext,
  type CommandDefinition,
  type CommandInfo,
  type CommandResult,
  type DispatchResult,
  type DispatcherOptions,
  type EmittedEvent,
  type PrepareContext,
  type ReadView,
  type RoomlessCommandDefinition,
  type RoomlessContext,
  type UserPrincipal,
} from "./dispatcher/types.js";

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
    return dispatch(this.core, principal, envelopeInput);
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
    return dispatchRoomless(this.core, user, envelopeInput);
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
    return dispatchAnonymous(this.core, method, input, expectedRoomId);
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
    return runSystem(this.core, room_id, name, execute, options);
  }

  /**
   * Run the command an approval kept (T905), as its requester, inside the approver's
   * transaction (`outer`). The approval gate is lifted for it; every other check still applies.
   * Returns what the command returned, for the caller to append its events. A command that
   * returns a one-time secret can't run this way (`VALIDATION`, `one_time_result`).
   */
  async runApproved(outer: CommandContext, approval: ApprovalRow): Promise<CommandResult<unknown>> {
    return runApproved(this.core, outer, approval);
  }

  /** Whether `method` runs when an approval is granted (the usual case), or waits for the requester's retry. */
  runsOnApproval(method: string): boolean {
    return runsOnApproval(this.core, method);
  }
}
