import type { Pool } from "@crossover/db";
import { newId } from "@crossover/protocol";
import type { Dispatcher, Principal } from "@crossover/kernel";

const AGENT_ESCALATION_MS = 10 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 60_000;

interface Candidate {
  conflict_id: string;
  room_id: string;
  participant_id: string;
  kind: Principal["kind"];
  authority: Principal["authority"];
  role: Principal["role"];
}

export interface ConflictEscalationSweeperOptions {
  pool: Pool;
  dispatcher: Dispatcher;
  /** Injected for deterministic timeout checks. */
  now?: () => Date;
  intervalMs?: number;
  onError?: (error: unknown, conflictId?: string) => void;
}

/** Dispatch the timeout escalation for every active agent submitter past its 10-minute window. */
export async function sweepConflictEscalations(
  pool: Pool,
  dispatcher: Dispatcher,
  now: Date,
  onError: ConflictEscalationSweeperOptions["onError"] = (error, conflictId) =>
    console.error(
      `conflict escalation sweep failed${conflictId ? ` for ${conflictId}` : ""}`,
      error,
    ),
): Promise<number> {
  if (!Number.isFinite(now.getTime())) throw new TypeError("Sweep clock must return a valid Date");
  const cutoff = new Date(now.getTime() - AGENT_ESCALATION_MS);
  const { rows } = await pool.query<Candidate>(
    `SELECT c.id AS conflict_id, c.room_id, p.id AS participant_id,
            p.kind, p.authority, p.role
     FROM conflicts c
     JOIN participants p ON p.id = c.submitter_id AND p.room_id = c.room_id
     WHERE c.status = 'OPEN' AND p.kind = 'AGENT' AND p.status = 'ACTIVE'
       AND c.created_at <= $1
     ORDER BY c.created_at, c.id
     LIMIT 100`,
    [cutoff],
  );
  const results = await Promise.all(
    rows.map(async (candidate) => {
      try {
        const result = await dispatcher.dispatch(
          {
            room_id: candidate.room_id,
            participant_id: candidate.participant_id,
            kind: candidate.kind,
            authority: candidate.authority,
            role: candidate.role,
          },
          {
            id: newId("cmd"),
            idempotency_key: newId("cmd"),
            method: "conflicts.escalate",
            params: { conflict_id: candidate.conflict_id },
          },
        );
        return (result.response as { status?: string }).status === "ESCALATED" ? 1 : 0;
      } catch (error) {
        onError?.(error, candidate.conflict_id);
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
  private readonly intervalMs: number;
  private readonly onError: NonNullable<ConflictEscalationSweeperOptions["onError"]>;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<number> | undefined;

  constructor(options: ConflictEscalationSweeperOptions) {
    this.pool = options.pool;
    this.dispatcher = options.dispatcher;
    this.now = options.now ?? (() => new Date());
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
    this.running ??= sweepConflictEscalations(
      this.pool,
      this.dispatcher,
      this.now(),
      this.onError,
    ).finally(() => {
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
