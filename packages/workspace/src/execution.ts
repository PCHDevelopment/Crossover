import type { Pool } from "@crossover/db";
import { withTransaction } from "@crossover/db";
import { CrossoverError, newId } from "@crossover/protocol";

const SANDBOX_IDLE_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;
const SWEEP_BATCH_SIZE = 100;
const HIBERNATION_RECOVERY_MS = 60 * 1000;
const TRANSITION_POLL_MS = 10;

export type SandboxStatus =
  "CREATING" | "STARTING" | "RUNNING" | "HIBERNATING" | "HIBERNATED" | "DESTROYING" | "DESTROYED";
export type DiskEnforcementMode = "hard" | "soft";

export interface SandboxLimits {
  disk_enforcement: DiskEnforcementMode;
}

export interface SandboxRecord {
  id: string;
  room_id: string;
  participant_id: string;
  status: SandboxStatus;
  limits: SandboxLimits;
  base_revision: number | null;
  volume_ref: string | null;
  container_ref: string | null;
  last_active_at: Date;
  updated_at: Date;
}

export interface SandboxResources {
  volume_ref: string;
  container_ref: string;
}

export interface ExecutionDriver {
  /**
   * Every operation is repeatable by sandbox ID: create adopts deterministic existing resources;
   * start and stop converge to their target state; destroy tolerates already-removed resources.
   */
  create(input: {
    sandbox_id: string;
    room_id: string;
    participant_id: string;
    limits: SandboxLimits;
  }): Promise<SandboxResources>;
  start(input: { sandbox_id: string; resources: SandboxResources }): Promise<void>;
  stop(input: { sandbox_id: string; resources: SandboxResources }): Promise<void>;
  destroy(input: { sandbox_id: string; resources?: SandboxResources }): Promise<void>;
}

type SandboxRow = SandboxRecord;

export interface ExecutionServiceOptions {
  idleMs?: number;
  sweepIntervalMs?: number;
  diskEnforcement?: DiskEnforcementMode;
  /** Test seam for a failure after Docker resources exist but before their refs are persisted. */
  afterDriverCreate?: (sandbox: SandboxRecord) => Promise<void>;
}

let softEnforcementWarningLogged = false;

/** Persists per-participant sandbox ownership and manages its container lifecycle. */
export class ExecutionService {
  private readonly idleMs: number;
  private readonly sweepIntervalMs: number;
  private readonly diskEnforcement: DiskEnforcementMode;
  private sweepTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly pool: Pool,
    private readonly driver: ExecutionDriver,
    private readonly options: ExecutionServiceOptions = {},
  ) {
    this.idleMs = options.idleMs ?? SANDBOX_IDLE_MS;
    this.sweepIntervalMs = options.sweepIntervalMs ?? SWEEP_INTERVAL_MS;
    this.diskEnforcement = options.diskEnforcement ?? "soft";
    if (this.diskEnforcement === "soft" && !softEnforcementWarningLogged) {
      console.warn(
        "[execution] SANDBOX_DISK_ENFORCEMENT=soft; Docker quotas are disabled until T1006 adds volume usage checks",
      );
      softEnforcementWarningLogged = true;
    }
  }

  /** Create lazily, or resume, the one sandbox owned by this room participant. */
  async ensure(roomId: string, participantId: string): Promise<SandboxRecord> {
    let sandbox = await this.getOrCreate(roomId, participantId);
    for (;;) {
      if (sandbox.status === "DESTROYED" || sandbox.status === "DESTROYING")
        throw new CrossoverError("NOT_FOUND", "Participant sandbox has been destroyed");
      if (sandbox.status === "HIBERNATING") {
        await delay(TRANSITION_POLL_MS);
        sandbox = await this.claimForStart(roomId, participantId);
        continue;
      }

      sandbox = await this.claimForStart(roomId, participantId);
      if (sandbox.status === "HIBERNATING") continue;
      if (sandbox.status === "DESTROYED" || sandbox.status === "DESTROYING")
        throw new CrossoverError("NOT_FOUND", "Participant sandbox has been destroyed");

      // Docker calls stay outside DB transactions. Deterministic names let retries adopt
      // resources left by a process crash or a failed database write.
      const resources = await this.driver.create({
        sandbox_id: sandbox.id,
        room_id: roomId,
        participant_id: participantId,
        limits: sandbox.limits,
      });
      await this.options.afterDriverCreate?.(sandbox);

      const starting = await this.recordResources(sandbox.id, roomId, resources);
      if (!starting) {
        await this.throwIfDestroyed(sandbox.id, roomId, resources);
        sandbox = await this.claimForStart(roomId, participantId);
        continue;
      }

      // Always start before handing a sandbox back; this also repairs a stale RUNNING row.
      await this.driver.start({ sandbox_id: sandbox.id, resources });
      const running = await this.recordRunning(sandbox.id, roomId, resources);
      if (running) return running;

      await this.throwIfDestroyed(sandbox.id, roomId, resources);
      sandbox = await this.claimForStart(roomId, participantId);
    }
  }

  /** Look up only by the caller's room and participant identity, never by another sandbox ID. */
  async get(roomId: string, participantId: string): Promise<SandboxRecord | null> {
    const { rows } = await this.pool.query<SandboxRow>(
      `SELECT id, room_id, participant_id, status, limits, base_revision, volume_ref, container_ref,
              last_active_at, updated_at
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

  private async getOrCreate(roomId: string, participantId: string): Promise<SandboxRow> {
    return withTransaction(this.pool, async (client) => {
      const participant = await client.query<{ status: string; room_status: string }>(
        `SELECT p.status, r.status AS room_status FROM participants p
         JOIN rooms r ON r.id = p.room_id
         WHERE p.room_id = $1 AND p.id = $2`,
        [roomId, participantId],
      );
      const found = participant.rows[0];
      if (!found) throw new CrossoverError("NOT_FOUND", "Active sandbox participant not found");
      if (found.status === "PAUSED")
        throw new CrossoverError("PARTICIPANT_PAUSED", "Participant is paused", {
          details: { participant_id: participantId },
        });
      if (found.status !== "ACTIVE")
        throw new CrossoverError("NOT_FOUND", "Active sandbox participant not found");
      if (found.room_status !== "ACTIVE") {
        if (found.room_status === "DELETED")
          throw new CrossoverError("NOT_FOUND", "Room not found");
        throw new CrossoverError(
          "ROOM_PAUSED",
          found.room_status === "ARCHIVED" ? "Room is archived" : "Room is paused",
          { details: { room_status: found.room_status } },
        );
      }

      await client.query(
        `INSERT INTO sandboxes (id, room_id, participant_id, status, limits)
         VALUES ($1, $2, $3, 'CREATING', $4::jsonb)
         ON CONFLICT (room_id, participant_id) DO NOTHING`,
        [
          newId("sandbox"),
          roomId,
          participantId,
          JSON.stringify({ disk_enforcement: this.diskEnforcement }),
        ],
      );
      const { rows } = await client.query<SandboxRow>(
        `SELECT id, room_id, participant_id, status, limits, base_revision, volume_ref, container_ref,
                last_active_at, updated_at
         FROM sandboxes WHERE room_id = $1 AND participant_id = $2 FOR UPDATE`,
        [roomId, participantId],
      );
      const sandbox = rows[0];
      if (!sandbox || sandbox.status === "DESTROYED" || sandbox.status === "DESTROYING")
        throw new CrossoverError("NOT_FOUND", "Participant sandbox has been destroyed");
      return sandbox;
    });
  }

  /** Atomically mark a sandbox active before touching Docker so the sweeper cannot stop it. */
  private async claimForStart(roomId: string, participantId: string): Promise<SandboxRow> {
    return withTransaction(this.pool, async (client) => {
      const { rows } = await client.query<SandboxRow>(
        `SELECT id, room_id, participant_id, status, limits, base_revision, volume_ref, container_ref,
                last_active_at, updated_at
         FROM sandboxes WHERE room_id = $1 AND participant_id = $2 FOR UPDATE`,
        [roomId, participantId],
      );
      const sandbox = rows[0];
      if (!sandbox) throw new CrossoverError("NOT_FOUND", "Participant sandbox has been destroyed");
      const staleHibernate =
        sandbox.status === "HIBERNATING" &&
        Date.now() - sandbox.updated_at.getTime() >= HIBERNATION_RECOVERY_MS;
      if (sandbox.status === "RUNNING" || sandbox.status === "HIBERNATED" || staleHibernate) {
        const updated = await client.query<SandboxRow>(
          `UPDATE sandboxes SET status = 'STARTING', last_active_at = clock_timestamp(),
                                updated_at = clock_timestamp()
           WHERE id = $1 AND room_id = $2
           RETURNING id, room_id, participant_id, status, limits, base_revision, volume_ref, container_ref,
                     last_active_at, updated_at`,
          [sandbox.id, roomId],
        );
        return updated.rows[0]!;
      }
      return sandbox;
    });
  }

  private async recordResources(
    id: string,
    roomId: string,
    resources: SandboxResources,
  ): Promise<boolean> {
    return withTransaction(this.pool, async (client) => {
      const { rowCount } = await client.query(
        `UPDATE sandboxes SET status = 'STARTING', volume_ref = $3, container_ref = $4,
                              last_active_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE id = $1 AND room_id = $2 AND status IN ('CREATING', 'STARTING')`,
        [id, roomId, resources.volume_ref, resources.container_ref],
      );
      return rowCount === 1;
    });
  }

  private async recordRunning(
    id: string,
    roomId: string,
    resources: SandboxResources,
  ): Promise<SandboxRow | null> {
    return withTransaction(this.pool, async (client) => {
      const { rows } = await client.query<SandboxRow>(
        `UPDATE sandboxes SET status = 'RUNNING', volume_ref = $3, container_ref = $4,
                              last_active_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE id = $1 AND room_id = $2 AND status = 'STARTING'
         RETURNING id, room_id, participant_id, status, limits, base_revision, volume_ref, container_ref,
                   last_active_at, updated_at`,
        [id, roomId, resources.volume_ref, resources.container_ref],
      );
      return rows[0] ?? null;
    });
  }

  /** Remove resources created by an ensure call after participant/room cleanup won the race. */
  private async throwIfDestroyed(
    id: string,
    roomId: string,
    resources: SandboxResources,
  ): Promise<void> {
    const { rows } = await this.pool.query<{ status: SandboxStatus }>(
      "SELECT status FROM sandboxes WHERE id = $1 AND room_id = $2",
      [id, roomId],
    );
    const status = rows[0]?.status;
    if (status !== undefined && status !== "DESTROYING" && status !== "DESTROYED") return;

    await this.driver.destroy({ sandbox_id: id, resources });
    throw new CrossoverError("NOT_FOUND", "Participant sandbox has been destroyed");
  }

  private async hibernateOne(
    roomId: string,
    participantId: string,
    idleAtOrBefore?: Date,
  ): Promise<boolean> {
    const sandbox = await withTransaction(this.pool, async (client) => {
      const { rows } = await client.query<SandboxRow>(
        `SELECT id, room_id, participant_id, status, limits, base_revision, volume_ref, container_ref,
                last_active_at, updated_at
         FROM sandboxes WHERE room_id = $1 AND participant_id = $2 FOR UPDATE`,
        [roomId, participantId],
      );
      const current = rows[0];
      if (!current || current.status !== "RUNNING") return null;
      if (idleAtOrBefore && current.last_active_at > idleAtOrBefore) return null;
      const { rows: claimed } = await client.query<SandboxRow>(
        `UPDATE sandboxes SET status = 'HIBERNATING', updated_at = clock_timestamp()
         WHERE id = $1 AND room_id = $2 AND status = 'RUNNING'
         RETURNING id, room_id, participant_id, status, limits, base_revision, volume_ref, container_ref,
                   last_active_at, updated_at`,
        [current.id, roomId],
      );
      return claimed[0] ?? null;
    });
    if (!sandbox) return false;

    const resources = this.resources(sandbox);
    try {
      await this.driver.stop({ sandbox_id: sandbox.id, resources });
      const rowCount = await withTransaction(this.pool, async (client) => {
        const result = await client.query(
          `UPDATE sandboxes SET status = 'HIBERNATED', updated_at = clock_timestamp()
           WHERE id = $1 AND room_id = $2 AND status = 'HIBERNATING'`,
          [sandbox.id, roomId],
        );
        return result.rowCount;
      });
      return rowCount === 1;
    } catch (error) {
      // Keep future ensures able to heal a container that stopped before this write failed.
      await withTransaction(this.pool, async (client) =>
        client.query(
          `UPDATE sandboxes SET status = 'RUNNING', updated_at = clock_timestamp()
           WHERE id = $1 AND room_id = $2 AND status = 'HIBERNATING'`,
          [sandbox.id, roomId],
        ),
      ).catch((recoveryError: unknown) =>
        console.error("[execution] failed to recover interrupted hibernation", recoveryError),
      );
      throw error;
    }
  }

  private async destroyOne(roomId: string, participantId: string): Promise<void> {
    const sandbox = await withTransaction(this.pool, async (client) => {
      const { rows } = await client.query<SandboxRow>(
        `SELECT id, room_id, participant_id, status, limits, base_revision, volume_ref, container_ref,
                last_active_at, updated_at
         FROM sandboxes WHERE room_id = $1 AND participant_id = $2 FOR UPDATE`,
        [roomId, participantId],
      );
      const current = rows[0];
      if (!current || current.status === "DESTROYED") return null;
      const { rows: claimed } = await client.query<SandboxRow>(
        `UPDATE sandboxes SET status = 'DESTROYING', updated_at = clock_timestamp()
         WHERE id = $1 AND room_id = $2
         RETURNING id, room_id, participant_id, status, limits, base_revision, volume_ref, container_ref,
                   last_active_at, updated_at`,
        [current.id, roomId],
      );
      return claimed[0] ?? null;
    });
    if (!sandbox) return;

    await this.driver.destroy({
      sandbox_id: sandbox.id,
      ...(sandbox.volume_ref && sandbox.container_ref
        ? { resources: this.resources(sandbox) }
        : {}),
    });
    await withTransaction(this.pool, async (client) =>
      client.query(
        `UPDATE sandboxes SET status = 'DESTROYED', volume_ref = NULL, container_ref = NULL,
                              updated_at = clock_timestamp()
         WHERE id = $1 AND room_id = $2 AND status = 'DESTROYING'`,
        [sandbox.id, roomId],
      ),
    );
  }

  private resources(sandbox: SandboxRow): SandboxResources {
    if (!sandbox.volume_ref || !sandbox.container_ref)
      throw new Error(`Sandbox ${sandbox.id} is missing its driver references`);
    return { volume_ref: sandbox.volume_ref, container_ref: sandbox.container_ref };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
