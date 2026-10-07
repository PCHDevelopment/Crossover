import type { Pool } from "@crossover/db";
import { withTransaction } from "@crossover/db";
import { CrossoverError, newId } from "@crossover/protocol";

const SANDBOX_IDLE_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;
const SWEEP_BATCH_SIZE = 100;

export type SandboxStatus = "CREATING" | "RUNNING" | "HIBERNATED" | "DESTROYED";

export interface SandboxRecord {
  id: string;
  room_id: string;
  participant_id: string;
  status: SandboxStatus;
  base_revision: number | null;
  volume_ref: string | null;
  container_ref: string | null;
  last_active_at: Date;
}

export interface SandboxResources {
  volume_ref: string;
  container_ref: string;
}

export interface ExecutionDriver {
  create(input: {
    sandbox_id: string;
    room_id: string;
    participant_id: string;
  }): Promise<SandboxResources>;
  start(resources: SandboxResources): Promise<void>;
  stop(resources: SandboxResources): Promise<void>;
  destroy(resources: SandboxResources): Promise<void>;
}

interface SandboxRow extends SandboxRecord {
  volume_ref: string | null;
  container_ref: string | null;
}

export interface ExecutionServiceOptions {
  idleMs?: number;
  sweepIntervalMs?: number;
}

/** Persists per-participant sandbox ownership and manages its container lifecycle. */
export class ExecutionService {
  private readonly idleMs: number;
  private readonly sweepIntervalMs: number;
  private sweepTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly pool: Pool,
    private readonly driver: ExecutionDriver,
    options: ExecutionServiceOptions = {},
  ) {
    this.idleMs = options.idleMs ?? SANDBOX_IDLE_MS;
    this.sweepIntervalMs = options.sweepIntervalMs ?? SWEEP_INTERVAL_MS;
  }

  /** Create lazily, or resume, the one sandbox owned by this room participant. */
  async ensure(roomId: string, participantId: string): Promise<SandboxRecord> {
    return withTransaction(this.pool, async (client) => {
      const participant = await client.query<{ status: string; room_status: string }>(
        `SELECT p.status, r.status AS room_status FROM participants p
         JOIN rooms r ON r.id = p.room_id
         WHERE p.room_id = $1 AND p.id = $2`,
        [roomId, participantId],
      );
      if (participant.rows[0]?.status !== "ACTIVE" || participant.rows[0]?.room_status !== "ACTIVE")
        throw new CrossoverError("NOT_FOUND", "Active sandbox participant not found");

      await client.query(
        `INSERT INTO sandboxes (id, room_id, participant_id, status)
         VALUES ($1, $2, $3, 'CREATING')
         ON CONFLICT (room_id, participant_id) DO NOTHING`,
        [newId("sandbox"), roomId, participantId],
      );
      const selected = await client.query<SandboxRow>(
        `SELECT id, room_id, participant_id, status, base_revision, volume_ref, container_ref,
                last_active_at
         FROM sandboxes WHERE room_id = $1 AND participant_id = $2 FOR UPDATE`,
        [roomId, participantId],
      );
      const sandbox = selected.rows[0];
      if (!sandbox || sandbox.status === "DESTROYED")
        throw new CrossoverError("NOT_FOUND", "Participant sandbox has been destroyed");

      let resources: SandboxResources;
      if (sandbox.status === "CREATING") {
        resources = await this.driver.create({
          sandbox_id: sandbox.id,
          room_id: roomId,
          participant_id: participantId,
        });
      } else {
        if (!sandbox.volume_ref || !sandbox.container_ref)
          throw new Error(`Sandbox ${sandbox.id} is missing its driver references`);
        resources = {
          volume_ref: sandbox.volume_ref,
          container_ref: sandbox.container_ref,
        };
        if (sandbox.status === "HIBERNATED") await this.driver.start(resources);
      }
      const updated = await client.query<SandboxRow>(
        `UPDATE sandboxes SET status = 'RUNNING', volume_ref = $3, container_ref = $4,
                              last_active_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE id = $1 AND room_id = $2
         RETURNING id, room_id, participant_id, status, base_revision, volume_ref, container_ref,
                   last_active_at`,
        [sandbox.id, roomId, resources.volume_ref, resources.container_ref],
      );
      return updated.rows[0]!;
    });
  }

  /** Look up only by the caller's room and participant identity, never by another sandbox ID. */
  async get(roomId: string, participantId: string): Promise<SandboxRecord | null> {
    const { rows } = await this.pool.query<SandboxRow>(
      `SELECT id, room_id, participant_id, status, base_revision, volume_ref, container_ref,
              last_active_at
       FROM sandboxes WHERE room_id = $1 AND participant_id = $2`,
      [roomId, participantId],
    );
    return rows[0] ?? null;
  }

  /** Hibernate idle sandboxes; the container stops while its Docker volume is retained. */
  async sweepIdle(now = new Date()): Promise<number> {
    const { rows } = await this.pool.query<Pick<SandboxRow, "room_id" | "participant_id">>(
      `SELECT room_id, participant_id FROM sandboxes
       WHERE status = 'RUNNING' AND last_active_at <= $1
       ORDER BY last_active_at LIMIT $2`,
      [new Date(now.getTime() - this.idleMs), SWEEP_BATCH_SIZE],
    );
    let hibernated = 0;
    for (const row of rows)
      if (await this.hibernateOne(row.room_id, row.participant_id, now)) hibernated++;
    return hibernated;
  }

  /** Stop every sandbox in a room, optionally limiting the operation to agents (§5). */
  async hibernateRoom(roomId: string, agentsOnly = false): Promise<void> {
    const { rows } = await this.pool.query<Pick<SandboxRow, "participant_id">>(
      `SELECT s.participant_id FROM sandboxes s
       JOIN participants p ON p.id = s.participant_id AND p.room_id = s.room_id
       WHERE s.room_id = $1 AND s.status = 'RUNNING' AND ($2 = false OR p.kind = 'AGENT')`,
      [roomId, agentsOnly],
    );
    for (const row of rows) await this.hibernateOne(roomId, row.participant_id);
  }

  async destroyParticipant(roomId: string, participantId: string): Promise<void> {
    await this.destroyOne(roomId, participantId);
  }

  async destroyRoom(roomId: string): Promise<void> {
    const { rows } = await this.pool.query<Pick<SandboxRow, "participant_id">>(
      "SELECT participant_id FROM sandboxes WHERE room_id = $1 AND status <> 'DESTROYED'",
      [roomId],
    );
    for (const row of rows) await this.destroyOne(roomId, row.participant_id);
  }

  startSweeper(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      void this.sweepIdle().catch((error: unknown) =>
        console.error("[execution] idle sandbox sweep failed", error),
      );
    }, this.sweepIntervalMs);
    this.sweepTimer.unref();
  }

  async close(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
  }

  private async hibernateOne(
    roomId: string,
    participantId: string,
    idleAtOrBefore?: Date,
  ): Promise<boolean> {
    return withTransaction(this.pool, async (client) => {
      const { rows } = await client.query<SandboxRow>(
        `SELECT id, room_id, participant_id, status, base_revision, volume_ref, container_ref,
                last_active_at
         FROM sandboxes WHERE room_id = $1 AND participant_id = $2 FOR UPDATE`,
        [roomId, participantId],
      );
      const sandbox = rows[0];
      if (!sandbox || sandbox.status !== "RUNNING") return false;
      if (idleAtOrBefore && sandbox.last_active_at > idleAtOrBefore) return false;
      const resources = this.resources(sandbox);
      await this.driver.stop(resources);
      await client.query(
        `UPDATE sandboxes SET status = 'HIBERNATED', updated_at = clock_timestamp()
         WHERE id = $1 AND room_id = $2`,
        [sandbox.id, roomId],
      );
      return true;
    });
  }

  private async destroyOne(roomId: string, participantId: string): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const { rows } = await client.query<SandboxRow>(
        `SELECT id, room_id, participant_id, status, base_revision, volume_ref, container_ref,
                last_active_at
         FROM sandboxes WHERE room_id = $1 AND participant_id = $2 FOR UPDATE`,
        [roomId, participantId],
      );
      const sandbox = rows[0];
      if (!sandbox || sandbox.status === "DESTROYED") return;
      if (sandbox.status !== "CREATING") await this.driver.destroy(this.resources(sandbox));
      await client.query(
        `UPDATE sandboxes SET status = 'DESTROYED', volume_ref = NULL, container_ref = NULL,
                              updated_at = clock_timestamp()
         WHERE id = $1 AND room_id = $2`,
        [sandbox.id, roomId],
      );
    });
  }

  private resources(sandbox: SandboxRow): SandboxResources {
    if (!sandbox.volume_ref || !sandbox.container_ref)
      throw new Error(`Sandbox ${sandbox.id} is missing its driver references`);
    return { volume_ref: sandbox.volume_ref, container_ref: sandbox.container_ref };
  }
}
