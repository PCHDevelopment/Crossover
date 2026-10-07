import { CrossoverError, PROTOCOL_VERSION, newId, type ErrorCode } from "@crossover/protocol";
import type { CallOptions, CommandResult, SdkEvent } from "./api.js";
import { sleep, TransportError } from "./http.js";

/** The slice of the WHATWG `WebSocket` the SDK uses; Node 22 and browsers have it as a global. */
export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}
export type WebSocketCtor = new (url: string) => WebSocketLike;

export interface WsConfig {
  /** `ws://…/v1/rooms/<room>/ws` */
  url: string;
  token: string;
  WebSocket: WebSocketCtor;
  client: string;
  clientVersion: string;
  /** Give up on a connection that hasn't said `hello_ok` after this long. Default 10 s. */
  helloTimeoutMs?: number;
}

/** Close codes the server uses (§16.4, application range). */
export const CLOSE = { UNAUTHENTICATED: 4401, NOT_FOUND: 4404, RESYNC_REQUIRED: 4409 } as const;

type Frame = Record<string, unknown> & { type: string };

/** One connected, greeted socket. */
export class WsSession {
  private frameHandler: ((frame: Frame) => void) | undefined;
  private closeHandler: ((code: number, reason: string) => void) | undefined;
  private closed = false;
  private constructor(private readonly socket: WebSocketLike) {}

  /** Connect and say hello; resolves once the server has answered `hello_ok`. */
  static open(config: WsConfig): Promise<WsSession> {
    return new Promise((resolve, reject) => {
      let socket: WebSocketLike;
      try {
        socket = new config.WebSocket(config.url);
      } catch (error) {
        return reject(
          new TransportError("Couldn't open the WebSocket", { retryable: true, cause: error }),
        );
      }
      const session = new WsSession(socket);
      let greeted = false;
      const timer = setTimeout(() => {
        fail(new TransportError("The server didn't answer hello", { retryable: true }));
        socket.close();
      }, config.helloTimeoutMs ?? 10_000);
      const fail = (error: unknown) => {
        clearTimeout(timer);
        if (!greeted) reject(error);
      };
      socket.onopen = () =>
        socket.send(
          JSON.stringify({
            type: "hello",
            protocol_version: PROTOCOL_VERSION,
            client: config.client,
            client_version: config.clientVersion,
            token: config.token,
          }),
        );
      socket.onmessage = (event) => {
        let frame: Frame;
        try {
          frame = JSON.parse(String(event.data)) as Frame;
        } catch {
          return;
        }
        if (!greeted) {
          if (frame.type === "hello_ok") {
            greeted = true;
            clearTimeout(timer);
            resolve(session);
          } else if (frame.type === "error") {
            fail(frameError(frame));
          }
          return;
        }
        session.frameHandler?.(frame);
      };
      socket.onclose = (event) => {
        session.closed = true;
        fail(
          new TransportError(`The connection closed (${event.code})`, {
            retryable: event.code !== CLOSE.UNAUTHENTICATED && event.code !== CLOSE.NOT_FOUND,
          }),
        );
        session.closeHandler?.(event.code, event.reason);
      };
      socket.onerror = () => {
        // A failed connection also closes; `onclose` reports it.
      };
    });
  }

  onFrame(handler: (frame: Frame) => void): void {
    this.frameHandler = handler;
  }
  onClose(handler: (code: number, reason: string) => void): void {
    this.closeHandler = handler;
    if (this.closed) handler(1006, "");
  }
  send(frame: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(frame));
  }
  close(): void {
    try {
      this.socket.close(1000, "client closing");
    } catch {
      // already closing
    }
  }
}

/** The error a server `error` frame carries (§16.3 body). */
export function frameError(frame: Frame): CrossoverError {
  const error = frame["error"] as
    | { code?: string; message?: string; retryable?: boolean; details?: Record<string, unknown> }
    | undefined;
  return new CrossoverError((error?.code ?? "VALIDATION") as ErrorCode, error?.message ?? "Error", {
    retryable: error?.retryable === true,
    ...(error?.details ? { details: error.details } : {}),
  });
}

/**
 * Commands over one WebSocket (§16.4): the same envelope and the same answers as REST, matched
 * by command id. It doesn't reconnect: when the socket closes, pending calls fail and the next
 * `call` opens a new one. (Use `subscribe` for a stream that survives drops.)
 */
export class RoomSocket {
  private session: Promise<WsSession> | undefined;
  private readonly pending = new Map<
    string,
    { resolve: (r: CommandResult) => void; reject: (e: unknown) => void }
  >();

  constructor(private readonly config: WsConfig) {}

  private connect(): Promise<WsSession> {
    this.session ??= WsSession.open(this.config).then(
      (session) => {
        session.onFrame((frame) => {
          const id = typeof frame["id"] === "string" ? frame["id"] : undefined;
          const entry = id ? this.pending.get(id) : undefined;
          if (!entry || !id) return;
          this.pending.delete(id);
          if (frame.type === "result") {
            entry.resolve({
              response: frame["response"],
              events: (frame["events"] as SdkEvent[]) ?? [],
              replayed: frame["replayed"] === true,
              ...(frame["one_time"] === undefined ? {} : { one_time: frame["one_time"] }),
            });
          } else if (frame.type === "error") {
            entry.reject(frameError(frame));
          }
        });
        session.onClose(() => {
          this.session = undefined;
          for (const [id, entry] of this.pending) {
            this.pending.delete(id);
            entry.reject(new TransportError("The connection closed", { retryable: true }));
          }
        });
        return session;
      },
      (error: unknown) => {
        this.session = undefined;
        throw error;
      },
    );
    return this.session;
  }

  async call(
    method: string,
    params: Record<string, unknown>,
    mutating: boolean,
    options: CallOptions = {},
  ): Promise<CommandResult> {
    const session = await this.connect();
    const id = newId("cmd");
    const result = new Promise<CommandResult>((resolve, reject) =>
      this.pending.set(id, { resolve, reject }),
    );
    session.send({
      type: "command",
      id,
      method,
      params,
      ...(mutating ? { idempotency_key: options.idempotencyKey ?? crypto.randomUUID() } : {}),
    });
    return result;
  }

  close(): void {
    void this.session?.then(
      (s) => s.close(),
      () => undefined,
    );
  }
}

export interface SubscribeOptions {
  /** Deliver events with a sequence greater than this (the last one you have). Default 0: from the start. */
  after?: number;
  onEvent?: (event: SdkEvent) => void;
  /** A problem that ended the subscription (the token stopped working, the room is gone). */
  onError?: (error: unknown) => void;
  /** `connecting` → `live`, `reconnecting` after a drop, `closed` at the end. */
  onState?: (state: "connecting" | "live" | "reconnecting" | "closed") => void;
  /** Reconnect waits: first `minMs` (default 100), doubling with jitter up to `maxMs` (default 5000). */
  reconnect?: { minMs?: number; maxMs?: number };
}

/**
 * A stream of a room's events that survives dropped connections (§16.4, §20): every event after
 * `after` once and in order. After a drop, a server `resync_required` or a gap, it reconnects and
 * asks for everything after the last sequence it delivered, so nothing is lost and nothing comes
 * twice. Read it with `for await`, with `onEvent`, or both. A problem that reconnecting can't fix
 * (an invalid token, a room that isn't there, a refused subscription) ends it with `onError`.
 */
export class Subscription implements AsyncIterable<SdkEvent> {
  /** The sequence of the last event delivered. */
  lastSequence: number;
  private readonly queue: SdkEvent[] = [];
  private waiting:
    { resolve: (r: IteratorResult<SdkEvent>) => void; reject: (e: unknown) => void } | undefined;
  private done = false;
  private failure: unknown;
  private session: WsSession | undefined;
  private readonly abort = new AbortController();

  constructor(
    private readonly config: WsConfig,
    private readonly options: SubscribeOptions = {},
  ) {
    this.lastSequence = options.after ?? 0;
    void this.run();
  }

  close(): void {
    if (this.done) return;
    this.finish();
  }

  private finish(error?: unknown): void {
    if (this.done) return;
    this.done = true;
    this.failure = error;
    this.abort.abort();
    this.session?.close();
    this.options.onState?.("closed");
    if (error !== undefined) this.options.onError?.(error);
    if (error === undefined) this.waiting?.resolve({ value: undefined, done: true });
    else this.waiting?.reject(error);
    this.waiting = undefined;
  }

  private deliver(event: SdkEvent): void {
    this.lastSequence = event.sequence;
    this.options.onEvent?.(event);
    if (this.waiting) {
      this.waiting.resolve({ value: event, done: false });
      this.waiting = undefined;
    } else {
      this.queue.push(event);
    }
  }

  async run(): Promise<void> {
    const min = this.options.reconnect?.minMs ?? 100;
    const max = this.options.reconnect?.maxMs ?? 5_000;
    let attempt = 0;
    let first = true;
    while (!this.done) {
      this.options.onState?.(first ? "connecting" : "reconnecting");
      first = false;
      let end: "dropped" | "fatal" = "dropped";
      try {
        const session = await WsSession.open(this.config);
        if (this.done) {
          session.close();
          return;
        }
        this.session = session;
        end = await new Promise<"dropped" | "fatal">((resolve) => {
          session.onFrame((frame) => {
            switch (frame.type) {
              case "subscribed":
                attempt = 0;
                this.options.onState?.("live");
                break;
              case "event": {
                const event = frame["event"] as SdkEvent;
                if (event.sequence <= this.lastSequence) break; // already delivered
                if (event.sequence !== this.lastSequence + 1) {
                  // Something was skipped: start over from what we have rather than skip it.
                  session.close();
                  break;
                }
                this.deliver(event);
                break;
              }
              case "resync_required":
                session.close();
                break;
              case "error":
                // Once subscribed, an error frame is the subscription itself being refused.
                this.finish(frameError(frame));
                resolve("fatal");
                break;
            }
          });
          session.onClose((code) => {
            resolve(
              code === CLOSE.UNAUTHENTICATED || code === CLOSE.NOT_FOUND ? "fatal" : "dropped",
            );
          });
          session.send({ type: "subscribe", after: this.lastSequence });
        });
      } catch (error) {
        if (
          error instanceof CrossoverError ||
          (error instanceof TransportError && !error.retryable)
        ) {
          this.finish(error);
          return;
        }
      }
      this.session = undefined;
      if (this.done) return;
      if (end === "fatal") {
        this.finish(new CrossoverError("UNAUTHENTICATED", "The subscription can't continue"));
        return;
      }
      attempt += 1;
      const wait = Math.min(max, min * 2 ** (attempt - 1));
      try {
        await sleep(wait / 2 + Math.random() * (wait / 2), this.abort.signal);
      } catch {
        return;
      }
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SdkEvent> {
    return {
      next: () => {
        const event = this.queue.shift();
        if (event) return Promise.resolve({ value: event, done: false });
        if (this.done) {
          return this.failure === undefined
            ? Promise.resolve({ value: undefined, done: true })
            : Promise.reject(this.failure);
        }
        return new Promise((resolve, reject) => {
          this.waiting = { resolve, reject };
        });
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
