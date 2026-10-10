import type { Dispatcher, EmittedEvent, PrepareContext } from "@crossover/kernel";
import { CrossoverError, isId, newId } from "@crossover/protocol";
import { resolve, relative, isAbsolute, sep } from "node:path";
import { z } from "zod";
import type { ExecutionService, SandboxExecOutcome } from "./execution.js";
import type {
  LogStore,
  SandboxExecLogMetadata,
  SandboxOutputChunk,
  SandboxOutputHub,
} from "./sandbox-log-store.js";

const DEFAULT_TIMEOUT_S = 600;
const MAX_TIMEOUT_S = 3600;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const OUTPUT_CHUNK_BYTES = 16 * 1024;
const MAX_COMMAND_LENGTH = 128 * 1024;
const MAX_CWD_LENGTH = 4096;

export const sandboxExecParamsSchema = z.strictObject({
  command: z
    .string()
    .min(1)
    .max(MAX_COMMAND_LENGTH)
    .refine((value) => !value.includes("\0"), "Command must not contain NUL"),
  cwd: z.string().max(MAX_CWD_LENGTH).optional(),
  timeout_s: z.number().int().safe().positive().optional(),
});

export const sandboxExecCancelParamsSchema = z.strictObject({
  exec_id: z.string().refine((value) => isId(value, "exec"), "expected an exec_ ID"),
});

type SandboxExecParams = z.infer<typeof sandboxExecParamsSchema>;

interface PreparedExec {
  exec_id: string;
  sandbox_id: string;
  cwd: string;
  timeout_s: number;
}

export interface SandboxExecCommandDeps {
  outputHub?: SandboxOutputHub;
}

export function registerSandboxExecCommands(
  dispatcher: Dispatcher,
  execution: ExecutionService,
  logs: LogStore,
  deps: SandboxExecCommandDeps = {},
): void {
  dispatcher.registerCommand({
    method: "sandbox.exec",
    action: "sandbox.exec",
    mutating: true,
    params: sandboxExecParamsSchema,
    prepare: async (ctx, params) => prepareExec(ctx, params, execution),
    disposePrepared: async (prepared) => {
      const exec = prepared as PreparedExec | undefined;
      if (exec) await execution.releaseExecReservation(exec.exec_id);
    },
    execute: async (ctx, params) => {
      const prepared = ctx.prepared as PreparedExec | undefined;
      if (!prepared) throw new CrossoverError("UNAVAILABLE", "Sandbox execution was not prepared");
      execution.assertExecReservation(
        ctx.room_id,
        ctx.principal.participant_id,
        prepared.sandbox_id,
        prepared.exec_id,
      );
      const execId = prepared.exec_id;
      const response = { exec_id: execId, timeout_s: prepared.timeout_s };
      const events: EmittedEvent[] = [
        { type: "sandbox.exec.started", payload: { exec_id: execId } },
      ];
      ctx.afterCommit(() =>
        startPreparedExec(
          dispatcher,
          execution,
          logs,
          deps.outputHub,
          ctx.room_id,
          ctx.principal.participant_id,
          params.command,
          prepared,
        ),
      );
      return { response, events };
    },
  });

  dispatcher.registerCommand<typeof sandboxExecCancelParamsSchema, unknown>({
    method: "sandbox.exec.cancel",
    action: "sandbox.output",
    mutating: true,
    params: sandboxExecCancelParamsSchema,
    execute: async (ctx, params) => {
      const metadata = await logs.get(params.exec_id);
      const pending = metadata ? undefined : execution.pendingExec(params.exec_id);
      const target = metadata ?? pending;
      if (!target || target.room_id !== ctx.room_id) {
        throw new CrossoverError("NOT_FOUND", "Sandbox execution not found");
      }
      if (target.participant_id !== ctx.principal.participant_id) {
        const { rows } = await ctx.client.query<{ role: string; authority: string }>(
          `SELECT role, authority FROM participants
           WHERE id = $1 AND room_id = $2 AND status = 'ACTIVE'`,
          [ctx.principal.participant_id, ctx.room_id],
        );
        const actor = rows[0];
        if (
          !actor ||
          (actor.role !== "LEAD" && actor.authority !== "OWNER" && actor.authority !== "ADMIN")
        )
          throw new CrossoverError("NOT_FOUND", "Sandbox execution not found");
      }
      if (metadata?.finished_at !== undefined) {
        return {
          response: {
            exec_id: params.exec_id,
            finished: true,
            exit_code: metadata.exit_code ?? null,
            duration_ms: metadata.duration_ms ?? null,
            reason: metadata.reason ?? null,
          },
        };
      }
      if (metadata?.cancelled_by !== undefined || pending?.reason !== undefined)
        return { response: { exec_id: params.exec_id, cancelled: true } };
      ctx.afterCommit(async () => {
        try {
          const cancelled = await execution.cancelExec(
            ctx.room_id,
            target.participant_id,
            params.exec_id,
            "cancelled",
            ctx.principal.participant_id,
          );
          if (cancelled && (await logs.get(params.exec_id)))
            await logs.update(params.exec_id, { cancelled_by: ctx.principal.participant_id });
        } catch (error) {
          console.error("Failed to cancel sandbox exec", error);
        }
      });
      return { response: { exec_id: params.exec_id, cancelled: true } };
    },
  });
}

async function prepareExec(
  ctx: PrepareContext,
  params: SandboxExecParams,
  execution: ExecutionService,
): Promise<PreparedExec> {
  const { rows } = await ctx.pool.query<{ settings: unknown }>(
    "SELECT settings FROM rooms WHERE id = $1",
    [ctx.room_id],
  );
  if (!rows[0]) throw new CrossoverError("NOT_FOUND", "Room not found");
  const settings = rows[0].settings;
  const configuredCeiling =
    typeof settings === "object" && settings !== null && !Array.isArray(settings)
      ? (settings as Record<string, unknown>)["sandbox_exec_timeout_s"]
      : undefined;
  const ceiling =
    Number.isSafeInteger(configuredCeiling) &&
    (configuredCeiling as number) >= 1 &&
    (configuredCeiling as number) <= MAX_TIMEOUT_S
      ? (configuredCeiling as number)
      : DEFAULT_TIMEOUT_S;
  const requested = params.timeout_s ?? DEFAULT_TIMEOUT_S;
  const timeout_s = Math.min(requested, ceiling, MAX_TIMEOUT_S);
  const cwd = normalizeSandboxCwd(params.cwd);
  const exec_id = newId("exec");
  const sandbox_id = await execution.reserveExec(
    ctx.room_id,
    ctx.principal.participant_id,
    exec_id,
  );
  return {
    exec_id,
    sandbox_id,
    cwd,
    timeout_s,
  };
}

function normalizeSandboxCwd(cwd: string | undefined): string {
  if (cwd?.includes("\0")) throw new CrossoverError("VALIDATION", "cwd must not contain NUL");
  const workspace = "/workspace";
  const normalized = resolve(workspace, cwd ?? ".");
  const fromWorkspace = relative(workspace, normalized);
  if (fromWorkspace === ".." || fromWorkspace.startsWith(`..${sep}`) || isAbsolute(fromWorkspace))
    throw new CrossoverError("VALIDATION", "cwd must stay inside the caller's sandbox");
  return normalized;
}

async function startPreparedExec(
  dispatcher: Dispatcher,
  execution: ExecutionService,
  logs: LogStore,
  outputHub: SandboxOutputHub | undefined,
  roomId: string,
  participantId: string,
  command: string,
  prepared: PreparedExec,
): Promise<void> {
  const startedAt = new Date();
  const pending = execution.pendingExec(prepared.exec_id);
  const metadata: SandboxExecLogMetadata = {
    exec_id: prepared.exec_id,
    room_id: roomId,
    sandbox_id: prepared.sandbox_id,
    participant_id: participantId,
    command,
    cwd: prepared.cwd,
    timeout_s: prepared.timeout_s,
    started_at: startedAt.toISOString(),
    output_bytes: 0,
    truncated: false,
    ...(pending?.cancelled_by !== undefined ? { cancelled_by: pending.cancelled_by } : {}),
  };
  let cursor = 0;
  let outputBytes = 0;
  let truncated = false;
  const finish = async (outcome: SandboxExecOutcome): Promise<void> => {
    const finishedAt = new Date().toISOString();
    const exitCode = outcome.reason === "exit" ? outcome.exit_code : null;
    try {
      await logs.update(prepared.exec_id, {
        finished_at: finishedAt,
        exit_code: exitCode,
        duration_ms: outcome.duration_ms,
        reason: outcome.reason,
        output_bytes: outputBytes,
        truncated,
      });
      const finalMetadata = await logs.get(prepared.exec_id);
      if (finalMetadata) outputHub?.publishFinished(prepared.exec_id, finalMetadata);
    } catch (error) {
      console.error("Failed to finalize sandbox exec log", error);
    }
    try {
      await dispatcher.runSystem(roomId, "sandbox.exec.finished", async () => ({
        result: undefined,
        events: [
          {
            type: "sandbox.exec.finished",
            actor_id: "system",
            payload: {
              exec_id: prepared.exec_id,
              exit_code: exitCode,
              duration_ms: outcome.duration_ms,
              log_ref: prepared.exec_id,
            },
          },
        ],
      }));
    } catch (error) {
      console.error("Failed to record sandbox exec completion", error);
    }
  };

  const onOutput = async (stream: "stdout" | "stderr", value: Buffer): Promise<void> => {
    let offset = 0;
    const retain = Math.min(value.byteLength, MAX_OUTPUT_BYTES - outputBytes);
    let wrote = false;
    while (offset < retain) {
      const end = Math.min(offset + OUTPUT_CHUNK_BYTES, retain);
      const chunk: SandboxOutputChunk = {
        cursor: ++cursor,
        kind: "data",
        stream,
        data: Buffer.from(value.subarray(offset, end)),
      };
      await logs.append(prepared.exec_id, chunk);
      outputHub?.publish(prepared.exec_id, chunk);
      wrote = true;
      outputBytes += end - offset;
      offset = end;
    }
    if (retain < value.byteLength && !truncated) {
      const marker: SandboxOutputChunk = { cursor: ++cursor, kind: "truncated" };
      await logs.append(prepared.exec_id, marker);
      outputHub?.publish(prepared.exec_id, marker);
      truncated = true;
      wrote = true;
    }
    if (wrote) await logs.update(prepared.exec_id, { output_bytes: outputBytes, truncated });
  };

  try {
    await logs.create(metadata);
    const process = await execution.startExec({
      room_id: roomId,
      participant_id: participantId,
      exec_id: prepared.exec_id,
      command,
      cwd: prepared.cwd,
      timeoutMs: prepared.timeout_s * 1000,
      onOutput,
    });
    if (process.cancelled_by !== undefined)
      await logs.update(prepared.exec_id, { cancelled_by: process.cancelled_by });
    void process.finished.then(finish, (error: unknown) => {
      console.error("Sandbox exec process failed", error);
      return finish({
        exit_code: null,
        duration_ms: Date.now() - startedAt.getTime(),
        reason: "start_failed",
      });
    });
  } catch (error) {
    console.error("Failed to start sandbox exec", error);
    await finish({
      exit_code: null,
      duration_ms: Date.now() - startedAt.getTime(),
      reason: "start_failed",
    });
  }
}
