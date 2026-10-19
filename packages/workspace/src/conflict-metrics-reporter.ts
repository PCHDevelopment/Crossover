import type { Pool } from "@crossover/db";
import { conflictRateReport } from "./conflict-metrics.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_TICK_MS = 60_000;
const MAX_TIMER_MS = 2_147_483_647;
const LOCK = "crossover.conflict_rate_report";

export interface ConflictMetricsReporterOptions {
  pool: Pool;
  /** Time between reports; default one day. */
  intervalMs?: number;
  /** How far back each report looks; default seven days. */
  windowMs?: number;
  now?: () => Date;
  write?: (line: string) => void;
  onError?: (error: unknown) => void;
}

/** Periodically writes the conflict-rate report (T1586) as one JSON line on stdout. */
export class ConflictMetricsReporter {
  private readonly intervalMs: number;
  private readonly windowMs: number;
  private readonly now: () => Date;
  private readonly write: (line: string) => void;
  private readonly onError: (error: unknown) => void;
  private first: ReturnType<typeof setTimeout> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<boolean> | undefined;

  constructor(private readonly options: ConflictMetricsReporterOptions) {
    this.intervalMs = options.intervalMs ?? DAY_MS;
    this.windowMs = options.windowMs ?? 7 * DAY_MS;
    // Node timers cap at 2^31-1 ms; a longer delay would fire every millisecond.
    if (
      !Number.isSafeInteger(this.intervalMs) ||
      this.intervalMs < 1 ||
      this.intervalMs > MAX_TIMER_MS
    )
      throw new RangeError("Conflict report interval must be between 1 and 2147483647 ms");
    this.now = options.now ?? (() => new Date());
    this.write = options.write ?? ((line) => void process.stdout.write(line));
    this.onError =
      options.onError ?? ((error) => console.error("conflict rate report failed", error));
  }

  /** The first report comes 60 s after this, then one per interval. */
  start(): void {
    if (this.first || this.timer) return;
    const run = () => void this.tick().catch((error: unknown) => this.onError(error));
    this.first = setTimeout(() => {
      this.first = undefined;
      run();
      this.timer = setInterval(run, this.intervalMs);
      this.timer.unref();
    }, FIRST_TICK_MS);
    this.first.unref();
  }

  /** Write one report unless another server holds the lock; true when a line was written. */
  tick(): Promise<boolean> {
    this.running ??= this.report().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  async stop(): Promise<void> {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
    this.first = undefined;
    this.timer = undefined;
    await this.running?.catch(() => undefined);
  }

  private async report(): Promise<boolean> {
    const client = await this.options.pool.connect();
    try {
      const { rows } = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
        [LOCK],
      );
      if (!rows[0]?.locked) return false;
      try {
        const until = this.now();
        const since = new Date(until.getTime() - this.windowMs);
        const report = await conflictRateReport(this.options.pool, { since, until });
        this.write(`${JSON.stringify({ msg: "conflict_rate_report", ...report })}\n`);
        return true;
      } finally {
        await client.query("SELECT pg_advisory_unlock(hashtext($1))", [LOCK]);
      }
    } finally {
      client.release();
    }
  }
}
