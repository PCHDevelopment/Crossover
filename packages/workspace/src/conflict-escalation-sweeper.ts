import type { Pool } from "@crossover/db";
import type { Dispatcher } from "@crossover/kernel";
import { escalateOpenConflict } from "./conflict-actions.js";

const AGENT_ESCALATION_MS = 10 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 60_000;

interface Candidate {
  conflict_id: string;
  room_id: string;
}

interface LockedConflict extends Candidate {
  id: string;
  status: string;
  changeset_id: string;
  submitter_id: string;
  attempts: number;
  created_at: Date;
  submitter_kind: string;
  submitter_status: string;
  owner_id: string;
  lead_participant_id: string | null;
}

export interface ConflictEscalationSweeperOptions {
  pool: Pool;
  dispatcher: Dispatcher;
  /** Injected for deterministic timeout checks. */
  now?: () => Date;
  /** Override the lease-holder room set in tests; production uses Dispatcher.leases.heldRooms(). */
  rooms?: readonly string[];
  intervalMs?: number;
  onError?: (error: unknown, conflictId?: string) => void;
}

/** Dispatch the timeout escalation for every active agent submitter past its 10-minute window. */
export async function sweepConflictEscalations(
  pool: Pool,
  dispatcher: Dispatcher,
  now: Date,
  options: Pick<ConflictEscalationSweeperOptions, "onError" | "rooms"> = {},
): Promise<number> {
  if (!Number.isFinite(now.getTime())) throw new TypeError("Sweep clock must return a valid Date");
  const cutoff = new Date(now.getTime() - AGENT_ESCALATION_MS);
  const rooms = options.rooms ?? dispatcher.leases.heldRooms();
  const onError =
    options.onError ??
    ((error: unknown, conflictId?: string) =>
      console.error(
        `conflict escalation sweep failed${conflictId ? ` for ${conflictId}` : ""}`,
        error,
      ));
  const { rows } = await pool.query<Candidate>(
    `SELECT c.id AS conflict_id, c.room_id
     FROM conflicts c
     JOIN participants p ON p.id = c.submitter_id AND p.room_id = c.room_id
     WHERE c.status = 'OPEN' AND p.kind = 'AGENT' AND p.status <> 'REMOVED'
       AND c.created_at <= $1 AND c.room_id = ANY($2::text[])
     ORDER BY c.created_at, c.id
     LIMIT 100`,
    [cutoff, rooms],
  );
  const results = await Promise.all(
    rows.map(async (candidate) => {
      try {
        const result = await dispatcher.runSystem(
          candidate.room_id,
          "conflicts.escalate.timeout",
          async ({ client, room_id }) => {
            const { rows: lockedRows } = await client.query<LockedConflict>(
              `SELECT c.id, c.id AS conflict_id, c.room_id, c.status, c.changeset_id,
                      c.submitter_id, c.attempts, c.created_at,
                      p.kind AS submitter_kind, p.status AS submitter_status,
                      r.owner_id, r.lead_participant_id
               FROM conflicts c
               JOIN participants p ON p.id = c.submitter_id AND p.room_id = c.room_id
               JOIN rooms r ON r.id = c.room_id
               WHERE c.id = $1 AND c.room_id = $2
               FOR UPDATE OF c`,
              [candidate.conflict_id, room_id],
            );
            const conflict = lockedRows[0];
            if (
              !conflict ||
              conflict.status !== "OPEN" ||
              conflict.submitter_kind !== "AGENT" ||
              conflict.submitter_status === "REMOVED" ||
              conflict.created_at.getTime() > cutoff.getTime()
            )
              return { result: 0, events: [] };
            const event = await escalateOpenConflict(client, room_id, conflict, "timeout");
            return {
              result: event ? 1 : 0,
              events: event ? [{ ...event, actor_id: "system" }] : [],
            };
          },
        );
        return result.result;
      } catch (error) {
        onError(error, candidate.conflict_id);
        return 0;
      }
    }),
  );
  return results.reduce<number>((sum, count) => sum + count, 0);
}

/** Periodic, non-overlapping timeout scanner for agent-submitted conflicts. */
export class ConflictEscalationSweeper {
  private readonly pool: Pool;
  private readonly dispatcher: Dispatcher;
  private readonly now: () => Date;
  private readonly rooms: readonly string[] | undefined;
  private readonly intervalMs: number;
  private readonly onError: NonNullable<ConflictEscalationSweeperOptions["onError"]>;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<number> | undefined;

  constructor(options: ConflictEscalationSweeperOptions) {
    this.pool = options.pool;
    this.dispatcher = options.dispatcher;
    this.now = options.now ?? (() => new Date());
    this.rooms = options.rooms;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    if (!Number.isSafeInteger(this.intervalMs) || this.intervalMs < 1)
      throw new RangeError("Conflict escalation interval must be a positive safe integer");
    this.onError =
      options.onError ??
      ((error, conflictId) =>
        console.error(
          `conflict escalation sweep failed${conflictId ? ` for ${conflictId}` : ""}`,
          error,
        ));
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) => this.onError(error));
    }, this.intervalMs);
    this.timer.unref();
  }

  tick(): Promise<number> {
    this.running ??= sweepConflictEscalations(this.pool, this.dispatcher, this.now(), {
      onError: this.onError,
      ...(this.rooms ? { rooms: this.rooms } : {}),
    }).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }
}
