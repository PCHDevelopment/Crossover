import type { Pool, PoolClient } from "@crossover/db";
import { hashRequest, IDEMPOTENCY_TTL_HOURS } from "@crossover/ledger";
import { loadLiveGrants } from "@crossover/policy";
import { CrossoverError, type ErrorCode } from "@crossover/protocol";
import { z } from "zod";
import type { Dispatcher, EmittedEvent } from "../../dispatcher.js";
import {
  capabilityFor,
  scopeOf,
  ToolProviderError,
  type ToolDefinition,
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

/** What a run came to, kept under the idempotency key. */
interface OutcomeError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}
type Outcome =
  | { ok: true; result: unknown; duration_ms: number }
  | { ok: false; error: OutcomeError; duration_ms: number };

/** What `prepare` hands to `execute`: it wasn't allowed to start, or what the run came to. */
type Prepared =
  { denied: true } | { outcome: Outcome; capability: string; scope: string | undefined };

const STALE_AFTER_MS = 15_000; // a claim this much older than the timeout belongs to a dead process

const view = (def: ToolDefinition, requiresApproval: boolean) => ({
  name: def.name,
  description: def.description,
  capability: def.capability,
  tier: def.tier,
  idempotent: def.idempotent,
  requires_approval: requiresApproval,
  input_schema: (() => {
    try {
      return z.toJSONSchema(def.input);
    } catch {
      return null;
    }
  })(),
});

const unknownTool = () =>
  new CrossoverError("FORBIDDEN", "You can't invoke that tool", {
    details: { reason: "not_permitted" },
  });

interface Claimant {
  participant_id: string;
  key: string;
  hash: string;
  room_id: string;
  tool: string;
}

type Claim = { claimed: true } | { claimed: false; outcome: Outcome };

/**
 * Take the idempotency key for a tool run BEFORE its side effect, in a short transaction of its
 * own (`tool_invocations`): a second request with the same key while the first runs is `in
 * progress` (retryable), with another request's hash it is the key-reuse error, and once the run
 * has an outcome that outcome is replayed without running the tool.
 */
async function claimRun(
  pool: Pool,
  who: Claimant,
  def: ToolDefinition,
  timeoutMs: number,
): Promise<Claim> {
  const { rowCount } = await pool.query(
    `INSERT INTO tool_invocations (participant_id, idempotency_key, request_hash, room_id, tool)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (participant_id, idempotency_key) DO UPDATE
       SET request_hash = EXCLUDED.request_hash, room_id = EXCLUDED.room_id, tool = EXCLUDED.tool,
           claimed_at = clock_timestamp(), outcome = NULL
       WHERE tool_invocations.claimed_at < clock_timestamp() - make_interval(hours => $6)`,
    [who.participant_id, who.key, who.hash, who.room_id, who.tool, IDEMPOTENCY_TTL_HOURS],
  );
  if ((rowCount ?? 0) > 0) return { claimed: true };
  const { rows } = await pool.query<{
    request_hash: string;
    outcome: Outcome | null;
    age_ms: number;
    claimed_at: Date;
  }>(
    `SELECT request_hash, outcome, claimed_at,
            extract(epoch FROM clock_timestamp() - claimed_at) * 1000 AS age_ms
     FROM tool_invocations WHERE participant_id = $1 AND idempotency_key = $2`,
    [who.participant_id, who.key],
  );
  const row = rows[0];
  if (!row) throw new CrossoverError("CONFLICT_VERSION", "Try again", { retryable: true });
  if (row.request_hash !== who.hash) {
    throw new CrossoverError(
      "VALIDATION",
      "Idempotency key was already used with a different request",
      { details: { idempotency_key: who.key } },
    );
  }
  if (row.outcome) return { claimed: false, outcome: row.outcome };
  if (row.age_ms > timeoutMs + STALE_AFTER_MS) {
    // The process that claimed it is gone. A tool that is safe to repeat is taken over; for any
    // other, whether it happened is unknown, and that is what a retry is told.
    if (def.idempotent) {
      const { rowCount: took } = await pool.query(
        `UPDATE tool_invocations SET claimed_at = clock_timestamp()
         WHERE participant_id = $1 AND idempotency_key = $2 AND outcome IS NULL AND claimed_at = $3`,
        [who.participant_id, who.key, row.claimed_at],
      );
      if ((took ?? 0) > 0) return { claimed: true };
    } else {
      const outcome = unknownOutcome(def, "The tool's process was lost while it ran");
      await recordOutcome(pool, who, outcome);
      return { claimed: false, outcome };
    }
  }
  throw new CrossoverError("CONFLICT_VERSION", "That invocation is still running", {
    retryable: true,
    details: { reason: "in_progress", retry_after: 5 },
  });
}

const recordOutcome = (pool: Pool, who: Claimant, outcome: Outcome) =>
  pool.query(
    `UPDATE tool_invocations SET outcome = $3::jsonb
     WHERE participant_id = $1 AND idempotency_key = $2 AND outcome IS NULL`,
    [who.participant_id, who.key, JSON.stringify(outcome)],
  );

const releaseClaim = (pool: Pool, who: Claimant) =>
  pool.query(
    "DELETE FROM tool_invocations WHERE participant_id = $1 AND idempotency_key = $2 AND outcome IS NULL",
    [who.participant_id, who.key],
  );

function unknownOutcome(def: ToolDefinition, message: string): Outcome {
  return {
    ok: false,
    duration_ms: 0,
    error: {
      code: "PROVIDER_UNAVAILABLE",
      message,
      retryable: def.idempotent,
      details: { tool: def.name, ...(def.idempotent ? {} : { outcome: "unknown" }) },
    },
  };
}

/** Whether the caller holds a gated grant of the capability for some scope (such a grant isn't an ordinary one). */
async function holdsGatedScope(
  db: Pool | PoolClient,
  room_id: string,
  participant_id: string,
  capability: string,
): Promise<boolean> {
  const { grants, denies } = await loadLiveGrants(db, room_id, participant_id);
  const covers = (c: string) => c === capability || c.startsWith(`${capability}:`);
  return (
    grants.some((g) => g.requires_approval && covers(g.capability)) &&
    !denies.some((d) => d.capability === capability)
  );
}

/**
 * Register `tools.list` and `tools.invoke` (T1201, §21.4).
 *
 * - **list** returns the tools the caller holds the capability for (any scope of it), each with
 *   its tier, an input schema and `requires_approval` (a gated grant lists the tool: a read is
 *   never answered with `APPROVAL_REQUIRED`).
 * - **invoke { tool, args }** authorizes `<capability>:<scope>` (the scope derived from the
 *   arguments, in canonical form: no `..`, `%`, `?`, `#`, `\` and the like), and runs the tool
 *   through the {@link ToolRunner}, which acts only on that scope. Not holding the capability, or
 *   holding it for another scope, is `FORBIDDEN` naming it (and a `capability.denied` event); an
 *   unknown tool is the same `FORBIDDEN`, so that the answer doesn't say which tools exist.
 *
 * **Exactly once.** The run happens in the command's `prepare` phase (a slow tool doesn't hold
 * the room), and the idempotency key is **claimed before the tool runs** (`tool_invocations`):
 * the same key while it runs is `CONFLICT_VERSION` "in progress", another request under it is the
 * key-reuse error. Once the tool has run, **the outcome is recorded under the key whatever
 * happens next** (no re-authorization: a revoked grant or a frozen room stops *future*
 * invocations, not the recording of one that ran), and a retry replays it. A failure the runner
 * says is retryable (known to have happened before any effect) releases the key; a timeout or
 * other doubtful failure of a tool that isn't idempotent is `retryable: false` with
 * `details.outcome: "unknown"` and is replayed as such. **The platform never retries a tool.**
 * Tier 2 and 3 invocations are logged: `tool.invoked` before the run (for tier 3 the run doesn't
 * start unless it was written), then `tool.completed` or `tool.failed` (no arguments, no result,
 * no credentials). A tool's result is always labeled `trust: external` (§16.5).
 *
 * **Approval** (§22.2): an approved `tools.invoke` doesn't run inside the approver's
 * transaction; the approval lifts the gate for the requester's retry of the same request (same
 * idempotency key and arguments), which then runs as above.
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
          tools.push(view(def, false));
        } catch (error) {
          if (!(error instanceof CrossoverError)) throw error;
          if (
            error.code === "APPROVAL_REQUIRED" ||
            (error.code === "FORBIDDEN" &&
              (await holdsGatedScope(
                ctx.client,
                ctx.room_id,
                ctx.principal.participant_id,
                def.capability,
              )))
          ) {
            tools.push(view(def, true));
          } else if (error.code !== "FORBIDDEN") {
            throw error;
          }
          // Not holding it just means it isn't listed (and nothing is recorded for that).
        }
      }
      return { response: { tools } };
    },
  });

  async function execTool(
    def: ToolDefinition,
    args: Record<string, unknown>,
    capability: string,
    scope: string | undefined,
    who: { room_id: string; participant_id: string; invocation_id: string },
  ): Promise<Outcome> {
    const controller = new AbortController();
    const started = Date.now();
    let timer: NodeJS.Timeout | undefined;
    const failed = (error: OutcomeError): Outcome => ({
      ok: false,
      error,
      duration_ms: Date.now() - started,
    });
    try {
      const output = await Promise.race([
        runner!.run({ tool: def.name, args, capability, scope, ...who }, controller.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new TimedOut());
          }, timeoutMs);
        }),
      ]);
      const result = output.result ?? null;
      if (Buffer.byteLength(JSON.stringify(result)) > MAX_TOOL_RESULT_BYTES) {
        return failed({
          code: "PROVIDER_UNAVAILABLE",
          message: `${def.name} returned more than the limit allows`,
          retryable: false,
          details: { tool: def.name, ...(def.idempotent ? {} : { outcome: "unknown" }) },
        });
      }
      return { ok: true, result, duration_ms: Date.now() - started };
    } catch (error) {
      if (error instanceof TimedOut) {
        // It may still finish what it started: only a tool that is safe to repeat may be retried.
        return failed({
          code: "PROVIDER_UNAVAILABLE",
          message: `${def.name} timed out`,
          retryable: def.idempotent,
          details: { tool: def.name, ...(def.idempotent ? {} : { outcome: "unknown" }) },
        });
      }
      if (error instanceof ToolProviderError) {
        return failed({
          code: "PROVIDER_UNAVAILABLE",
          message: error.message,
          retryable: error.options.retryable,
          details: { tool: def.name },
        });
      }
      // What a runner throws by accident may carry anything: say only that it failed.
      return failed({
        code: "PROVIDER_UNAVAILABLE",
        message: `${def.name} failed`,
        retryable: false,
        details: { tool: def.name, ...(def.idempotent ? {} : { outcome: "unknown" }) },
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
    approvalLiftsGate: true,
    params: toolsInvokeParams,
    prepare: async (ctx, p): Promise<Prepared | undefined> => {
      const def = registry.get(p.tool);
      if (!def) return undefined; // `execute` says FORBIDDEN
      // Who may use the tool at all, before anything about its arguments is said.
      const holds =
        (await ctx.isAllowed(def.capability, {}, { anyScope: true })) ||
        (await holdsGatedScope(
          ctx.pool,
          ctx.room_id,
          ctx.principal.participant_id,
          def.capability,
        ));
      if (!holds) return { denied: true };
      const args = parseArgs(def, p.args);
      const scope = scopeOf(def, args);
      const capability = capabilityFor(def, args);
      if (!(await ctx.isAllowed(capability))) return { denied: true }; // `execute` refuses, and records it
      if (!runner) {
        throw new CrossoverError("PROVIDER_UNAVAILABLE", "No tool runner is configured", {
          retryable: false,
        });
      }
      let hash: string;
      try {
        hash = hashRequest({ room_id: ctx.room_id, method: "tools.invoke", params: p });
      } catch {
        throw new CrossoverError("VALIDATION", "params must be plain JSON data");
      }
      const who: Claimant = {
        participant_id: ctx.principal.participant_id,
        key: ctx.idempotency_key,
        hash,
        room_id: ctx.room_id,
        tool: def.name,
      };
      const claim = await claimRun(ctx.pool, who, def, timeoutMs);
      if (!claim.claimed) return { outcome: claim.outcome, capability, scope };

      const note = (type: "tool.invoked" | "tool.failed", extra: Record<string, unknown> = {}) =>
        dispatcher.runSystem(
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
          // A frozen room takes no event; for tier 3 that means the tool doesn't run.
          def.tier >= 3 ? {} : { whenFrozen: () => null },
        );
      if (def.tier >= 2) {
        try {
          await note("tool.invoked");
        } catch (error) {
          if (def.tier >= 3) {
            // Fail closed: no record that it started, no run.
            await releaseClaim(ctx.pool, who).catch(() => undefined);
            throw error instanceof CrossoverError
              ? error
              : new CrossoverError("STALE_FENCE", "Couldn't record the invocation; retry it", {
                  retryable: true,
                });
          }
        }
      }
      const outcome = await execTool(def, args, capability, scope, {
        room_id: ctx.room_id,
        participant_id: ctx.principal.participant_id,
        invocation_id: ctx.command_id,
      });
      // Recorded whatever comes next. A failure the tool may be retried after leaves no claim.
      try {
        if (!outcome.ok && outcome.error.retryable) await releaseClaim(ctx.pool, who);
        else await recordOutcome(ctx.pool, who, outcome);
      } catch (error) {
        // The outcome can't be kept: the key stays claimed, and a retry is told it's in progress,
        // then (for a tool that isn't idempotent) that the outcome is unknown.
        throw new CrossoverError("STALE_FENCE", "The result couldn't be recorded; retry later", {
          retryable: true,
          cause: error,
        });
      }
      if (!outcome.ok && def.tier >= 2) {
        await note("tool.failed", {
          reason: outcome.error.code,
          retryable: outcome.error.retryable,
        }).catch(() => undefined);
      }
      return { outcome, capability, scope };
    },
    execute: async (ctx, p) => {
      const def = registry.get(p.tool);
      if (!def) throw unknownTool();
      const prepared = ctx.prepared as Prepared | undefined;
      if (!prepared || "denied" in prepared) {
        // Not allowed to start (or no run was made): the real check, which refuses and records it
        // or, for a gate, asks for approval.
        try {
          await ctx.authorize(def.capability, {}, { anyScope: true });
        } catch (error) {
          const gated =
            error instanceof CrossoverError &&
            (error.code === "APPROVAL_REQUIRED" ||
              (error.code === "FORBIDDEN" &&
                (await holdsGatedScope(
                  ctx.client,
                  ctx.room_id,
                  ctx.principal.participant_id,
                  def.capability,
                ))));
          if (!gated) throw error;
        }
        const args = parseArgs(def, p.args);
        await ctx.authorize(capabilityFor(def, args));
        throw new CrossoverError(
          "CONFLICT_VERSION",
          "Permissions changed while the request was checked; retry",
          { details: { reason: "permissions_changed" }, retryable: true },
        );
      }
      // It ran (now, or on an earlier attempt whose result couldn't be committed): what it came
      // to is what the key stands for. Not re-authorized: that decides *future* invocations.
      const { outcome, capability } = prepared;
      if (!outcome.ok) {
        const { code, message, retryable, details } = outcome.error;
        throw new CrossoverError(code, message, { retryable, ...(details ? { details } : {}) });
      }
      return {
        response: {
          tool: def.name,
          result: outcome.result,
          provenance: { author_id: "system", author_kind: "SYSTEM", trust: "external" },
        },
        events:
          def.tier >= 2
            ? [
                {
                  type: "tool.completed",
                  payload: {
                    tool: def.name,
                    invocation_id: ctx.command_id,
                    capability,
                    tier: def.tier,
                    duration_ms: outcome.duration_ms,
                    trust: "external",
                  },
                },
              ]
            : [],
      };
    },
  });
}

class TimedOut extends Error {}
