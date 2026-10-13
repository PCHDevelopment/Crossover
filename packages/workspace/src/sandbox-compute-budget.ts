import { withTransaction, type Pool, type PoolClient } from "@crossover/db";
import { computeLimitFor, readComputeOverrides } from "@crossover/kernel";
import { CrossoverError } from "@crossover/protocol";

const USEC_PER_CPU_SECOND = 1_000_000n;
const USEC_PER_VCPU_HOUR = 3_600n * USEC_PER_CPU_SECOND;
const RESERVATION_GRACE_MS = 60_000;
const EXPIRED_BATCH_SIZE = 100;

export interface SandboxComputeIdentity {
  room_id: string;
  participant_id: string;
  sandbox_id: string;
}

export interface SandboxComputeSample extends SandboxComputeIdentity {
  usage_usec: bigint;
  generation: string;
  sampled_at: Date;
}

interface ReservationRow extends SandboxComputeIdentity {
  exec_id: string;
  usage_date: string;
  remaining_cpu_usec: string;
}

interface UsageRow {
  used_cpu_usec: string;
  reserved_cpu_usec: string;
}

/** Durable daily CPU usage plus worst-case reservations shared by all server nodes. */
export class SandboxComputeBudgetMeter {
  constructor(
    private readonly pool: Pool,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Reserve the maximum CPU this exec can consume and return its CPU-budget-capped timeout. */
  async reserve(
    input: SandboxComputeIdentity & {
      exec_id: string;
      requested_timeout_ms: number;
      vcpus: number;
    },
  ): Promise<number> {
    if (
      !Number.isSafeInteger(input.requested_timeout_ms) ||
      input.requested_timeout_ms < 1 ||
      !Number.isSafeInteger(input.vcpus) ||
      input.vcpus < 1
    )
      throw new Error("Invalid sandbox CPU reservation bounds");

    const now = this.now();
    const usageDate = utcDate(now);
    return withTransaction(this.pool, async (client) => {
      const { rows: rooms } = await client.query<{
        settings: unknown;
        participant_budgets: unknown;
      }>(
        `SELECT r.settings, p.budgets AS participant_budgets
           FROM rooms r
           JOIN participants p ON p.room_id = r.id AND p.id = $2
          WHERE r.id = $1`,
        [input.room_id, input.participant_id],
      );
      const room = rooms[0];
      if (!room) throw new CrossoverError("NOT_FOUND", "Room not found");
      await this.releaseExpired(client, now, input.room_id, usageDate);
      await ensureUsageRows(client, input.room_id, input.participant_id, usageDate);
      const { room: roomUsage, agent: agentUsage } = await lockUsageRows(
        client,
        input.room_id,
        input.participant_id,
        usageDate,
      );

      const computeBudgets = readComputeOverrides(asRecord(room.settings)?.["compute_budgets"]);
      const participantComputeBudgets = readComputeOverrides(room.participant_budgets);
      const roomLimit = computeLimitFor("room_vcpu_hours_per_day", computeBudgets);
      const agentLimit = computeLimitFor(
        "agent_vcpu_hours_per_day",
        computeBudgets,
        participantComputeBudgets,
      );
      const roomRemaining = remaining(roomUsage, roomLimit);
      const agentRemaining = remaining(agentUsage, agentLimit);
      const available = minNullable(roomRemaining, agentRemaining);
      const dayRemainingMs = millisecondsUntilUtcDayEnd(now);
      let timeoutMs = input.requested_timeout_ms;
      if (available !== null) {
        const cpuTimeoutMs = available / (BigInt(input.vcpus) * 1_000n);
        timeoutMs = Math.min(timeoutMs, Number(cpuTimeoutMs));
      }
      timeoutMs = Math.floor(timeoutMs / 1_000) * 1_000;
      if (timeoutMs < 1_000) {
        const exhaustedScope =
          agentRemaining !== null && agentRemaining <= (roomRemaining ?? agentRemaining)
            ? "agent"
            : "room";
        throw new CrossoverError("BUDGET_EXCEEDED", "Sandbox compute budget is exhausted", {
          details: {
            budget: "sandbox_compute",
            scope: exhaustedScope,
            retry_after: Math.ceil(dayRemainingMs / 1_000),
          },
        });
      }

      const reservedCpuUsec = BigInt(timeoutMs) * BigInt(input.vcpus) * 1_000n;
      await client.query(
        `UPDATE sandbox_compute_room_daily
            SET reserved_cpu_usec = reserved_cpu_usec + $3::bigint
          WHERE room_id = $1 AND usage_date = $2::date`,
        [input.room_id, usageDate, reservedCpuUsec.toString()],
      );
      await client.query(
        `UPDATE sandbox_compute_agent_daily
            SET reserved_cpu_usec = reserved_cpu_usec + $4::bigint
          WHERE room_id = $1 AND participant_id = $2 AND usage_date = $3::date`,
        [input.room_id, input.participant_id, usageDate, reservedCpuUsec.toString()],
      );
      await client.query(
        `INSERT INTO sandbox_compute_reservations
           (exec_id, room_id, participant_id, sandbox_id, usage_date, remaining_cpu_usec, expires_at)
         VALUES ($1, $2, $3, $4, $5::date, $6::bigint, $7)`,
        [
          input.exec_id,
          input.room_id,
          input.participant_id,
          input.sandbox_id,
          usageDate,
          reservedCpuUsec.toString(),
          new Date(now.getTime() + timeoutMs + RESERVATION_GRACE_MS),
        ],
      );
      return timeoutMs;
    });
  }

  /** Charge the monotonic cgroup counter delta once, even when several nodes sample concurrently. */
  async sample(input: SandboxComputeSample): Promise<bigint> {
    if (input.usage_usec < 0n || input.generation.length === 0)
      throw new Error("Invalid sandbox cgroup CPU sample");
    const usageDate = utcDate(input.sampled_at);
    return withTransaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO sandbox_compute_samples (sandbox_id, last_usage_usec, generation, sampled_at)
         VALUES ($1, $2::bigint, $3, $4)
         ON CONFLICT (sandbox_id) DO NOTHING`,
        [input.sandbox_id, input.usage_usec.toString(), input.generation, input.sampled_at],
      );
      const { rows } = await client.query<{
        last_usage_usec: string;
        generation: string;
        sampled_at: Date;
      }>(
        `SELECT last_usage_usec, generation, sampled_at
           FROM sandbox_compute_samples WHERE sandbox_id = $1 FOR UPDATE`,
        [input.sandbox_id],
      );
      const previous = rows[0];
      if (!previous) throw new Error("Sandbox CPU sample row disappeared");
      if (input.sampled_at < previous.sampled_at) return 0n;

      const lastUsec = BigInt(previous.last_usage_usec);
      if (input.generation === previous.generation && input.usage_usec < lastUsec) return 0n;
      const delta =
        input.generation !== previous.generation ? input.usage_usec : input.usage_usec - lastUsec;
      await client.query(
        `UPDATE sandbox_compute_samples
            SET last_usage_usec = $2::bigint, generation = $3, sampled_at = $4
          WHERE sandbox_id = $1`,
        [input.sandbox_id, input.usage_usec.toString(), input.generation, input.sampled_at],
      );
      if (delta === 0n) return delta;

      await ensureUsageRows(client, input.room_id, input.participant_id, usageDate);
      await lockUsageRows(client, input.room_id, input.participant_id, usageDate);
      const reservations = await client.query<{
        exec_id: string;
        remaining_cpu_usec: string;
      }>(
        `SELECT exec_id, remaining_cpu_usec
           FROM sandbox_compute_reservations
          WHERE sandbox_id = $1 AND usage_date = $2::date AND remaining_cpu_usec > 0
          ORDER BY created_at, exec_id
          FOR UPDATE`,
        [input.sandbox_id, usageDate],
      );
      let chargeAgainstReservations = delta;
      let released = 0n;
      for (const reservation of reservations.rows) {
        if (chargeAgainstReservations === 0n) break;
        const remainingUsec = BigInt(reservation.remaining_cpu_usec);
        const consumed =
          remainingUsec < chargeAgainstReservations ? remainingUsec : chargeAgainstReservations;
        await client.query(
          `UPDATE sandbox_compute_reservations
              SET remaining_cpu_usec = remaining_cpu_usec - $2::bigint
            WHERE exec_id = $1`,
          [reservation.exec_id, consumed.toString()],
        );
        released += consumed;
        chargeAgainstReservations -= consumed;
      }
      await client.query(
        `UPDATE sandbox_compute_room_daily
            SET used_cpu_usec = used_cpu_usec + $3::bigint,
                reserved_cpu_usec = GREATEST(0, reserved_cpu_usec - $4::bigint)
          WHERE room_id = $1 AND usage_date = $2::date`,
        [input.room_id, usageDate, delta.toString(), released.toString()],
      );
      await client.query(
        `UPDATE sandbox_compute_agent_daily
            SET used_cpu_usec = used_cpu_usec + $4::bigint,
                reserved_cpu_usec = GREATEST(0, reserved_cpu_usec - $5::bigint)
          WHERE room_id = $1 AND participant_id = $2 AND usage_date = $3::date`,
        [input.room_id, input.participant_id, usageDate, delta.toString(), released.toString()],
      );
      return delta;
    });
  }

  /** Whether measured use has reached either configured daily cap for this sandbox owner. */
  async isLimitReached(
    identity: Pick<SandboxComputeIdentity, "room_id" | "participant_id">,
    at = this.now(),
  ): Promise<boolean> {
    const { rows } = await this.pool.query<{
      settings: unknown;
      participant_budgets: unknown;
      room_used_cpu_usec: string;
      agent_used_cpu_usec: string;
    }>(
      `SELECT r.settings, p.budgets AS participant_budgets,
              COALESCE(rd.used_cpu_usec, 0)::text AS room_used_cpu_usec,
              COALESCE(ad.used_cpu_usec, 0)::text AS agent_used_cpu_usec
         FROM rooms r
         JOIN participants p ON p.id = $2 AND p.room_id = r.id
         LEFT JOIN sandbox_compute_room_daily rd
           ON rd.room_id = r.id AND rd.usage_date = $3::date
         LEFT JOIN sandbox_compute_agent_daily ad
           ON ad.room_id = r.id AND ad.participant_id = $2 AND ad.usage_date = $3::date
        WHERE r.id = $1`,
      [identity.room_id, identity.participant_id, utcDate(at)],
    );
    const row = rows[0];
    if (!row) throw new CrossoverError("NOT_FOUND", "Room not found");
    const overrides = readComputeOverrides(asRecord(row.settings)?.["compute_budgets"]);
    const participantOverrides = readComputeOverrides(row.participant_budgets);
    const roomLimit = computeLimitFor("room_vcpu_hours_per_day", overrides);
    const agentLimit = computeLimitFor("agent_vcpu_hours_per_day", overrides, participantOverrides);
    return (
      (roomLimit !== null &&
        BigInt(row.room_used_cpu_usec) >= BigInt(roomLimit) * USEC_PER_VCPU_HOUR) ||
      (agentLimit !== null &&
        BigInt(row.agent_used_cpu_usec) >= BigInt(agentLimit) * USEC_PER_VCPU_HOUR)
    );
  }

  /** Release unused capacity after exec completion, rollback, or start failure. */
  async release(execId: string): Promise<bigint> {
    return withTransaction(this.pool, async (client) => this.releaseOne(client, execId));
  }

  /** Expire abandoned reservations so a server crash cannot hold daily capacity forever. */
  async sweepExpired(now = this.now()): Promise<number> {
    const { rows } = await this.pool.query<{ exec_id: string }>(
      `SELECT exec_id FROM sandbox_compute_reservations
        WHERE expires_at <= $1
        ORDER BY expires_at, exec_id LIMIT $2`,
      [now, EXPIRED_BATCH_SIZE],
    );
    let removed = 0;
    for (const row of rows) if ((await this.release(row.exec_id)) > 0n) removed++;
    return removed;
  }

  private async releaseExpired(
    client: PoolClient,
    now: Date,
    roomId: string,
    usageDate: string,
  ): Promise<void> {
    const { rows } = await client.query<{ exec_id: string }>(
      `SELECT exec_id FROM sandbox_compute_reservations
        WHERE room_id = $1 AND usage_date = $2::date AND expires_at <= $3
        ORDER BY expires_at, exec_id`,
      [roomId, usageDate, now],
    );
    for (const row of rows) await this.releaseOne(client, row.exec_id);
  }

  private async releaseOne(client: PoolClient, execId: string): Promise<bigint> {
    const { rows } = await client.query<ReservationRow>(
      `SELECT exec_id, room_id, participant_id, sandbox_id, usage_date,
              remaining_cpu_usec::text
         FROM sandbox_compute_reservations WHERE exec_id = $1`,
      [execId],
    );
    const reservation = rows[0];
    if (!reservation) return 0n;

    await ensureUsageRows(
      client,
      reservation.room_id,
      reservation.participant_id,
      reservation.usage_date,
    );
    await lockUsageRows(
      client,
      reservation.room_id,
      reservation.participant_id,
      reservation.usage_date,
    );
    const deleted = await client.query<{ remaining_cpu_usec: string }>(
      `DELETE FROM sandbox_compute_reservations WHERE exec_id = $1
       RETURNING remaining_cpu_usec::text`,
      [execId],
    );
    if (!deleted.rows[0]) return 0n;
    const remainingUsec = BigInt(deleted.rows[0].remaining_cpu_usec);
    await client.query(
      `UPDATE sandbox_compute_room_daily
          SET reserved_cpu_usec = GREATEST(0, reserved_cpu_usec - $3::bigint)
        WHERE room_id = $1 AND usage_date = $2::date`,
      [reservation.room_id, reservation.usage_date, remainingUsec.toString()],
    );
    await client.query(
      `UPDATE sandbox_compute_agent_daily
          SET reserved_cpu_usec = GREATEST(0, reserved_cpu_usec - $4::bigint)
        WHERE room_id = $1 AND participant_id = $2 AND usage_date = $3::date`,
      [
        reservation.room_id,
        reservation.participant_id,
        reservation.usage_date,
        remainingUsec.toString(),
      ],
    );
    return remainingUsec;
  }
}

function remaining(row: UsageRow, limitHours: number | null): bigint | null {
  if (limitHours === null) return null;
  const limitUsec = BigInt(limitHours) * USEC_PER_VCPU_HOUR;
  const remainingUsec = limitUsec - BigInt(row.used_cpu_usec) - BigInt(row.reserved_cpu_usec);
  return remainingUsec > 0n ? remainingUsec : 0n;
}

function minNullable(left: bigint | null, right: bigint | null): bigint | null {
  if (left === null) return right;
  if (right === null) return left;
  return left < right ? left : right;
}

async function ensureUsageRows(
  client: PoolClient,
  roomId: string,
  participantId: string,
  usageDate: string,
): Promise<void> {
  await client.query(
    `INSERT INTO sandbox_compute_room_daily (room_id, usage_date) VALUES ($1, $2::date)
     ON CONFLICT DO NOTHING`,
    [roomId, usageDate],
  );
  await client.query(
    `INSERT INTO sandbox_compute_agent_daily (room_id, participant_id, usage_date)
     VALUES ($1, $2, $3::date) ON CONFLICT DO NOTHING`,
    [roomId, participantId, usageDate],
  );
}

async function lockUsageRows(
  client: PoolClient,
  roomId: string,
  participantId: string,
  usageDate: string,
): Promise<{ room: UsageRow; agent: UsageRow }> {
  const { rows: roomRows } = await client.query<UsageRow>(
    `SELECT used_cpu_usec::text, reserved_cpu_usec::text
       FROM sandbox_compute_room_daily WHERE room_id = $1 AND usage_date = $2::date FOR UPDATE`,
    [roomId, usageDate],
  );
  const { rows: agentRows } = await client.query<UsageRow>(
    `SELECT used_cpu_usec::text, reserved_cpu_usec::text
       FROM sandbox_compute_agent_daily
      WHERE room_id = $1 AND participant_id = $2 AND usage_date = $3::date FOR UPDATE`,
    [roomId, participantId, usageDate],
  );
  if (!roomRows[0] || !agentRows[0]) throw new Error("Sandbox CPU usage rows are unavailable");
  return { room: roomRows[0], agent: agentRows[0] };
}

function utcDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function millisecondsUntilUtcDayEnd(now: Date): number {
  const nextDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(0, nextDay - now.getTime());
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
