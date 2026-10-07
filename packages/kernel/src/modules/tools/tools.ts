import type { Pool, PoolClient } from "@crossover/db";
import { IDEMPOTENCY_TTL_HOURS } from "@crossover/ledger";
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

/** A run that already has an outcome under the key, and whether its events are in the ledger. */
interface Recorded {
  outcome: Outcome;
  logged: boolean;
}

const keyReuse = (key: string) =>
  new CrossoverError("VALIDATION", "Idempotency key was already used with a different request", {
    details: { idempotency_key: key },
  });

/**
 * Refuse a key that another command (or another `tools.invoke`) already used: the dispatcher's own
 * record says which request it stands for, and a different one must not run the tool before the
 * dispatcher finds out afterwards.
 */
async function refuseKeyReuse(pool: Pool, who: Claimant): Promise<void> {
  const { rows } = await pool.query<{ request_hash: string }>(
    `SELECT request_hash FROM idempotency_keys
     WHERE participant_id = $1 AND idempotency_key = $2
       AND created_at >= clock_timestamp() - make_interval(hours => $3)`,
    [who.participant_id, who.key, IDEMPOTENCY_TTL_HOURS],
  );
  if (rows[0] && rows[0].request_hash !== who.hash) throw keyReuse(who.key);
}

/** The outcome kept under this key by an earlier attempt, if there is one. */
async function findRecorded(pool: Pool, who: Claimant): Promise<Recorded | undefined> {
  const { rows } = await pool.query<{
    request_hash: string;
    outcome: Outcome | null;
    events_logged: boolean;
  }>(
    `SELECT request_hash, outcome, events_logged FROM tool_invocations
     WHERE participant_id = $1 AND idempotency_key = $2
       AND claimed_at >= clock_timestamp() - make_interval(hours => $3)`,
    [who.participant_id, who.key, IDEMPOTENCY_TTL_HOURS],
  );
  const row = rows[0];
  if (!row) return undefined;
  if (row.request_hash !== who.hash) throw keyReuse(who.key);
  return row.outcome ? { outcome: row.outcome, logged: row.events_logged } : undefined;
}

type Claim =
  | { claimed: true }
  /** The claim's process was lost and the tool isn't safe to repeat: what a retry is told. */
  | { claimed: false; resolved: Outcome };

/**
 * Take the idempotency key for a tool run BEFORE its side effect, in a short transaction of its
 * own (`tool_invocations`): a second request with the same key while it runs is `in progress`
 * (retryable). Whether a claim is stale is decided in SQL, from the database's clock.
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
           claimed_at = clock_timestamp(), outcome = NULL, events_logged = false
       WHERE tool_invocations.claimed_at < clock_timestamp() - make_interval(hours => $6)`,
    [who.participant_id, who.key, who.hash, who.room_id, who.tool, IDEMPOTENCY_TTL_HOURS],
  );
  if ((rowCount ?? 0) > 0) return { claimed: true };
  const staleSeconds = (timeoutMs + STALE_AFTER_MS) / 1000;
  // The process that claimed it is gone. A tool that is safe to repeat is taken over; for any
  // other, whether it happened is unknown, and that is what a retry is told.
  if (def.idempotent) {
    const { rowCount: took } = await pool.query(
      `UPDATE tool_invocations SET claimed_at = clock_timestamp()
       WHERE participant_id = $1 AND idempotency_key = $2 AND request_hash = $3
         AND outcome IS NULL
         AND claimed_at < clock_timestamp() - make_interval(secs => $4)`,
      [who.participant_id, who.key, who.hash, staleSeconds],
    );
    if ((took ?? 0) > 0) return { claimed: true };
  } else {
    const resolved = unknownOutcome(def, "The tool's process was lost while it ran");
    const { rowCount: done } = await pool.query(
      `UPDATE tool_invocations SET outcome = $4::jsonb
       WHERE participant_id = $1 AND idempotency_key = $2 AND request_hash = $3
         AND outcome IS NULL
         AND claimed_at < clock_timestamp() - make_interval(secs => $5)`,
      [who.participant_id, who.key, who.hash, JSON.stringify(resolved), staleSeconds],
    );
    if ((done ?? 0) > 0) return { claimed: false, resolved };
  }
  const recorded = await findRecorded(pool, who); // someone finished it meanwhile, or another request holds the key
  if (recorded) return { claimed: false, resolved: recorded.outcome };
  throw new CrossoverError("CONFLICT_VERSION", "That invocation is still running", {
    retryable: true,
    details: { reason: "in_progress", retry_after: 5 },
  });
}

/** Keep the outcome. False when the claim was taken over and another outcome stands. */
const recordOutcome = async (pool: Pool, who: Claimant, outcome: Outcome): Promise<boolean> => {
  const { rowCount } = await pool.query(
    `UPDATE tool_invocations SET outcome = $3::jsonb
     WHERE participant_id = $1 AND idempotency_key = $2 AND outcome IS NULL`,
    [who.participant_id, who.key, JSON.stringify(outcome)],
  );
  return (rowCount ?? 0) > 0;
};

/** The run starts now: the staleness clock counts from here, not from the claim. */
const markStarted = (pool: Pool, who: Claimant) =>
  pool.query(
    `UPDATE tool_invocations SET claimed_at = clock_timestamp()
     WHERE participant_id = $1 AND idempotency_key = $2 AND outcome IS NULL`,
    [who.participant_id, who.key],
  );

const unmarkLogged = (pool: Pool, who: Claimant) =>
  pool.query(
    "UPDATE tool_invocations SET events_logged = false WHERE participant_id = $1 AND idempotency_key = $2",
    [who.participant_id, who.key],
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
      const who: Claimant = {
        participant_id: ctx.principal.participant_id,
        key: ctx.idempotency_key,
        hash: ctx.request_hash,
        room_id: ctx.room_id,
        tool: def.name,
      };
      await refuseKeyReuse(ctx.pool, who);

      /** An event about this run, in the ledger; false when the room is frozen (the platform appends nothing). */
      const note = async (
        type: "tool.invoked" | "tool.completed" | "tool.failed",
        capability: string,
        extra: Record<string, unknown> = {},
      ): Promise<boolean> => {
        const out = await dispatcher.runSystem(
          ctx.room_id,
          type,
          async () => ({
            result: true,
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
          // A frozen room takes no event. For `tool.invoked` of a tier 3 tool that means the tool
          // doesn't run (it throws); anything else is kept in the outcome and logged on a retry.
          def.tier >= 3 && type === "tool.invoked" ? {} : { whenFrozen: () => false },
        );
        return out.result;
      };
      const logOutcome = async (
        outcome: Outcome,
        capability: string,
        released = false,
      ): Promise<void> => {
        if (def.tier < 2) return;
        // Claim the right to log first, atomically: concurrent retries of the same key must append
        // the event once. If the append doesn't happen (a frozen room, a failure), give the claim back.
        const { rowCount } = await ctx.pool.query(
          `UPDATE tool_invocations SET events_logged = true
           WHERE participant_id = $1 AND idempotency_key = $2 AND events_logged = false
           RETURNING 1`,
          [who.participant_id, who.key],
        );
        const owned = (rowCount ?? 0) > 0;
        // Someone else holds the right to log this run's events. (A run whose claim was released,
        // a retryable failure, has no row at all and is logged by the one request that ran it.)
        if (!owned && !released) return;
        let logged = false;
        try {
          logged = outcome.ok
            ? await note("tool.completed", capability, {
                duration_ms: outcome.duration_ms,
                trust: "external",
              })
            : await note("tool.failed", capability, {
                reason: outcome.error.code,
                retryable: outcome.error.retryable,
              });
        } finally {
          if (owned && !logged) await unmarkLogged(ctx.pool, who).catch(() => undefined);
        }
      };

      // A run that already has an outcome under this key belongs to its requester: they get what
      // happened, whatever has changed since (a revoked grant, a room that was frozen meanwhile).
      const recorded = await findRecorded(ctx.pool, who);
      if (recorded) {
        let capability = def.capability;
        let scope: string | undefined;
        try {
          const args = parseArgs(def, p.args);
          scope = scopeOf(def, args);
          capability = capabilityFor(def, args);
        } catch {
          // the outcome stands whatever the arguments look like now
        }
        await logOutcome(recorded.outcome, capability).catch(() => undefined);
        return { outcome: recorded.outcome, capability, scope };
      }

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
      const claim = await claimRun(ctx.pool, who, def, timeoutMs);
      if (!claim.claimed) {
        await logOutcome(claim.resolved, capability).catch(() => undefined);
        return { outcome: claim.resolved, capability, scope };
      }

      if (def.tier >= 2) {
        try {
          await note("tool.invoked", capability);
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
      await markStarted(ctx.pool, who);
      let outcome = await execTool(def, args, capability, scope, {
        room_id: ctx.room_id,
        participant_id: ctx.principal.participant_id,
        invocation_id: ctx.command_id,
      });
      // Recorded whatever comes next. A failure the tool may be retried after leaves no claim.
      try {
        if (!outcome.ok && outcome.error.retryable) {
          await releaseClaim(ctx.pool, who);
          await logOutcome(outcome, capability, true).catch(() => undefined);
          return { outcome, capability, scope };
        }
        if (!(await recordOutcome(ctx.pool, who, outcome))) {
          // The claim was taken over while this ran: what stands is what was recorded.
          const standing = await findRecorded(ctx.pool, who);
          if (standing) outcome = standing.outcome;
        }
      } catch (error) {
        // The outcome can't be kept: the key stays claimed, and a retry is told it's in progress,
        // then (for a tool that isn't idempotent) that the outcome is unknown.
        throw new CrossoverError("STALE_FENCE", "The result couldn't be recorded; retry later", {
          retryable: true,
          cause: error,
        });
      }
      // In the ledger from here, not from `execute`: the run happened even if the room is frozen
      // or the caller's access ended since, and the response can then not be delivered.
      await logOutcome(outcome, capability).catch(() => undefined);
      return { outcome, capability, scope };
    },
    execute: async (ctx, p) => {
      const def = registry.get(p.tool);
      if (!def) throw unknownTool();
      const prepared = ctx.prepared as Prepared | undefined;
      if (!prepared || "denied" in prepared) {
        // Not allowed to start (or no run was made): the real check, which refuses and records it
        // or, for a gate, asks for approval. A caller who holds the tool for no scope at all gets
        // the answer an unknown tool gets, and the denial is recorded all the same.
        try {
          await ctx.authorize(def.capability, {}, { anyScope: true, refuseAs: unknownTool });
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
      // to is what the key stands for. Not re-authorized: that decides *future* invocations. Its
      // events were appended by `prepare`.
      const { outcome } = prepared;
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
      };
    },
  });
}

class TimedOut extends Error {}
