import { CrossoverError, type ErrorCode } from "@crossover/protocol";
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
  /** Trusted runtime details used by T1202; never included in `tools.list` responses. */
  execution?: ToolExecutionSpec;
}

/** Per-tool container details. Commands are passed as argv, never through a shell. */
export interface ToolExecutionSpec {
  image: string;
  command: readonly string[];
  /** Exact hosts or `*.suffix` patterns this plugin invocation may reach through the proxy. */
  egressHosts: readonly string[];
  /** Broker credentials required by the tool; GitHub declarations need explicit permissions. */
  integrations?: readonly ToolIntegrationRequirement[];
  /** Optional per-tool output bound in bytes; it cannot exceed the platform's 256 KiB cap. */
  maxOutputBytes?: number;
}

export interface ToolIntegrationRequirement {
  provider: string;
  permissions?: Readonly<Record<string, "read" | "write">>;
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
    readonly options: {
      retryable: boolean;
      code?: ErrorCode;
      details?: Record<string, unknown>;
    } = { retryable: true },
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
    if (tool.execution) {
      const { image, command, egressHosts, integrations = [], maxOutputBytes } = tool.execution;
      if (!/^[A-Za-z0-9][A-Za-z0-9._/:+-]{0,254}@sha256:[a-f0-9]{64}$/.test(image))
        throw bad("the execution image must be pinned by a sha256 digest");
      if (
        !Array.isArray(command) ||
        command.length === 0 ||
        command.length > 32 ||
        command.some((arg) => typeof arg !== "string" || arg.length === 0 || arg.includes("\0"))
      ) {
        throw bad("the execution command must be a nonempty argv array");
      }
      if (
        !Array.isArray(egressHosts) ||
        egressHosts.length > 100 ||
        egressHosts.some(
          (host) =>
            typeof host !== "string" ||
            host.length === 0 ||
            host.length > 253 ||
            // eslint-disable-next-line no-control-regex
            /[\s\u0000-\u001f\u007f-\u009f]/.test(host),
        )
      ) {
        throw bad("the execution host allowlist is invalid");
      }
      if (
        maxOutputBytes !== undefined &&
        (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 256 * 1024)
      ) {
        throw bad("the execution output limit must be from 1 to 262144 bytes");
      }
      const providers = new Set<string>();
      for (const integration of integrations) {
        if (!/^(?:github|aws|oauth:[a-z][a-z0-9_]{1,31})$/.test(integration.provider))
          throw bad("an execution integration provider is invalid");
        if (providers.has(integration.provider))
          throw bad("an execution integration provider is declared more than once");
        providers.add(integration.provider);
        if (integration.provider === "github" && !Object.keys(integration.permissions ?? {}).length)
          throw bad("a GitHub execution integration requires explicit permissions");
        if (
          integration.permissions &&
          (integration.provider !== "github" ||
            Object.entries(integration.permissions).some(
              ([name, level]) =>
                !/^[a-z][a-z_]{0,39}$/.test(name) || !["read", "write"].includes(level),
            ))
        ) {
          throw bad("execution integration permissions are invalid");
        }
      }
      if (integrations.some((integration) => integration.provider === "github") && !tool.scope) {
        throw bad("a GitHub integration requires a repository-scoped tool");
      }
    }
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
      /[\s\u0000-\u001f\u007f-\u009f%?#*[\]{}\\]/.test(value)
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
