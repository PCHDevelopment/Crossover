import { CrossoverError } from "@crossover/protocol";
import { SANDBOX_VCPU_COUNT } from "./core.js";
import type {
  ExecutionCore,
  PendingSandboxExec,
  SandboxExecProcess,
  SandboxExecTermination,
} from "./core.js";
import { withSandboxLock } from "./lifecycle.js";
import { scheduleCanonicalAdvance } from "./canonical-advance.js";

/** Reserve capacity before the command commits its started event. */
export async function reserveExec(
  core: ExecutionCore,
  roomId: string,
  participantId: string,
  execId: string,
  requestedTimeoutMs = 600_000,
): Promise<{ sandbox_id: string; timeout_ms: number }> {
  return withSandboxLock(core, roomId, participantId, async (sandbox) => {
    if (!core.driver.exec || !core.driver.cpuUsage)
      throw new CrossoverError("UNAVAILABLE", "Sandbox execution requires a cumulative CPU meter");
    if (core.pendingExecs.has(execId) || core.activeExecs.has(execId))
      throw new CrossoverError("CONFLICT_VERSION", "Sandbox execution id is already reserved");
    assertExecCapacityFor(core, sandbox.id);
    await core.computeSweeper.sample(sandbox);
    const timeoutMs = await core.computeBudgetMeter.reserve({
      room_id: roomId,
      participant_id: participantId,
      sandbox_id: sandbox.id,
      exec_id: execId,
      requested_timeout_ms: requestedTimeoutMs,
      vcpus: SANDBOX_VCPU_COUNT,
    });
    core.pendingExecs.set(execId, {
      room_id: roomId,
      participant_id: participantId,
      sandbox_id: sandbox.id,
    });
    return { sandbox_id: sandbox.id, timeout_ms: timeoutMs };
  });
}

/** Check that prepare still owns the slot before committing the started event. */
export function assertExecReservation(
  core: ExecutionCore,
  roomId: string,
  participantId: string,
  sandboxId: string,
  execId: string,
): void {
  const pending = core.pendingExecs.get(execId);
  if (
    !pending ||
    pending.room_id !== roomId ||
    pending.participant_id !== participantId ||
    pending.sandbox_id !== sandboxId
  )
    throw new CrossoverError("UNAVAILABLE", "Sandbox execution reservation is no longer available");
}

/** Read a pending reservation so cancel can find an exec before its private log exists. */
export function pendingExec(core: ExecutionCore, execId: string): PendingSandboxExec | undefined {
  const pending = core.pendingExecs.get(execId);
  return pending ? { ...pending } : undefined;
}

/** Release a slot after commit or rollback; consuming it at start makes this a no-op. */
export async function releaseExecReservation(core: ExecutionCore, execId: string): Promise<void> {
  const pending = core.pendingExecs.get(execId);
  if (!pending) return;
  await core.withEnsureLock(pending.room_id, pending.participant_id, async () => {
    if (core.pendingExecs.get(execId) === pending) {
      core.pendingExecs.delete(execId);
      await core.computeBudgetMeter.release(execId);
    }
  });
}

function assertExecCapacityFor(core: ExecutionCore, sandboxId: string): void {
  if (!core.driver.exec)
    throw new CrossoverError("UNAVAILABLE", "Sandbox execution is not supported by this driver");
  if (execCount(core, sandboxId) >= 8)
    throw new CrossoverError("VALIDATION", "A sandbox may run at most 8 commands at once", {
      details: { reason: "too_many_execs", maximum: 8 },
    });
}

/** Start one command while serialized with submit's post-commit working-copy advance. */
export async function startExec(
  core: ExecutionCore,
  input: {
    room_id: string;
    participant_id: string;
    exec_id: string;
    command: string;
    cwd: string;
    timeoutMs: number;
    onOutput: (stream: "stdout" | "stderr", chunk: Buffer) => Promise<void>;
  },
): Promise<SandboxExecProcess> {
  return withSandboxLock(core, input.room_id, input.participant_id, async (sandbox) => {
    const pending = core.pendingExecs.get(input.exec_id);
    if (
      !pending ||
      pending.room_id !== input.room_id ||
      pending.participant_id !== input.participant_id ||
      pending.sandbox_id !== sandbox.id
    )
      throw new CrossoverError(
        "UNAVAILABLE",
        "Sandbox execution reservation is no longer available",
      );

    if (pending.reason !== undefined) {
      core.pendingExecs.delete(input.exec_id);
      await core.computeBudgetMeter.release(input.exec_id);
      return {
        ...(pending.cancelled_by !== undefined ? { cancelled_by: pending.cancelled_by } : {}),
        finished: Promise.resolve({
          exit_code: null,
          duration_ms: 0,
          reason: pending.reason,
        }),
        cancel: async () => undefined,
      };
    }

    const run = core.driver.exec;
    if (!run || !core.driver.cpuUsage || !sandbox.volume_ref || !sandbox.container_ref) {
      core.pendingExecs.delete(input.exec_id);
      await core.computeBudgetMeter.release(input.exec_id);
      throw new CrossoverError("UNAVAILABLE", "Sandbox execution requires a cumulative CPU meter");
    }
    let process: SandboxExecProcess;
    try {
      process = await run.call(core.driver, {
        sandbox_id: sandbox.id,
        resources: core.resources(sandbox),
        exec_id: input.exec_id,
        command: input.command,
        cwd: input.cwd,
        timeoutMs: input.timeoutMs,
        onOutput: input.onOutput,
      });
    } catch (error) {
      core.pendingExecs.delete(input.exec_id);
      await core.computeBudgetMeter.release(input.exec_id);
      throw error;
    }
    core.pendingExecs.delete(input.exec_id);
    core.activeExecs.set(input.exec_id, {
      room_id: input.room_id,
      participant_id: input.participant_id,
      sandbox_id: sandbox.id,
      process,
    });
    void process.finished
      .catch(() => undefined)
      .then(async () => {
        try {
          await core.computeSweeper.sample(sandbox);
          await core.computeBudgetMeter.release(input.exec_id);
        } catch (error) {
          console.error("Failed to reconcile sandbox CPU usage", error);
        }
        return core.withEnsureLock(input.room_id, input.participant_id, async () => {
          const active = core.activeExecs.get(input.exec_id);
          if (active?.process === process) core.activeExecs.delete(input.exec_id);
          const head = await core.workspaceHead(input.room_id).catch(() => undefined);
          if (head) scheduleCanonicalAdvance(core, input.room_id, head.revision);
        });
      })
      .catch((error: unknown) => console.error("Failed to clear completed sandbox exec", error));
    return process;
  });
}

export async function cancelExec(
  core: ExecutionCore,
  roomId: string,
  participantId: string,
  execId: string,
  reason: SandboxExecTermination = "cancelled",
  cancelledBy?: string,
): Promise<boolean> {
  const pending = core.pendingExecs.get(execId);
  const active = core.activeExecs.get(execId);
  const known = pending ?? active;
  if (!known || known.room_id !== roomId || known.participant_id !== participantId) return false;
  return core.withEnsureLock(roomId, participantId, async () => {
    const stillPending = core.pendingExecs.get(execId);
    if (stillPending?.room_id === roomId && stillPending.participant_id === participantId) {
      stillPending.reason = reason;
      if (cancelledBy !== undefined) stillPending.cancelled_by = cancelledBy;
      return true;
    }
    const stillActive = core.activeExecs.get(execId);
    if (
      !stillActive ||
      stillActive.room_id !== roomId ||
      stillActive.participant_id !== participantId
    )
      return false;
    await stillActive.process.cancel(reason);
    await stillActive.process.finished.catch(() => undefined);
    return true;
  });
}

export async function cancelParticipantExecs(
  core: ExecutionCore,
  roomId: string,
  participantId: string,
  reason: SandboxExecTermination,
): Promise<void> {
  await core.withEnsureLock(roomId, participantId, async () => {
    const sandbox = await core.get(roomId, participantId);
    const active = [...core.activeExecs.values()].filter(
      (run) => run.room_id === roomId && run.participant_id === participantId,
    );
    for (const pending of core.pendingExecs.values())
      if (pending.room_id === roomId && pending.participant_id === participantId)
        pending.reason = reason;
    const cancelling = active.map((run) => run.process.cancel(reason).catch(() => undefined));
    if (reason === "revoked" && sandbox?.status === "RUNNING") {
      const resources = core.resources(sandbox);
      if (core.driver.restart) await core.driver.restart({ sandbox_id: sandbox.id, resources });
      else
        await core.driver
          .stop({ sandbox_id: sandbox.id, resources })
          .then(() => core.driver.start({ sandbox_id: sandbox.id, resources }));
    }
    await Promise.all(cancelling);
    await Promise.all(active.map((run) => run.process.finished.catch(() => undefined)));
  });
}

export async function cancelAllExecs(
  core: ExecutionCore,
  reason: SandboxExecTermination,
): Promise<void> {
  for (const pending of core.pendingExecs.values()) pending.reason = reason;
  const active = [...core.activeExecs.values()];
  await Promise.all(active.map((run) => run.process.cancel(reason).catch(() => undefined)));
  await Promise.all(active.map((run) => run.process.finished.catch(() => undefined)));
}

function execCount(core: ExecutionCore, sandboxId: string): number {
  let count = core.activeCount(sandboxId);
  for (const pending of core.pendingExecs.values()) if (pending.sandbox_id === sandboxId) count++;
  return count;
}
