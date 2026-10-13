import type {
  ExecutionCore,
  SandboxAdvanceEvent,
  SandboxRow,
  SandboxSnapshotFile,
} from "./core.js";
import {
  advanceWorkingCopyLocked,
  changedWorkspacePaths,
  filterSnapshotDelta,
  filteredIntents,
  pathsOverlap,
  readablePaths,
  rebaseHumanWorkingCopy,
  snapshotChanges,
  snapshotDelta,
} from "./working-copy.js";

/** Enqueue the latest canonical revision; one room worker coalesces bursts of commits. */
export function scheduleCanonicalAdvance(
  core: ExecutionCore,
  roomId: string,
  revision: number,
  skipParticipantId?: string,
): void {
  core.pendingAdvances.set(roomId, Math.max(core.pendingAdvances.get(roomId) ?? 0, revision));
  if (skipParticipantId) {
    const skipped = core.pendingAdvanceSkips.get(roomId) ?? new Map<string, number>();
    skipped.set(skipParticipantId, Math.max(skipped.get(skipParticipantId) ?? 0, revision));
    core.pendingAdvanceSkips.set(roomId, skipped);
  }
  if (!core.advanceWorkers.has(roomId))
    setImmediate(() => startCanonicalAdvanceWorker(core, roomId));
}

async function drainCanonicalAdvances(core: ExecutionCore, roomId: string): Promise<void> {
  while (core.pendingAdvances.has(roomId)) {
    const requestedRevision = core.pendingAdvances.get(roomId)!;
    core.pendingAdvances.delete(roomId);
    const skipped = core.pendingAdvanceSkips.get(roomId) ?? new Map<string, number>();
    core.pendingAdvanceSkips.delete(roomId);
    try {
      await reconcileRoomSandboxes(core, roomId, requestedRevision, skipped);
    } catch (error) {
      console.error("Failed to reconcile sandboxes after a canonical advance", {
        room_id: roomId,
        revision: requestedRevision,
        error,
      });
    }
  }
}

function startCanonicalAdvanceWorker(core: ExecutionCore, roomId: string): void {
  if (core.advanceWorkers.has(roomId) || !core.pendingAdvances.has(roomId)) return;
  const worker = drainCanonicalAdvances(core, roomId).finally(() => {
    core.advanceWorkers.delete(roomId);
    if (core.pendingAdvances.has(roomId)) startCanonicalAdvanceWorker(core, roomId);
  });
  core.advanceWorkers.set(roomId, worker);
}

async function reconcileRoomSandboxes(
  core: ExecutionCore,
  roomId: string,
  requestedRevision: number,
  skippedParticipants: ReadonlyMap<string, number>,
): Promise<void> {
  const head = await core.canonicalHead(roomId);
  if (head.revision < requestedRevision) return;
  const { rows } = await core.pool.query<SandboxRow & { kind: "HUMAN" | "AGENT" }>(
    `SELECT s.id, s.room_id, s.participant_id, s.status, s.limits, s.base_revision,
              s.volume_ref, s.container_ref, s.last_active_at, s.updated_at, p.kind
       FROM sandboxes s JOIN participants p ON p.id = s.participant_id AND p.room_id = s.room_id
       WHERE s.room_id = $1 AND s.status = 'RUNNING' AND s.base_revision IS NOT NULL
         AND s.base_revision < $2 AND s.volume_ref IS NOT NULL AND s.container_ref IS NOT NULL
         AND p.status = 'ACTIVE'
       ORDER BY s.participant_id`,
    [roomId, head.revision],
  );
  const events: SandboxAdvanceEvent[] = [];
  for (const row of rows) {
    if ((skippedParticipants.get(row.participant_id) ?? 0) >= head.revision) continue;
    try {
      events.push(...(await reconcileSandbox(core, row, head)));
    } catch (error) {
      console.error("Failed to reconcile one sandbox", {
        room_id: roomId,
        participant_id: row.participant_id,
        revision: head.revision,
        error,
      });
      events.push({
        type: "sandbox.behind",
        actor_id: "system",
        payload: {
          participant_id: row.participant_id,
          behind_by: Math.max(0, head.revision - (row.base_revision ?? head.revision)),
          changed_paths: [],
          overlaps_local_changes: true,
          intents: [],
          reason: "advance_failed",
        },
      });
    }
  }
  if (events.length && core.sandboxEventSink)
    await core
      .sandboxEventSink(roomId, events)
      .catch((error: unknown) =>
        console.error("Failed to publish sandbox advance events", { room_id: roomId, error }),
      );
}

async function reconcileSandbox(
  core: ExecutionCore,
  row: SandboxRow & { kind: "HUMAN" | "AGENT" },
  head: { repo_path: string; revision: number; commit_sha: string },
): Promise<SandboxAdvanceEvent[]> {
  return core.withEnsureLock(row.room_id, row.participant_id, async () => {
    const sandbox = await core.get(row.room_id, row.participant_id);
    if (
      !sandbox ||
      sandbox.status !== "RUNNING" ||
      sandbox.base_revision === null ||
      sandbox.base_revision >= head.revision ||
      !sandbox.volume_ref ||
      !sandbox.container_ref
    )
      return [];
    const base = await core.workspaceRevision(row.room_id, sandbox.base_revision);
    const changedPaths = await changedWorkspacePaths(
      head.repo_path,
      base.commit_sha,
      head.commit_sha,
    );
    const visibleChanged = await readablePaths(core, row.room_id, row.participant_id, changedPaths);
    const working = await snapshotChanges(core, sandbox, base.repo_path, base.commit_sha);
    const localPaths = [...working.modified, ...working.added, ...working.deleted];
    const visibleLocal = await readablePaths(core, row.room_id, row.participant_id, localPaths);
    const overlaps = visibleChanged.some((path) =>
      visibleLocal.some((local) => pathsOverlap(path, local)),
    );
    const intents = await filteredIntents(core, row.room_id, row.participant_id);
    const behindPayload = {
      participant_id: row.participant_id,
      behind_by: Math.max(0, head.revision - sandbox.base_revision),
      changed_paths: visibleChanged,
      overlaps_local_changes: overlaps || working.truncated,
      intents,
    };
    const behind = (reason?: string): SandboxAdvanceEvent => ({
      type: "sandbox.behind",
      actor_id: "system",
      payload: { ...behindPayload, ...(reason ? { reason } : {}) },
    });
    if (core.activeCount(sandbox.id) > 0) return [behind("process_running")];
    if (working.truncated) return [behind("status_truncated")];
    if (row.kind === "AGENT" && overlaps) return [behind("local_changes")];
    if (!core.driver.updateSnapshot || !core.driver.snapshotInventory)
      return [behind("unsupported_driver")];

    let delta: { files: SandboxSnapshotFile[]; delete_paths: string[] };
    let conflictedPaths: string[] = [];
    if (row.kind === "HUMAN" && localPaths.length > 0) {
      const rebased = await rebaseHumanWorkingCopy(core, sandbox, base, head, working);
      if (!rebased) return [behind("unsupported_local_change")];
      delta = filterSnapshotDelta(rebased.delta, new Set([...visibleChanged, ...visibleLocal]));
      conflictedPaths = rebased.conflicted_paths;
    } else {
      delta = filterSnapshotDelta(
        await snapshotDelta(head.repo_path, base.commit_sha, head.commit_sha),
        new Set(visibleChanged),
      );
    }
    let advanced: "advanced" | "process_running";
    try {
      advanced = await advanceWorkingCopyLocked(
        core,
        sandbox,
        sandbox.base_revision,
        head.revision,
        delta.files,
        delta.delete_paths,
      );
    } catch (error) {
      console.error("Failed to advance sandbox working copy", {
        room_id: row.room_id,
        participant_id: row.participant_id,
        revision: head.revision,
        error,
      });
      return [behind("advance_failed")];
    }
    if (advanced === "process_running") return [behind("process_running")];
    return [
      behind(),
      {
        type: "sandbox.synced",
        actor_id: "system",
        payload: {
          participant_id: row.participant_id,
          base_revision: head.revision,
          ...(conflictedPaths.length ? { conflicted_paths: conflictedPaths } : {}),
        },
      },
    ];
  });
}
export function scheduleLatestCanonical(core: ExecutionCore, roomId: string): void {
  void core
    .canonicalHead(roomId)
    .then(({ revision }) => scheduleCanonicalAdvance(core, roomId, revision))
    .catch((error: unknown) =>
      console.error("Failed to check canonical head after sandbox wake", {
        room_id: roomId,
        error,
      }),
    );
}
