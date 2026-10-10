import type {
  CommandContext,
  CommandDefinition,
  Dispatcher,
  PrepareContext,
} from "@crossover/kernel";
import { newId } from "@crossover/protocol";
import { describe, expect, it, vi } from "vitest";
import type { ExecutionService, SandboxExecOutcome, SandboxExecProcess } from "./execution.js";
import { MemoryLogStore } from "./sandbox-log-store.js";
import type { SandboxOutputChunk } from "./sandbox-log-store.js";
import { registerSandboxExecCommands } from "./sandbox-exec.js";
import type { sandboxExecCancelParamsSchema, sandboxExecParamsSchema } from "./sandbox-exec.js";

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
  const execution = {
    assertExecCapacity: vi.fn(async () => sandboxId),
    assertExecCapacityFor: vi.fn(),
    startExec: vi.fn(async (input: { onOutput: typeof output }) => {
      output = input.onOutput;
      return process;
    }),
    cancelExec: vi.fn(async () => true),
  } as unknown as ExecutionService;
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
    expect(s.execution.cancelExec).toHaveBeenCalledWith(s.roomId, s.participantId, execId);
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
});
