import type { Pool } from "@crossover/db";
import type { SandboxComputeBudgetMeter } from "./sandbox-compute-budget.js";
import type { SandboxCpuUsage, SandboxRecord } from "./execution.js";

const SWEEP_BATCH_SIZE = 100;

interface ComputeSweepRow extends Omit<SandboxRecord, "base_revision"> {
  base_revision: number | string | null;
}

export interface SandboxComputeSweeperOptions {
  pool: Pool;
  meter: SandboxComputeBudgetMeter;
  readCpuUsage?: ((sandbox: SandboxRecord) => Promise<SandboxCpuUsage>) | undefined;
  hibernate: (roomId: string, participantId: string) => Promise<boolean>;
  now: () => Date;
}

/** Samples running sandboxes and retires owners that have reached a daily CPU limit. */
export class SandboxComputeSweeper {
  private cursor: string | undefined;

  constructor(private readonly options: SandboxComputeSweeperOptions) {}

  async sample(sandbox: SandboxRecord, sampledAt = this.options.now()): Promise<bigint> {
    if (!this.options.readCpuUsage || !sandbox.container_ref || !sandbox.volume_ref) return 0n;
    const usage = await this.options.readCpuUsage(sandbox);
    return this.options.meter.sample({
      room_id: sandbox.room_id,
      participant_id: sandbox.participant_id,
      sandbox_id: sandbox.id,
      usage_usec: usage.usage_usec,
      generation: usage.generation,
      sampled_at: sampledAt,
    });
  }

  /** Sample running containers and retire abandoned reservations on the shared UTC budget day. */
  async sweep(now = this.options.now()): Promise<number> {
    const loadBatch = (afterId?: string) =>
      this.options.pool.query<ComputeSweepRow>(
        `SELECT s.id, s.room_id, s.participant_id, s.status, s.limits, s.base_revision,
                s.volume_ref, s.container_ref, s.last_active_at, s.updated_at
           FROM sandboxes s
          WHERE s.status = 'RUNNING' AND s.container_ref IS NOT NULL
            AND ($2::text IS NULL OR s.id > $2)
          ORDER BY s.id LIMIT $1`,
        [SWEEP_BATCH_SIZE, afterId ?? null],
      );
    let { rows } = await loadBatch(this.cursor);
    if (rows.length === 0 && this.cursor !== undefined) {
      this.cursor = undefined;
      rows = (await loadBatch()).rows;
    }
    if (rows.length > 0) this.cursor = rows[rows.length - 1]!.id;
    let sampled = 0;
    for (const row of rows) {
      const sandbox: SandboxRecord = {
        ...row,
        base_revision: row.base_revision === null ? null : Number(row.base_revision),
      };
      try {
        await this.sample(sandbox, now);
        sampled++;
        if (await this.options.meter.isLimitReached(sandbox, now))
          await this.options.hibernate(sandbox.room_id, sandbox.participant_id);
      } catch (error) {
        console.error("[execution] sandbox CPU sweep failed", {
          room_id: sandbox.room_id,
          participant_id: sandbox.participant_id,
          sandbox_id: sandbox.id,
          error,
        });
      }
    }
    try {
      await this.options.meter.sweepExpired(now);
    } catch (error) {
      console.error("[execution] sandbox CPU reservation sweep failed", error);
    }
    return sampled;
  }
}
