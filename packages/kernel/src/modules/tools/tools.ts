import { CrossoverError } from "@crossover/protocol";
import { z } from "zod";
import type { Dispatcher, EmittedEvent } from "../../dispatcher.js";
import {
  capabilityFor,
  ToolProviderError,
  type ToolDefinition,
  type ToolOutput,
  type ToolRegistry,
  type ToolRunner,
} from "./registry.js";

export const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
export const MAX_TOOL_ARGS_BYTES = 64 * 1024;
export const MAX_TOOL_RESULT_BYTES = 256 * 1024;

export const toolsInvokeParams = z.strictObject({
  tool: z.string().min(1).max(100),
  args: z
    .record(z.string(), z.unknown())
    .default({})
    .refine((a) => Buffer.byteLength(JSON.stringify(a)) <= MAX_TOOL_ARGS_BYTES, {
      message: `Arguments are at most ${MAX_TOOL_ARGS_BYTES} bytes`,
    }),
});

export const toolsListParams = z.strictObject({});

export interface ToolCommandsOptions {
  registry: ToolRegistry;
  /** Runs the tools (the plugin runner, T1202). Without one, an invocation is `PROVIDER_UNAVAILABLE`. */
  runner?: ToolRunner;
  /** Give up on one invocation after this long. Default 60 s. */
  timeoutMs?: number;
}

interface Run {
  def: ToolDefinition;
  args: Record<string, unknown>;
  capability: string;
  output: ToolOutput;
  duration_ms: number;
}

/** What `prepare` hands to `execute`: the finished run, or the fact that it wasn't allowed to start. */
type Prepared = { run: Run } | { denied: true };

const view = (def: ToolDefinition) => ({
  name: def.name,
  description: def.description,
  capability: def.capability,
  tier: def.tier,
  idempotent: def.idempotent,
  input_schema: (() => {
    try {
      return z.toJSONSchema(def.input);
    } catch {
      return null;
    }
  })(),
});

/**
 * Register `tools.list` and `tools.invoke` (T1201, §21.4).
 *
 * - **list** returns the tools the caller holds the capability for (any scope of it), each with
 *   its tier and an input schema.
 * - **invoke { tool, args }** validates `args` against the tool's schema, authorizes
 *   `<capability>:<scope>` (the scope derived from the arguments by the tool: a repository, a
 *   function ARN), and runs the tool through the {@link ToolRunner}. Not holding the capability,
 *   or holding it for another scope, is `FORBIDDEN` naming it (and a `capability.denied` event).
 *   The run happens in the command's `prepare` phase, so a slow tool doesn't hold the room, and
 *   `execute` checks the authorization again. **The platform never retries a tool**, idempotent
 *   or not; the same idempotency key replays the stored result instead of running it again. A
 *   failing provider is `PROVIDER_UNAVAILABLE` (retryable when the runner says so, and for a
 *   timeout). Tier 2 and 3 invocations are logged: `tool.invoked` before the run, then
 *   `tool.completed` or `tool.failed` (no arguments, no result, no credentials in them). A result
 *   with text from outside is labeled `trust: external`. An invocation that waited for approval
 *   (§22.2) runs inside `execute` instead.
 */
export function registerToolCommands(dispatcher: Dispatcher, options: ToolCommandsOptions): void {
  const { registry, runner } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;

  dispatcher.registerCommand({
    method: "tools.list",
    action: "tools.read",
    mutating: false,
    view: "participant",
    params: toolsListParams,
    execute: async (ctx) => {
      const tools: ReturnType<typeof view>[] = [];
      for (const def of registry.list()) {
        try {
          await ctx.authorize(def.capability, {}, { anyScope: true });
          tools.push(view(def));
        } catch (error) {
          // Not holding it just means it isn't listed (and nothing is recorded for that).
          if (!(error instanceof CrossoverError) || error.code !== "FORBIDDEN") throw error;
        }
      }
      return { response: { tools } };
    },
  });

  async function execTool(
    def: ToolDefinition,
    args: Record<string, unknown>,
    capability: string,
    who: { room_id: string; participant_id: string; invocation_id: string },
  ): Promise<Run> {
    if (!runner) {
      throw new CrossoverError("PROVIDER_UNAVAILABLE", "No tool runner is configured", {
        retryable: false,
      });
    }
    const controller = new AbortController();
    const started = Date.now();
    let timer: NodeJS.Timeout | undefined;
    try {
      const output = await Promise.race([
        runner.run({ tool: def.name, args, capability, ...who }, controller.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new ToolProviderError(`${def.name} timed out`, { retryable: true }));
          }, timeoutMs);
        }),
      ]);
      const size = Buffer.byteLength(JSON.stringify(output.result ?? null));
      if (size > MAX_TOOL_RESULT_BYTES) {
        throw new ToolProviderError(`${def.name} returned more than the limit allows`, {
          retryable: false,
        });
      }
      return { def, args, capability, output, duration_ms: Date.now() - started };
    } catch (error) {
      if (error instanceof CrossoverError) throw error;
      if (error instanceof ToolProviderError) {
        throw new CrossoverError("PROVIDER_UNAVAILABLE", error.message, {
          retryable: error.options.retryable,
          details: { tool: def.name },
        });
      }
      // What a runner throws by accident may carry anything: say only that it failed.
      throw new CrossoverError("PROVIDER_UNAVAILABLE", `${def.name} failed`, {
        retryable: false,
        details: { tool: def.name },
      });
    } finally {
      clearTimeout(timer);
    }
  }

  const parseArgs = (def: ToolDefinition, args: Record<string, unknown>) => {
    const parsed = def.input.safeParse(args);
    if (!parsed.success) {
      throw new CrossoverError("VALIDATION", `Invalid arguments for ${def.name}`, {
        details: { tool: def.name, issues: parsed.error.issues },
      });
    }
    return parsed.data as Record<string, unknown>;
  };

  dispatcher.registerCommand({
    method: "tools.invoke",
    action: "tools.read", // everyone may ask; what the tool needs is checked on the tool's own capability
    mutating: true,
    params: toolsInvokeParams,
    prepare: async (ctx, p): Promise<Prepared | undefined> => {
      const def = registry.get(p.tool);
      if (!def) return undefined; // `execute` says NOT_FOUND
      const args = parseArgs(def, p.args);
      const capability = capabilityFor(def, args);
      if (!(await ctx.isAllowed(capability))) return { denied: true }; // `execute` refuses, and records it
      const who = {
        room_id: ctx.room_id,
        participant_id: ctx.principal.participant_id,
        invocation_id: ctx.command_id,
      };
      const note = (type: "tool.invoked" | "tool.failed", extra: Record<string, unknown> = {}) =>
        dispatcher
          .runSystem(
            ctx.room_id,
            type,
            async () => ({
              result: null,
              events: [
                {
                  type,
                  actor_id: ctx.principal.participant_id,
                  payload: {
                    tool: def.name,
                    invocation_id: ctx.command_id,
                    capability,
                    tier: def.tier,
                    ...extra,
                  },
                } satisfies EmittedEvent & { actor_id: string },
              ],
            }),
            { whenFrozen: () => null },
          )
          .catch(() => undefined);
      if (def.tier >= 2) await note("tool.invoked");
      try {
        return { run: await execTool(def, args, capability, who) };
      } catch (error) {
        if (def.tier >= 2) {
          await note("tool.failed", {
            reason: error instanceof CrossoverError ? error.code : "ERROR",
            retryable: error instanceof CrossoverError ? error.retryable : false,
          });
        }
        throw error;
      }
    },
    execute: async (ctx, p) => {
      const def = registry.get(p.tool);
      if (!def) throw new CrossoverError("NOT_FOUND", `Tool ${p.tool} not found`);
      const args = parseArgs(def, p.args);
      const capability = capabilityFor(def, args);
      // The real check, in the transaction: a refusal is recorded as `capability.denied`, and a
      // gate asks for approval.
      await ctx.authorize(capability);
      const prepared = ctx.prepared as Prepared | undefined;
      if (prepared && "denied" in prepared) {
        throw new CrossoverError(
          "CONFLICT_VERSION",
          "Permissions changed while the request was checked; retry",
          {
            details: { reason: "permissions_changed" },
          },
        );
      }
      const events: EmittedEvent[] = [];
      let run = prepared?.run;
      if (!run) {
        // No prepare phase ran (an approved request): run it here, in the transaction.
        if (def.tier >= 2) {
          events.push({
            type: "tool.invoked",
            payload: { tool: def.name, invocation_id: ctx.command_id, capability, tier: def.tier },
          });
        }
        run = await execTool(def, args, capability, {
          room_id: ctx.room_id,
          participant_id: ctx.principal.participant_id,
          invocation_id: ctx.command_id,
        });
      }
      const trust = run.output.external ? "external" : "system";
      if (def.tier >= 2) {
        events.push({
          type: "tool.completed",
          payload: {
            tool: def.name,
            invocation_id: ctx.command_id,
            capability,
            tier: def.tier,
            duration_ms: run.duration_ms,
            trust,
          },
        });
      }
      return {
        response: {
          tool: def.name,
          result: run.output.result ?? null,
          provenance: { author_id: "system", author_kind: "SYSTEM", trust },
        },
        events,
      };
    },
  });
}
