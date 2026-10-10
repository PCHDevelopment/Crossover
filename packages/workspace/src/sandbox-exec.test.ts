import {
  allowAll,
  Dispatcher,
  type CommandContext,
  type CommandDefinition,
  type PrepareContext,
} from "@crossover/kernel";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { newId } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ExecutionService,
  type ExecutionDriver,
  type ExecutionService as ExecutionServiceType,
  type SandboxExecOutcome,
  type SandboxExecProcess,
} from "./execution.js";
import { MemoryLogStore } from "./sandbox-log-store.js";
import type { SandboxOutputChunk } from "./sandbox-log-store.js";
import { registerSandboxExecCommands } from "./sandbox-exec.js";
import type { sandboxExecCancelParamsSchema, sandboxExecParamsSchema } from "./sandbox-exec.js";

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db.drop();
});

type ExecCommand = CommandDefinition<typeof sandboxExecParamsSchema, unknown>;
type CancelCommand = CommandDefinition<typeof sandboxExecCancelParamsSchema, unknown>;

function setup(settings: unknown = {}) {
  const roomId = newId("room");
  const participantId = newId("part");
  const sandboxId = newId("sandbox");
  const definitions: unknown[] = [];
  const finishedEvents: Record<string, unknown>[] = [];
  const dispatcher = {
    registerCommand: (definition: unknown) => definitions.push(definition),
    runSystem: vi.fn(
      async (
        _room: string,
        _name: string,
        run: (ctx: never) => Promise<{ result: unknown; events: Record<string, unknown>[] }>,
      ) => {
        const out = await run({} as never);
        finishedEvents.push(...out.events);
        return { result: out.result, events: [] };
      },
    ),
  } as unknown as Dispatcher;
  let output!: (stream: "stdout" | "stderr", bytes: Buffer) => Promise<void>;
  let resolveFinished!: (outcome: SandboxExecOutcome) => void;
  const process: SandboxExecProcess = {
    finished: new Promise((resolve) => (resolveFinished = resolve)),
    cancel: vi.fn(async () => undefined),
  };
  const pendingExecs = new Map<
    string,
    {
      room_id: string;
      participant_id: string;
      sandbox_id: string;
      cancelled_by?: string;
      reason?: string;
    }
  >();
  const execution = {
    reserveExec: vi.fn(async (roomId: string, ownerId: string, execId: string) => {
      pendingExecs.set(execId, { room_id: roomId, participant_id: ownerId, sandbox_id: sandboxId });
      return sandboxId;
    }),
    assertExecReservation: vi.fn((roomId: string, ownerId: string, id: string, execId: string) => {
      const pending = pendingExecs.get(execId);
      if (
        !pending ||
        pending.room_id !== roomId ||
        pending.participant_id !== ownerId ||
        pending.sandbox_id !== id
      )
        throw new Error("missing reservation");
    }),
    pendingExec: vi.fn((execId: string) => {
      const pending = pendingExecs.get(execId);
      return pending ? { ...pending } : undefined;
    }),
    releaseExecReservation: vi.fn(async (execId: string) => {
      pendingExecs.delete(execId);
    }),
    startExec: vi.fn(async (input: { exec_id: string; onOutput: typeof output }) => {
      output = input.onOutput;
      const pending = pendingExecs.get(input.exec_id);
      pendingExecs.delete(input.exec_id);
      if (pending?.reason !== undefined)
        return {
          cancelled_by: pending.cancelled_by,
          finished: Promise.resolve({ exit_code: null, duration_ms: 0, reason: pending.reason }),
          cancel: async () => undefined,
        };
      return process;
    }),
    cancelExec: vi.fn(
      async (
        _roomId: string,
        _ownerId: string,
        execId: string,
        reason = "cancelled",
        cancelledBy?: string,
      ) => {
        const pending = pendingExecs.get(execId);
        if (pending) {
          pending.reason = reason;
          if (cancelledBy !== undefined) pending.cancelled_by = cancelledBy;
        }
        return true;
      },
    ),
  } as unknown as ExecutionServiceType;
  const logs = new MemoryLogStore();
  const chunks: SandboxOutputChunk[] = [];
  const append = logs.append.bind(logs);
  logs.append = async (id, chunk) => {
    chunks.push(chunk);
    await append(id, chunk);
  };
  registerSandboxExecCommands(dispatcher, execution, logs);
  return {
    roomId,
    participantId,
    sandboxId,
    definitions,
    finishedEvents,
    execution,
    logs,
    chunks,
    resolveFinished,
    get output() {
      return output;
    },
    pool: { query: vi.fn(async () => ({ rows: [{ settings }] })) },
  };
}

function prepareContext(s: ReturnType<typeof setup>): PrepareContext {
  return {
    pool: s.pool as never,
    room_id: s.roomId,
    principal: { participant_id: s.participantId, room_id: s.roomId },
  } as unknown as PrepareContext;
}

function cancelContext(
  s: ReturnType<typeof setup>,
  participantId: string,
  role: string,
  afterCommit: Array<() => void | Promise<void>>,
): CommandContext {
  return {
    room_id: s.roomId,
    principal: { participant_id: participantId },
    client: { query: async () => ({ rows: [{ role, authority: "MEMBER" }] }) },
    afterCommit: (callback: () => void | Promise<void>) => afterCommit.push(callback),
  } as unknown as CommandContext;
}

async function cancelAs(
  s: ReturnType<typeof setup>,
  command: CancelCommand,
  execId: `exec_${string}`,
  participantId: string,
  role: string,
) {
  const afterCommit: Array<() => void | Promise<void>> = [];
  const result = await command.execute(cancelContext(s, participantId, role, afterCommit), {
    exec_id: execId,
  });
  for (const callback of afterCommit) await callback();
  return result;
}

describe("sandbox.exec commands", () => {
  it("clamps timeouts and persists capped output as bounded, replayable chunks", async () => {
    const s = setup({ sandbox_exec_timeout_s: 3600 });
    const command = s.definitions[0] as ExecCommand;
    const params = { command: "private command", cwd: "src/../pkg", timeout_s: 99_999 };
    const prepared = await command.prepare!(prepareContext(s), params);
    const afterCommit: Array<() => void | Promise<void>> = [];
    const result = await command.execute(
      {
        room_id: s.roomId,
        principal: { participant_id: s.participantId },
        prepared,
        afterCommit: (callback: () => void | Promise<void>) => afterCommit.push(callback),
      } as unknown as CommandContext,
      params,
    );
    const execId = (result.response as { exec_id: string; timeout_s: number }).exec_id;
    expect(prepared).toMatchObject({ cwd: "/workspace/pkg", timeout_s: 3600 });
    expect(result.response).toMatchObject({ timeout_s: 3600 });
    expect(result.events).toEqual([{ type: "sandbox.exec.started", payload: { exec_id: execId } }]);
    await afterCommit[0]!();

    await s.output("stdout", Buffer.alloc(10 * 1024 * 1024 + 2, 65));
    expect(s.chunks.slice(0, 640).every((c) => c.kind === "data" && c.data.length <= 16_384)).toBe(
      true,
    );
    expect(s.chunks.at(-1)).toMatchObject({ kind: "truncated", cursor: 641 });
    s.resolveFinished({ exit_code: 0, duration_ms: 250, reason: "exit" });
    await vi.waitFor(async () => expect((await s.logs.get(execId))?.reason).toBe("exit"));
    expect(await s.logs.get(execId)).toMatchObject({
      command: params.command,
      output_bytes: 10 * 1024 * 1024,
      truncated: true,
    });
    expect(s.finishedEvents[0]).toMatchObject({
      type: "sandbox.exec.finished",
      payload: { exit_code: 0, log_ref: execId },
    });
  });

  it("falls back to 600 seconds for invalid ceilings and rejects cwd escapes", async () => {
    const s = setup({ sandbox_exec_timeout_s: 99_999 });
    const command = s.definitions[0] as ExecCommand;
    await expect(
      command.prepare!(prepareContext(s), { command: "echo ok", timeout_s: 900 }),
    ).resolves.toMatchObject({ timeout_s: 600 });
    for (const cwd of ["../other", "/tmp"])
      await expect(
        command.prepare!(prepareContext(s), { command: "echo ok", cwd }),
      ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("releases a prepared slot when the command rolls back", async () => {
    const s = setup();
    const command = s.definitions[0] as ExecCommand;
    const prepared = (await command.prepare!(prepareContext(s), {
      command: "echo ok",
    })) as { exec_id: string };
    expect(s.execution.pendingExec(prepared.exec_id)).toBeDefined();
    await command.disposePrepared!(prepared);
    expect(s.execution.pendingExec(prepared.exec_id)).toBeUndefined();
    expect(s.execution.releaseExecReservation).toHaveBeenCalledWith(prepared.exec_id);
  });

  it("hides another agent's exec, lets a lead cancel, and returns the final state", async () => {
    const s = setup();
    const command = s.definitions[1] as CancelCommand;
    const execId = newId("exec");
    await s.logs.create({
      exec_id: execId,
      room_id: s.roomId,
      sandbox_id: s.sandboxId,
      participant_id: s.participantId,
      command: "sleep 5",
      cwd: "/workspace",
      timeout_s: 600,
      started_at: new Date().toISOString(),
      output_bytes: 0,
      truncated: false,
    });
    await expect(cancelAs(s, command, execId, newId("part"), "DEVELOPER")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    const leadId = newId("part");
    const cancelled = (await cancelAs(s, command, execId, leadId, "LEAD")).response;
    expect(cancelled).toEqual({ exec_id: execId, cancelled: true });
    expect((await cancelAs(s, command, execId, leadId, "LEAD")).response).toEqual(cancelled);
    expect((await s.logs.get(execId))?.cancelled_by).toBe(leadId);
    expect(s.execution.cancelExec).toHaveBeenCalledWith(
      s.roomId,
      s.participantId,
      execId,
      "cancelled",
      leadId,
    );
    await s.logs.update(execId, {
      finished_at: new Date().toISOString(),
      exit_code: null,
      duration_ms: 12,
      reason: "cancelled",
    });
    const final = (await cancelAs(s, command, execId, leadId, "LEAD")).response;
    expect(final).toMatchObject({
      exec_id: execId,
      finished: true,
      exit_code: null,
      duration_ms: 12,
      reason: "cancelled",
    });
    expect(s.execution.cancelExec).toHaveBeenCalledTimes(1);
  });

  it("cancels a reserved exec before its private log or driver process exists", async () => {
    const s = setup();
    const startCommand = s.definitions[0] as ExecCommand;
    const cancelCommand = s.definitions[1] as CancelCommand;
    const params = { command: "sleep 5" };
    const prepared = await startCommand.prepare!(prepareContext(s), params);
    const afterCommit: Array<() => void | Promise<void>> = [];
    const started = await startCommand.execute(
      {
        room_id: s.roomId,
        principal: { participant_id: s.participantId },
        prepared,
        afterCommit: (callback: () => void | Promise<void>) => afterCommit.push(callback),
      } as unknown as CommandContext,
      params,
    );
    const execId = (started.response as { exec_id: `exec_${string}` }).exec_id;
    expect(await s.logs.get(execId)).toBeUndefined();

    const leadId = newId("part");
    expect((await cancelAs(s, cancelCommand, execId, leadId, "LEAD")).response).toEqual({
      exec_id: execId,
      cancelled: true,
    });
    expect(s.execution.cancelExec).toHaveBeenCalledWith(
      s.roomId,
      s.participantId,
      execId,
      "cancelled",
      leadId,
    );

    await afterCommit[0]!();
    await vi.waitFor(async () =>
      expect(await s.logs.get(execId)).toMatchObject({
        cancelled_by: leadId,
        finished_at: expect.any(String),
        reason: "cancelled",
      }),
    );
  });
});

describe("sandbox.exec capacity reservations", () => {
  it("allows eight concurrent starts and rejects the ninth before it emits a started event", async () => {
    const roomId = newId("room");
    const participantId = newId("part");
    await db.pool.query(
      "INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'Exec', 'Test', $2)",
      [roomId, participantId],
    );
    await db.pool.query(
      `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status)
       VALUES ($1, $2, 'AGENT', 'Developer', 'MEMBER', 'DEVELOPER', 'ACTIVE')`,
      [participantId, roomId],
    );

    const driver: ExecutionDriver = {
      create: async ({ sandbox_id }) => ({
        volume_ref: `volume:${sandbox_id}`,
        container_ref: `container:${sandbox_id}`,
      }),
      start: async () => undefined,
      stop: async () => undefined,
      destroy: async () => undefined,
      status: async () => ({ modified: [], added: [], deleted: [], truncated: false }),
      exec: async () => {
        let resolve!: (outcome: SandboxExecOutcome) => void;
        const promise = new Promise<SandboxExecOutcome>((done) => (resolve = done));
        return {
          finished: promise,
          cancel: async (reason) => resolve({ exit_code: null, duration_ms: 1, reason }),
        };
      },
    };
    const execution = new ExecutionService(db.pool, driver);
    const logs = new MemoryLogStore();
    const dispatcher = new Dispatcher({ pool: db.pool, authorize: allowAll, nodeId: roomId });
    registerSandboxExecCommands(dispatcher, execution, logs);
    const principal = {
      room_id: roomId,
      participant_id: participantId,
      kind: "AGENT" as const,
      authority: "MEMBER" as const,
      role: "DEVELOPER" as const,
    };
    const attempts = await Promise.allSettled(
      Array.from({ length: 9 }, () =>
        dispatcher.dispatch(principal, {
          id: newId("cmd"),
          method: "sandbox.exec",
          params: { command: "sleep 5" },
          idempotency_key: newId("cmd"),
        }),
      ),
    );
    const started = attempts.filter((attempt) => attempt.status === "fulfilled");
    const rejected = attempts.filter((attempt) => attempt.status === "rejected");
    expect(started).toHaveLength(8);
    expect(
      started
        .flatMap((attempt) => (attempt.status === "fulfilled" ? attempt.value.events : []))
        .filter((event) => event.type === "sandbox.exec.started"),
    ).toHaveLength(8);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      status: "rejected",
      reason: { code: "VALIDATION", details: { reason: "too_many_execs", maximum: 8 } },
    });
    const { rows } = await db.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM events WHERE room_id = $1 AND type = 'sandbox.exec.started'",
      [roomId],
    );
    expect(Number(rows[0]?.count)).toBe(8);

    await execution.cancelAllExecs("sandbox_stopped");
    await vi.waitFor(async () => {
      const result = await db.pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM events WHERE room_id = $1 AND type = 'sandbox.exec.finished'",
        [roomId],
      );
      expect(Number(result.rows[0]?.count)).toBe(8);
    });
  });
});
