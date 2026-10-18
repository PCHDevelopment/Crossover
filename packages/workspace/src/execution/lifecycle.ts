import { withTransaction } from "@crossover/db";
import { CrossoverError, newId } from "@crossover/protocol";
import {
  DESTROY_RETRY_MS,
  HIBERNATION_RECOVERY_MS,
  SWEEP_BATCH_SIZE,
  TRANSITION_POLL_MS,
  type ExecutionCore,
  type SandboxExecTermination,
  type SandboxRecord,
  type SandboxResources,
  type SandboxRow,
  type SandboxStatus,
  normalizeSandbox,
} from "./core.js";

/** Create lazily, or resume, the one sandbox owned by this room participant. */
export async function ensure(
  core: ExecutionCore,
  roomId: string,
  participantId: string,
): Promise<SandboxRecord> {
  let woke = false;
  const sandbox = await core.withEnsureLock(roomId, participantId, async () => {
    const previous = await core.get(roomId, participantId);
    woke = previous?.status === "HIBERNATED" || previous?.status === "HIBERNATING";
    return ensureExclusive(core, roomId, participantId);
  });
  if (woke) core.hooks.scheduleLatestCanonical(roomId);
  return sandbox;
}

/** Serialize snapshot preparation with lifecycle transitions, while keeping I/O off SQL locks. */
export async function withSandboxLock<T>(
  core: ExecutionCore,
  roomId: string,
  participantId: string,
  work: (sandbox: SandboxRecord) => Promise<T>,
): Promise<T> {
  let woke = false;
  const result = await core.withEnsureLock(roomId, participantId, async () => {
    const previous = await core.get(roomId, participantId);
    woke = previous?.status === "HIBERNATED" || previous?.status === "HIBERNATING";
    const sandbox = await ensureExclusive(core, roomId, participantId);
    return work(sandbox);
  });
  if (woke) core.hooks.scheduleLatestCanonical(roomId);
  return result;
}

/** Hibernate idle sandboxes; the container stops while its Docker volume is retained. */
export async function sweepIdle(core: ExecutionCore, now = new Date()): Promise<number> {
  const { rows } = await core.pool.query<Pick<SandboxRow, "room_id" | "participant_id">>(
    `SELECT room_id, participant_id FROM sandboxes
       WHERE status = 'RUNNING' AND last_active_at <= $1
       ORDER BY last_active_at LIMIT $2`,
    [new Date(now.getTime() - core.idleMs), SWEEP_BATCH_SIZE],
  );
  let hibernated = 0;
  for (const row of rows)
    if (await hibernateOne(core, row.room_id, row.participant_id, now)) hibernated++;
  return hibernated;
}

/** Retry cleanup for interrupted destroys and owners that have left or archived their room. */
export async function sweepCleanup(core: ExecutionCore, now = new Date()): Promise<number> {
  const staleBefore = new Date(now.getTime() - DESTROY_RETRY_MS);
  const { rows } = await core.pool.query<Pick<SandboxRow, "room_id" | "participant_id">>(
    `SELECT s.room_id, s.participant_id FROM sandboxes s
       JOIN rooms r ON r.id = s.room_id
       LEFT JOIN participants p ON p.id = s.participant_id AND p.room_id = s.room_id
       WHERE s.status <> 'DESTROYED' AND (
         (s.status = 'DESTROYING' AND s.updated_at <= $1) OR
         p.status = 'REMOVED' OR r.status = 'ARCHIVED'
       )
       ORDER BY s.updated_at LIMIT $2`,
    [staleBefore, SWEEP_BATCH_SIZE],
  );
  let destroyed = 0;
  for (const row of rows) {
    try {
      if (await destroyOne(core, row.room_id, row.participant_id)) destroyed++;
    } catch (error) {
      // Keep processing independent sandboxes; the next sweep retries this DESTROYING row.
      console.error(
        `[execution] sandbox cleanup retry failed for ${row.room_id}/${row.participant_id}`,
        error,
      );
    }
  }
  return destroyed;
}

/** Stop every sandbox in a room, optionally limiting the operation to agents (§5). */
export async function hibernateRoom(
  core: ExecutionCore,
  roomId: string,
  agentsOnly = false,
): Promise<void> {
  const { rows } = await core.pool.query<Pick<SandboxRow, "participant_id">>(
    `SELECT s.participant_id FROM sandboxes s
       JOIN participants p ON p.id = s.participant_id AND p.room_id = s.room_id
       WHERE s.room_id = $1 AND s.status = 'RUNNING' AND ($2 = false OR p.kind = 'AGENT')`,
    [roomId, agentsOnly],
  );
  for (const row of rows) await hibernateOne(core, roomId, row.participant_id);
}

export async function destroyParticipant(
  core: ExecutionCore,
  roomId: string,
  participantId: string,
): Promise<void> {
  await destroyOne(core, roomId, participantId);
}

export async function destroyRoom(core: ExecutionCore, roomId: string): Promise<void> {
  const { rows } = await core.pool.query<Pick<SandboxRow, "participant_id">>(
    "SELECT participant_id FROM sandboxes WHERE room_id = $1 AND status <> 'DESTROYED'",
    [roomId],
  );
  for (const row of rows) await destroyOne(core, roomId, row.participant_id);
}

export function startSweeper(core: ExecutionCore): void {
  if (core.sweepTimer) return;
  core.sweepTimer = setInterval(() => {
    void sweepIdle(core).catch((error: unknown) =>
      console.error("[execution] idle sandbox sweep failed", error),
    );
    void sweepCleanup(core).catch((error: unknown) =>
      console.error("[execution] sandbox cleanup sweep failed", error),
    );
    void core.computeSweeper
      .sweep(core.now())
      .catch((error: unknown) => console.error("[execution] sandbox CPU sweep failed", error));
  }, core.sweepIntervalMs);
  core.sweepTimer.unref();
}

export async function close(core: ExecutionCore): Promise<void> {
  core.closed = true;
  if (core.sweepTimer) clearInterval(core.sweepTimer);
  core.sweepTimer = undefined;
  core.pendingAdvances.clear();
  core.pendingAdvanceSkips.clear();
  await core.hooks.cancelAllExecs("sandbox_stopped");
  const workers = [...core.advanceWorkers.values()];
  if (workers.length === 0) return;
  const waitMs = 30_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const settled = await Promise.race([
      Promise.allSettled(workers).then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), waitMs);
      }),
    ]);
    if (!settled)
      console.error("[execution] canonical advance workers did not finish before shutdown", {
        worker_count: core.advanceWorkers.size,
        wait_ms: waitMs,
      });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function ensureExclusive(
  core: ExecutionCore,
  roomId: string,
  participantId: string,
): Promise<SandboxRecord> {
  let sandbox = await getOrCreate(core, roomId, participantId);
  for (;;) {
    if (sandbox.status === "DESTROYED" || sandbox.status === "DESTROYING")
      throw new CrossoverError("NOT_FOUND", "Participant sandbox has been destroyed");
    if (sandbox.status === "HIBERNATING") {
      await delay(TRANSITION_POLL_MS);
      sandbox = await claimForStart(core, roomId, participantId);
      continue;
    }

    sandbox = await claimForStart(core, roomId, participantId);
    if (sandbox.status === "HIBERNATING") continue;
    if (sandbox.status === "DESTROYED" || sandbox.status === "DESTROYING")
      throw new CrossoverError("NOT_FOUND", "Participant sandbox has been destroyed");

    // Docker calls stay outside DB transactions. Deterministic names let retries adopt
    // resources left by a process crash or a failed database write.
    const resources = await core.driver.create({
      sandbox_id: sandbox.id,
      room_id: roomId,
      participant_id: participantId,
      limits: sandbox.limits,
    });
    await core.options.afterDriverCreate?.(sandbox);

    const starting = await recordResources(core, sandbox.id, roomId, resources);
    if (!starting) {
      await throwIfDestroyed(core, sandbox.id, roomId, resources);
      sandbox = await claimForStart(core, roomId, participantId);
      continue;
    }

    if (sandbox.base_revision === null && core.driver.materialize) {
      const workspace = await core.workspaceHead(roomId);
      await core.driver.materialize({
        sandbox_id: sandbox.id,
        room_id: roomId,
        participant_id: participantId,
        resources,
        workspace,
      });
      const recorded = await core.recordBaseRevision(sandbox.id, roomId, workspace.revision);
      if (!recorded) {
        await throwIfDestroyed(core, sandbox.id, roomId, resources);
        sandbox = await claimForStart(core, roomId, participantId);
        continue;
      }
    }

    // Always start before handing a sandbox back; this also repairs a stale RUNNING row.
    await core.driver.start({ sandbox_id: sandbox.id, resources });
    const running = await recordRunning(core, sandbox.id, roomId, resources);
    if (running) {
      const active = normalizeSandbox(running);
      if (core.driver.cpuUsage) await core.computeSweeper.sample(active);
      return active;
    }

    await throwIfDestroyed(core, sandbox.id, roomId, resources);
    sandbox = await claimForStart(core, roomId, participantId);
  }
}

export async function getOrCreate(
  core: ExecutionCore,
  roomId: string,
  participantId: string,
): Promise<SandboxRow> {
  return withTransaction(core.pool, async (client) => {
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
      if (found.room_status === "DELETED") throw new CrossoverError("NOT_FOUND", "Room not found");
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
        JSON.stringify({ disk_enforcement: core.diskEnforcement }),
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
    return normalizeSandbox(sandbox);
  });
}

/** Atomically mark a sandbox active before touching Docker so the sweeper cannot stop it. */
export async function claimForStart(
  core: ExecutionCore,
  roomId: string,
  participantId: string,
): Promise<SandboxRow> {
  return withTransaction(core.pool, async (client) => {
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
      return normalizeSandbox(updated.rows[0]!);
    }
    return normalizeSandbox(sandbox);
  });
}

export async function recordResources(
  core: ExecutionCore,
  id: string,
  roomId: string,
  resources: SandboxResources,
): Promise<boolean> {
  return withTransaction(core.pool, async (client) => {
    const { rowCount } = await client.query(
      `UPDATE sandboxes SET status = 'STARTING', volume_ref = $3, container_ref = $4,
                              last_active_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE id = $1 AND room_id = $2 AND status IN ('CREATING', 'STARTING')`,
      [id, roomId, resources.volume_ref, resources.container_ref],
    );
    return rowCount === 1;
  });
}

export async function recordRunning(
  core: ExecutionCore,
  id: string,
  roomId: string,
  resources: SandboxResources,
): Promise<SandboxRow | null> {
  return withTransaction(core.pool, async (client) => {
    const { rows } = await client.query<SandboxRow>(
      `UPDATE sandboxes SET status = 'RUNNING', volume_ref = $3, container_ref = $4,
                              last_active_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE id = $1 AND room_id = $2 AND status = 'STARTING'
         RETURNING id, room_id, participant_id, status, limits, base_revision, volume_ref, container_ref,
                   last_active_at, updated_at`,
      [id, roomId, resources.volume_ref, resources.container_ref],
    );
    return rows[0] ? normalizeSandbox(rows[0]) : null;
  });
}

/** Remove resources created by an ensure call after participant/room cleanup won the race. */
export async function throwIfDestroyed(
  core: ExecutionCore,
  id: string,
  roomId: string,
  resources: SandboxResources,
): Promise<void> {
  const { rows } = await core.pool.query<{ status: SandboxStatus }>(
    "SELECT status FROM sandboxes WHERE id = $1 AND room_id = $2",
    [id, roomId],
  );
  const status = rows[0]?.status;
  if (status !== undefined && status !== "DESTROYING" && status !== "DESTROYED") return;

  await core.driver.destroy({ sandbox_id: id, resources });
  throw new CrossoverError("NOT_FOUND", "Participant sandbox has been destroyed");
}

export async function hibernateOne(
  core: ExecutionCore,
  roomId: string,
  participantId: string,
  idleAtOrBefore?: Date,
): Promise<boolean> {
  return core.withEnsureLock(roomId, participantId, async () => {
    const sandbox = await withTransaction(core.pool, async (client) => {
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

    const resources = core.resources(sandbox);
    try {
      await cancelSandboxExecs(core, normalizeSandbox(sandbox), "sandbox_stopped", () =>
        core.driver.stop({ sandbox_id: sandbox.id, resources }),
      );
      const rowCount = await withTransaction(core.pool, async (client) => {
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
      await withTransaction(core.pool, async (client) =>
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
  });
}

export async function destroyOne(
  core: ExecutionCore,
  roomId: string,
  participantId: string,
): Promise<boolean> {
  const claim = await withTransaction(core.pool, async (client) => {
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
    return claimed[0]
      ? { sandbox: normalizeSandbox(claimed[0]), previousStatus: current.status }
      : null;
  });
  if (!claim) return false;

  const destroy = async (): Promise<boolean> => {
    const sandbox = claim.sandbox;
    await cancelSandboxExecs(
      core,
      sandbox,
      "sandbox_stopped",
      () =>
        core.driver.destroy({
          sandbox_id: sandbox.id,
          ...(sandbox.volume_ref && sandbox.container_ref
            ? { resources: core.resources(sandbox) }
            : {}),
        }),
      false,
    );
    await withTransaction(core.pool, async (client) =>
      client.query(
        `UPDATE sandboxes SET status = 'DESTROYED', volume_ref = NULL, container_ref = NULL,
                              updated_at = clock_timestamp()
         WHERE id = $1 AND room_id = $2 AND status = 'DESTROYING'`,
        [sandbox.id, roomId],
      ),
    );
    return true;
  };

  // A create/start transition has not returned a usable sandbox to an exec caller yet. Let
  // cleanup win immediately; the in-flight ensure observes DESTROYING and adopts this cleanup.
  // For a RUNNING sandbox, take the lock after fencing it so an exec or advance that already
  // holds the lock finishes before its process group and volume are destroyed.
  if (claim.previousStatus === "CREATING" || claim.previousStatus === "STARTING") return destroy();
  return core.withEnsureLock(roomId, participantId, destroy);
}

export async function cancelSandboxExecs(
  core: ExecutionCore,
  sandbox: SandboxRecord,
  reason: SandboxExecTermination,
  terminateSandbox?: () => Promise<void>,
  failOnSample = true,
): Promise<void> {
  const active = [...core.activeExecs.values()].filter((run) => run.sandbox_id === sandbox.id);
  const cancelling = active.map((run) => run.process.cancel(reason).catch(() => undefined));
  await Promise.all(cancelling);
  if (sandbox.container_ref && core.driver.cpuUsage) {
    try {
      await core.computeSweeper.sample(sandbox);
    } catch (error) {
      if (failOnSample) throw error;
      console.error("[execution] unable to sample sandbox CPU before destroy", {
        sandbox_id: sandbox.id,
        error,
      });
    }
  }
  await terminateSandbox?.();
  await Promise.all(active.map((run) => run.process.finished.catch(() => undefined)));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
