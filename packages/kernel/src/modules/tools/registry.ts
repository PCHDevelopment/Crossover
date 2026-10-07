import { CrossoverError } from "@crossover/protocol";
import type { z } from "zod";

/** A tool's risk tier (§21.2, D14). Tier 3 is never in a role bundle. */
export type ToolTier = 0 | 1 | 2 | 3;

/** What a plugin declares for one tool (T1201, §21.4). */
export interface ToolDefinition<A = Record<string, unknown>> {
  /** `<plugin>.<tool>`, e.g. `github.create_pull_request`. */
  name: string;
  description: string;
  /** The capability a caller needs, without its scope (`github.create_pull_request`). */
  capability: string;
  tier: ToolTier;
  /** Validates the arguments. */
  input: z.ZodType<A>;
  /**
   * The scope of this particular call, derived from its arguments (`org/repo`, a function ARN):
   * the caller must hold `<capability>:<scope>`.
   */
  scope?: (args: A) => string | undefined;
  /**
   * Put a scope in the tool's own canonical form before it is matched and handed to the runner
   * (a GitHub `owner/repo` lower-cased). The platform's rules (no `.`/`..`/empty segments, no
   * `%?#\` or control characters, at most {@link MAX_SCOPE_LENGTH}) apply either way.
   */
  normalizeScope?: (scope: string) => string;
  /**
   * Whether running it twice has the same effect as once. The platform never retries a tool
   * either way (§26); this tells callers whether they may.
   */
  idempotent: boolean;
}

/** What the runner (T1202) gets for one invocation. */
export interface ToolInvocation {
  tool: string;
  args: unknown;
  /** The capability string that was authorized, scope included. */
  capability: string;
  /**
   * The canonical scope (`undefined` for an unscoped tool). **The runner acts only on this**, never
   * on a value it re-derives from `args`: what was authorized is exactly this scope.
   */
  scope: string | undefined;
  room_id: string;
  participant_id: string;
  /** Unique per invocation; the command id. */
  invocation_id: string;
}

export interface ToolOutput {
  result: unknown;
}

/** Runs a tool. The plugin runner (T1202) implements it; it never hands a credential back. */
export interface ToolRunner {
  run(invocation: ToolInvocation, signal: AbortSignal): Promise<ToolOutput>;
}

/** Thrown by a runner when the service behind a tool failed or timed out. */
export class ToolProviderError extends Error {
  constructor(
    message: string,
    readonly options: { retryable: boolean } = { retryable: true },
  ) {
    super(message);
    this.name = "ToolProviderError";
  }
}

const NAME = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

export interface ToolRegistryOptions {
  /** The tier the policy gives a capability (`tierOf`): a declared tier that disagrees is refused. */
  tierOf?: (capability: string) => number;
}

/** The tools plugins declare (T1201). Registered at startup, by name, once. */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition<never>>();
  constructor(private readonly options: ToolRegistryOptions = {}) {}

  register<A>(tool: ToolDefinition<A>): void {
    const bad = (why: string) => new Error(`Tool ${tool.name}: ${why}`);
    if (!NAME.test(tool.name))
      throw bad("the name must be <plugin>.<tool> in lowercase snake_case");
    if (this.tools.has(tool.name)) throw bad("already registered");
    if (!NAME.test(tool.capability)) throw bad("the capability must be <resource>.<action>");
    const expected = this.options.tierOf?.(tool.capability);
    if (expected !== undefined && expected !== tool.tier) {
      throw bad(
        `declared tier ${tool.tier} but the policy puts ${tool.capability} in tier ${expected}`,
      );
    }
    this.tools.set(tool.name, tool as unknown as ToolDefinition<never>);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name) as unknown as ToolDefinition | undefined;
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()].sort((a, b) =>
      a.name.localeCompare(b.name, "en"),
    ) as unknown as ToolDefinition[];
  }
}

export const MAX_SCOPE_LENGTH = 200;

/** A scope as one canonical string, or `VALIDATION`: no empty, `.` or `..` segments, nothing that could re-route it. */
export function canonicalScope(raw: string, normalize?: (scope: string) => string): string {
  const bad = () =>
    new CrossoverError("VALIDATION", "The arguments name an invalid scope", {
      details: { reason: "invalid_scope" },
    });
  const check = (value: string) => {
    if (
      value === "" ||
      value.length > MAX_SCOPE_LENGTH ||
      // eslint-disable-next-line no-control-regex
      /[\s\u0000-\u001f\u007f%?#*[\]{}\\]/.test(value)
    )
      throw bad();
    if (value.split("/").some((segment) => segment === "" || segment === "." || segment === ".."))
      throw bad();
    return value;
  };
  return check(normalize ? check(normalize(check(raw))) : raw);
}

/** The canonical scope of one call, if the tool has one. */
export function scopeOf<A>(tool: ToolDefinition<A>, args: A): string | undefined {
  const raw = tool.scope?.(args);
  return raw === undefined ? undefined : canonicalScope(raw, tool.normalizeScope);
}

/** The capability string for one call: the base, plus `:scope` (canonical) when the tool has one. */
export function capabilityFor<A>(tool: ToolDefinition<A>, args: A): string {
  const scope = scopeOf(tool, args);
  return scope === undefined ? tool.capability : `${tool.capability}:${scope}`;
}
