import { isMethodName, METHOD_NAMES, type MethodName } from "@crossover/protocol";

/** What a command call gives back (§16.2): the response, the events it appended, and whether it was a replay. */
export interface CommandResult<R = unknown> {
  response: R;
  events: SdkEvent[];
  /** True when an idempotent duplicate returned the stored result and nothing ran again. */
  replayed: boolean;
  /** A secret handed over exactly once (an invite token, a join's tokens). */
  one_time?: unknown;
}

/** An event as the server sends it (§19.2). */
export interface SdkEvent {
  room_id: string;
  sequence: number;
  actor_id: string;
  type: string;
  timestamp: string;
  causation_id: string | null;
  schema_version: number;
  payload: Record<string, unknown>;
  payload_hash: string;
  redacted: boolean;
}

export interface CallOptions {
  /** Mutating commands get a fresh key unless you give one; the same key is used on every retry. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

/** One command, callable: `room.api.tasks.create({ ... })`. */
export type CommandFn = <R = unknown>(
  params?: Record<string, unknown>,
  options?: CallOptions,
) => Promise<CommandResult<R>>;

type Head<M extends string> = M extends `${infer H}.${string}` ? H : M;
type Tail<M extends string, H extends string> = M extends `${H}.${infer T}` ? T : never;

/** The catalog as nested namespaces: `"tasks.create"` becomes `api.tasks.create`. */
export type Nest<M extends string> = {
  [H in Head<M>]: [Tail<M, H>] extends [never] ? CommandFn : Nest<Tail<M, H>>;
};

/** Every Room Protocol method of the catalog, as typed calls. */
export type Api = Nest<MethodName>;

/**
 * Build the namespaced API over a `call(method, params, options)` function. Only methods of the
 * protocol catalog exist: anything else is `undefined`, like a misspelled property.
 */
export function makeApi(
  call: (
    method: MethodName,
    params: Record<string, unknown>,
    options?: CallOptions,
  ) => Promise<CommandResult>,
): Api {
  const known = new Set<string>(METHOD_NAMES);
  const prefixes = new Set<string>();
  for (const name of METHOD_NAMES) {
    const parts = name.split(".");
    for (let i = 1; i < parts.length; i++) prefixes.add(parts.slice(0, i).join("."));
  }
  const node = (path: string): unknown => {
    if (known.has(path)) {
      const fn = (params: Record<string, unknown> = {}, options?: CallOptions) =>
        call(path as MethodName, params, options);
      return fn;
    }
    return new Proxy(Object.create(null) as object, {
      get(_target, key) {
        if (typeof key !== "string") return undefined;
        const next = `${path}.${key}`;
        return known.has(next) || prefixes.has(next) ? node(next) : undefined;
      },
      has: (_target, key) =>
        typeof key === "string" && (known.has(`${path}.${key}`) || prefixes.has(`${path}.${key}`)),
    });
  };
  return new Proxy(Object.create(null) as object, {
    get(_target, key) {
      if (typeof key !== "string") return undefined;
      return known.has(key) || prefixes.has(key) ? node(key) : undefined;
    },
  }) as Api;
}

export { isMethodName };
