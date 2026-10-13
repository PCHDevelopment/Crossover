import { type Pool, type PoolClient } from "@crossover/db";
import { CrossoverError } from "@crossover/protocol";
import type { z } from "zod";
import { RoomActorRegistry } from "../actor.js";
import { type BudgetLimiter } from "../budgets.js";
import { RoomLeases } from "../leases.js";
import type { Principal } from "../principal.js";
import type { EventPublisher } from "../publisher.js";

import { denialOf, type DenialInfo } from "./denials.js";
import type {
  Authorizer,
  AuthorizeOptions,
  CommandDefinition,
  DispatcherOptions,
  RoomlessCommandDefinition,
  AnonymousCommandDefinition,
} from "./types.js";

export interface Registered {
  def: CommandDefinition<z.ZodType, unknown>;
  action: string;
}

/**
 * The state every command family works on, and the few helpers all of them share. The
 * {@link Dispatcher} builds one; the functions of each family take it as their first parameter.
 */
export class DispatcherCore {
  readonly commands = new Map<string, Registered>();
  readonly roomlessCommands = new Map<string, RoomlessCommandDefinition<z.ZodType, unknown>>();
  readonly anonymousCommands = new Map<string, AnonymousCommandDefinition<z.ZodType, unknown>>();
  readonly pool: Pool;
  readonly authorizer: Authorizer;
  /** Authorization denials that have not been recorded yet, keyed by the error thrown for them. */
  readonly denials = new WeakMap<object, DenialInfo>();
  readonly onDenialRecordError: NonNullable<DispatcherOptions["onDenialRecordError"]>;
  readonly onAfterCommitError: NonNullable<DispatcherOptions["onAfterCommitError"]>;
  readonly onPublishError: NonNullable<DispatcherOptions["onPublishError"]>;
  readonly publisher: EventPublisher | undefined;
  readonly publishTimeoutMs: number;
  readonly actors: RoomActorRegistry;
  readonly leases: RoomLeases;

  readonly budgets: BudgetLimiter | undefined;
  readonly onBudgetError: NonNullable<DispatcherOptions["onBudgetError"]>;

  constructor(options: DispatcherOptions) {
    this.pool = options.pool;
    this.authorizer = options.authorize;
    this.onDenialRecordError =
      options.onDenialRecordError ??
      ((error, info) => console.error(`recording a denied ${info.action} failed`, info, error));
    this.publisher = options.publisher;
    this.publishTimeoutMs = options.publishTimeoutMs ?? 1_000;
    this.onPublishError =
      options.onPublishError ??
      ((error, info) => console.error(`publishing events failed for ${info.method}`, info, error));
    this.onAfterCommitError =
      options.onAfterCommitError ??
      ((error, info) =>
        console.error(`afterCommit callback failed for ${info.method}`, info, error));
    this.budgets = options.budgets;
    let lastBudgetWarning = 0;
    this.onBudgetError =
      options.onBudgetError ??
      ((error, info) => {
        // During an outage that is every agent command: say it once in a while.
        if (Date.now() - lastBudgetWarning < 30_000) return;
        lastBudgetWarning = Date.now();
        console.warn(
          `budget check failed for ${info.method}; letting commands through`,
          info,
          error,
        );
      });
    this.actors = options.actors ?? new RoomActorRegistry();
    this.leases =
      options.leases ??
      new RoomLeases(options.pool, options.nodeId, options.leaseTtlMs, {
        ...(options.onLeaseAcquire ? { onAcquire: options.onLeaseAcquire } : {}),
      });
  }

  /** Run an authorization; a refusal may be answered with another error that still records the denial. */
  async disguised(run: () => Promise<void>, options?: AuthorizeOptions): Promise<void> {
    try {
      await run();
    } catch (error) {
      if (options?.refuseAs && error instanceof CrossoverError && error.code === "FORBIDDEN") {
        const replacement = options.refuseAs(error);
        const info = this.denials.get(error);
        if (info) this.denials.set(replacement, info);
        throw replacement;
      }
      throw error;
    }
  }

  /** A denial for someone else's `authorizeAs` check says so, so it isn't read as the caller's own. */
  onBehalfOf(error: unknown, participantId: string): never {
    const info = typeof error === "object" && error !== null ? this.denials.get(error) : undefined;
    if (info) info.on_behalf_of = participantId;
    throw error;
  }

  /** A participant's current principal, for {@link CommandContext.authorizeAs}. */
  async principalOf(client: PoolClient, roomId: string, participantId: string): Promise<Principal> {
    const { rows } = await client.query<Omit<Principal, "participant_id" | "room_id">>(
      "SELECT kind, authority, role FROM participants WHERE id = $1 AND room_id = $2",
      [participantId, roomId],
    );
    const row = rows[0];
    if (!row) throw new CrossoverError("NOT_FOUND", `Participant ${participantId} not found`);
    return { participant_id: participantId, room_id: roomId, ...row };
  }

  /**
   * The configured authorizer, remembering why a `FORBIDDEN` was thrown so that a command
   * which fails because of it leaves a `capability.denied` event (T215). A denial a command
   * catches and carries on from (a search skipping unreadable paths) is not recorded.
   */
  authorize: Authorizer = async (principal, action, resource, context) => {
    try {
      await this.authorizer(principal, action, resource, context);
    } catch (error) {
      if (error instanceof CrossoverError && error.code === "FORBIDDEN") {
        this.denials.set(error, denialOf(action, resource, error));
      }
      throw error;
    }
  };
}
