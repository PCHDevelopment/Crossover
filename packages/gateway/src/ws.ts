import type { Pool } from "@crossover/db";
import {
  authenticate,
  createEventMatcher,
  type Dispatcher,
  type EventSubscriber,
  type Presence,
  presenceFor,
  type PresenceSubscriber,
  type EditIntent,
  type EditIntentSubscriber,
  redactEventFor,
  type Principal,
  type SubscriptionFilter,
} from "@crossover/kernel";
import { listEvents } from "@crossover/ledger";
import { authorize } from "@crossover/policy";
import { CrossoverError, isId, newId, type RoomEvent } from "@crossover/protocol";
import type { FastifyInstance } from "fastify";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { toHttpError } from "./errors.js";

/** The WebSocket protocol versions this server speaks (§16.4). */
export const SUPPORTED_PROTOCOL_VERSIONS = [1] as const;

export interface SandboxOutputMetadata {
  exec_id: string;
  room_id: string;
  sandbox_id: string;
  participant_id: string;
  finished_at?: string;
  exit_code?: number | null;
  duration_ms?: number;
  reason?: string;
  truncated: boolean;
}

export type SandboxOutputChunk =
  | { cursor: number; kind: "data"; stream: "stdout" | "stderr"; data: Uint8Array }
  | { cursor: number; kind: "truncated" };

export type SandboxOutputUpdate =
  | { kind: "chunk"; chunk: SandboxOutputChunk }
  | { kind: "finished"; metadata: SandboxOutputMetadata };

export interface SandboxOutputSource {
  get(execId: string): Promise<SandboxOutputMetadata | undefined>;
  lastSequence(execId: string): Promise<number>;
  read(execId: string, afterCursor: number, limit: number): Promise<SandboxOutputChunk[]>;
  subscribe(execId: string, listener: (update: SandboxOutputUpdate) => void): () => void;
}

export interface WebSocketOptions {
  dispatcher: Dispatcher;
  pool: Pool;
  /** Where live events come from (Redis pub/sub). Anything missed is backfilled from PostgreSQL. */
  subscriber: EventSubscriber;
  /** Re-check the room's last sequence this often, so a missed final message is still delivered. Default 2000. */
  pollIntervalMs?: number;
  /** Re-check the token this often and close the socket if it stopped working. Default 30000. */
  revalidateIntervalMs?: number;
  /** Close with `resync_required` past this many events waiting to be sent (§20). Default 1000. */
  maxBufferedEvents?: number;
  /** …or this many bytes queued on the socket. Default 5 MiB. */
  maxBufferedBytes?: number;
  /** Close a connection that hasn't said hello within this long. Default 10000. */
  helloTimeoutMs?: number;
  /** Builds the per-subscription event filter. Default: the kernel's (tests substitute one). */
  createMatcher?: typeof createEventMatcher;
  /** Told about a failure that is a bug, not a client error (e.g. a filter that threw). */
  onInternalError?: (error: unknown) => void;
  /** Events fetched per backfill query. Default 200. */
  backfillPageSize?: number;
  /** Private sandbox logs plus their in-process live fanout, wired by the composition root. */
  sandboxOutput?: SandboxOutputSource;
  /** Maximum queued output per subscriber before it must replay from its cursor. Default 1 MiB. */
  maxSandboxOutputBufferedBytes?: number;
  /** Live presence (§13.4, Redis), for `presence.subscribe`. */
  presence?: PresenceSubscriber;
  /** Intent invalidations; each update is reloaded through the ACL-filtered list command. */
  intents?: EditIntentSubscriber;
}

/** Close codes (4000-range, application defined). */
export const CLOSE = {
  BAD_REQUEST: 4400,
  UNAUTHENTICATED: 4401,
  NOT_FOUND: 4404,
  RESYNC_REQUIRED: 4409,
  TIMEOUT: 4408,
  INTERNAL: 4500,
} as const;

interface Stream {
  lastSent: number;
  /** Whether the subscriber wants an event (T704); every event passes for `all`. */
  match: (event: RoomEvent) => boolean;
  /** Sends in order, one at a time. */
  out: Promise<void>;
  /** Live events that arrived while a backfill was running. */
  pending: RoomEvent[];
  syncing: boolean;
  unsubscribe: () => Promise<void>;
  poll: ReturnType<typeof setInterval>;
}

interface SandboxStream {
  execId: string;
  lastCursor: number;
  syncing: boolean;
  pending: SandboxOutputUpdate[];
  pendingBytes: number;
  bufferedBytes: number;
  replayRequired: boolean;
  unsubscribe: () => void;
}

interface PresenceStream {
  /** Sends in order, one at a time. */
  out: Promise<void>;
  /** The latest update per participant that arrived before the snapshot was sent. */
  pending: Map<string, Presence> | undefined;
  /** Intent invalidations that arrived while the initial snapshot was loading. */
  intentsPending: boolean;
  intentsSyncing: boolean;
  intentsRefreshQueued: boolean;
  /** `workspace.read` answers per path; forgotten when the token is re-checked. */
  readable: Map<string, boolean>;
  unsubscribe: () => Promise<void>;
}

/** Paths remembered per presence subscriber before the cache starts over. */
const MAX_READABLE_CACHE = 1_000;

function sandboxUpdateBytes(update: SandboxOutputUpdate): number {
  if (update.kind === "chunk" && update.chunk.kind === "data")
    return Math.ceil(update.chunk.data.byteLength / 3) * 4 + 256;
  return 256;
}

/**
 * Serve `GET /v1/rooms/:roomId/ws` as a WebSocket (T703, ARCHITECTURE §16.4, §20).
 *
 * Frames are JSON objects with a `type`. Client → server:
 * - `hello { protocol_version, client, client_version, token? }`: must come first; the server
 *   answers `hello_ok` with the negotiated version. The room access token comes in the
 *   `Authorization: Bearer` header of the upgrade request or, for clients that can't set
 *   headers, in `token` here.
 * - `command { id, method, params, idempotency_key? }`: the same envelope as REST, with the
 *   same semantics; answered with `result { id, response, events, replayed, one_time? }` or
 *   `error { id, error }` (the §16.3 body).
 * - `subscribe { after, profile?, types?, scopes? }`: authorized as `room.events.subscribe`; the
 *   server sends `subscribed { after, last_sequence, filter }` (the resolved filter, §17.1: an
 *   agent gets `relevant` unless it asks for `all` or `custom`) and then every event after `after` as
 *   `event { event }`, in sequence order and each exactly once: history from PostgreSQL, then
 *   live from Redis, and whenever a live event shows a gap (or nothing arrives for a while) the
 *   missing range is fetched from PostgreSQL.
 * - `presence.subscribe`: authorized as `presence.list` (§13.4); the server sends
 *   `presence.snapshot { presence }` and then each update as `presence { record }`, every record
 *   as this participant may see it (open files they can't read and a cursor on one are left out).
 *   If intent fanout is available, it also sends `presence.intents.snapshot { intents }` on
 *   connect and after each set/clear. The list command filters unreadable paths. Nothing is sent
 *   when a record or intent expires: clients drop it once its `expires_at` passes.
 *   A refusal is an `error` frame with `subscription: "presence"`, which leaves the event stream
 *   alone. `presence.unsubscribe` stops it.
 *
 * A connection that can't keep up (more than 1,000 queued events or 5 MiB) is closed with
 * `resync_required`; the client reconnects with `after = last sequence it saw`.
 */
export function attachWebSocket(app: FastifyInstance, options: WebSocketOptions): void {
  const wss = new WebSocketServer({ noServer: true });
  const path = /^\/v1\/rooms\/([^/]+)\/ws$/;

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const match = path.exec(new URL(req.url ?? "/", "http://localhost").pathname);
    if (!match) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      new Connection(ws, req, decodeURIComponent(match[1]!), options).start();
    });
  };
  app.server.on("upgrade", onUpgrade);
  // preClose, not onClose: the HTTP server won't finish closing while WebSocket connections are
  // open, so they must say goodbye first.
  app.addHook("preClose", async () => {
    app.server.off("upgrade", onUpgrade);
    for (const client of wss.clients) client.close(1001, "server closing");
    // A peer that doesn't finish the close handshake promptly is cut off.
    const cutoff = setTimeout(() => {
      for (const client of wss.clients) client.terminate();
    }, 1_000);
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    clearTimeout(cutoff);
  });
}

class Connection {
  private principal: Principal | undefined;
  private token: string | undefined;
  private helloDone = false;
  private stream: Stream | undefined;
  private readonly sandboxStreams = new Map<string, SandboxStream>();
  private presenceStream: PresenceStream | undefined;
  private closed = false;
  /** Commands run one at a time, in the order they arrived. */
  private queue: Promise<void> = Promise.resolve();
  private readonly timers: ReturnType<typeof setTimeout>[] = [];
  private revalidate: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly ws: WebSocket,
    private readonly req: IncomingMessage,
    private readonly roomId: string,
    private readonly o: WebSocketOptions,
  ) {}

  start(): void {
    const header = this.req.headers.authorization;
    const match = header ? /^Bearer ([^\s]+)$/i.exec(header) : null;
    if (match?.[1]) this.token = match[1];
    this.timers.push(
      setTimeout(() => {
        if (!this.helloDone)
          this.fail(CLOSE.TIMEOUT, new CrossoverError("VALIDATION", "No hello received"));
      }, this.o.helloTimeoutMs ?? 10_000),
    );
    this.ws.on("message", (data) => this.onMessage(data));
    this.ws.on("close", () => void this.cleanup());
    this.ws.on("error", () => void this.cleanup());
  }

  /** What this connection's participant may see of `event` (denials are redacted, §22). */
  private view(event: RoomEvent): RoomEvent {
    return redactEventFor(this.principal!, event);
  }

  private send(frame: Record<string, unknown>): void {
    if (this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(JSON.stringify(frame));
    if (this.ws.bufferedAmount > (this.o.maxBufferedBytes ?? 5 * 1024 * 1024)) this.resync();
  }

  private fail(code: number, error: unknown, id?: string): void {
    const mapped = toHttpError(error);
    this.send({ type: "error", ...(id ? { id } : {}), error: mapped.body.error });
    this.ws.close(code, mapped.body.error.code);
    void this.cleanup();
  }

  private resync(): void {
    this.send({ type: "resync_required" });
    this.ws.close(CLOSE.RESYNC_REQUIRED, "resync_required");
    void this.cleanup();
  }

  private onMessage(data: RawData): void {
    let frame: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(data.toString());
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
      frame = parsed as Record<string, unknown>;
    } catch {
      this.send({
        type: "error",
        error: new CrossoverError("VALIDATION", "Frames must be JSON objects").toErrorBody().error,
      });
      return;
    }
    // One at a time, in order: a command frame must not overtake the hello before it.
    this.queue = this.queue
      .then(() => this.handle(frame))
      .catch((error: unknown) => this.fail(CLOSE.INTERNAL, error));
  }

  private async handle(frame: Record<string, unknown>): Promise<void> {
    if (this.closed) return;
    if (!this.helloDone) {
      if (frame.type !== "hello") {
        return this.fail(CLOSE.BAD_REQUEST, new CrossoverError("VALIDATION", "Send hello first"));
      }
      return this.hello(frame);
    }
    switch (frame.type) {
      case "command":
        return this.command(frame);
      case "subscribe":
        return this.subscribe(frame);
      case "sandbox.output.subscribe":
        return this.subscribeSandboxOutput(frame);
      case "sandbox.output.unsubscribe":
        return this.unsubscribeSandboxOutput(frame);
      case "presence.subscribe":
        return this.subscribePresence();
      case "presence.unsubscribe":
        return this.stopPresence();
      case "hello":
        return this.send({
          type: "error",
          error: new CrossoverError("VALIDATION", "Already said hello").toErrorBody().error,
        });
      default:
        return this.send({
          type: "error",
          error: new CrossoverError("VALIDATION", "Unknown frame type", {
            details: { type: typeof frame.type === "string" ? frame.type.slice(0, 50) : null },
          }).toErrorBody().error,
        });
    }
  }

  private async hello(frame: Record<string, unknown>): Promise<void> {
    const version = frame.protocol_version;
    if (
      typeof version !== "number" ||
      typeof frame.client !== "string" ||
      frame.client === "" ||
      typeof frame.client_version !== "string" ||
      frame.client_version === ""
    ) {
      return this.fail(
        CLOSE.BAD_REQUEST,
        new CrossoverError("VALIDATION", "hello needs protocol_version, client and client_version"),
      );
    }
    if (!(SUPPORTED_PROTOCOL_VERSIONS as readonly number[]).includes(version)) {
      return this.fail(
        CLOSE.BAD_REQUEST,
        new CrossoverError("VALIDATION", `Unsupported protocol_version ${version}`, {
          details: { supported: [...SUPPORTED_PROTOCOL_VERSIONS] },
        }),
      );
    }
    if (typeof frame.token === "string" && this.token === undefined) this.token = frame.token;
    try {
      if (this.token === undefined) {
        throw new CrossoverError("UNAUTHENTICATED", "Missing or invalid token");
      }
      this.principal = await authenticate(this.o.pool, this.token);
    } catch (error) {
      return this.fail(CLOSE.UNAUTHENTICATED, error);
    }
    // A token is for one room; anything else looks like a room that doesn't exist.
    if (this.principal.room_id !== this.roomId) {
      return this.fail(CLOSE.NOT_FOUND, new CrossoverError("NOT_FOUND", "Room not found"));
    }
    this.helloDone = true;
    this.revalidate = setInterval(() => {
      authenticate(this.o.pool, this.token!).then(
        async (principal) => {
          this.principal = principal; // a changed role changes what the stream shows
          this.presenceStream?.readable.clear();
          await this.revalidateSandboxOutput();
        },
        (error: unknown) => this.fail(CLOSE.UNAUTHENTICATED, error),
      );
    }, this.o.revalidateIntervalMs ?? 30_000);
    this.send({
      type: "hello_ok",
      protocol_version: version,
      participant_id: this.principal.participant_id,
      room_id: this.principal.room_id,
    });
  }

  private async command(frame: Record<string, unknown>): Promise<void> {
    const id = typeof frame.id === "string" ? frame.id : undefined;
    try {
      if (!isId(id, "cmd")) throw new CrossoverError("VALIDATION", "A command needs an id (cmd_…)");
      if (typeof frame.method !== "string") {
        throw new CrossoverError("VALIDATION", "A command needs a method");
      }
      const result = await this.o.dispatcher.dispatch(this.principal!, {
        id,
        method: frame.method,
        params: frame.params ?? {},
        ...(frame.idempotency_key === undefined ? {} : { idempotency_key: frame.idempotency_key }),
      });
      this.send({
        type: "result",
        id,
        response: result.response,
        events: result.events.map((e) => this.view(e)),
        replayed: result.replayed,
        ...(result.one_time === undefined ? {} : { one_time: result.one_time }),
      });
    } catch (error) {
      const mapped = toHttpError(error);
      this.send({ type: "error", ...(id ? { id } : {}), error: mapped.body.error });
    }
  }

  private async subscribe(frame: Record<string, unknown>): Promise<void> {
    let auth: { response: unknown };
    try {
      auth = await this.o.dispatcher.dispatch(this.principal!, {
        id: newId("cmd"),
        method: "room.events.subscribe",
        params: {
          after: frame.after ?? 0,
          ...(frame.profile === undefined ? {} : { profile: frame.profile }),
          ...(frame.types === undefined ? {} : { types: frame.types }),
          ...(frame.scopes === undefined ? {} : { scopes: frame.scopes }),
        },
      });
    } catch (error) {
      this.send({ type: "error", error: toHttpError(error).body.error });
      return;
    }
    const { after, last_sequence, filter } = auth.response as {
      after: number;
      last_sequence: number;
      filter: SubscriptionFilter;
    };
    await this.stopStream();

    const stream: Stream = {
      lastSent: after,
      match: (this.o.createMatcher ?? createEventMatcher)(this.principal!, filter),
      out: Promise.resolve(),
      pending: [],
      syncing: true,
      unsubscribe: async () => undefined,
      poll: setInterval(() => void this.catchUp(), this.o.pollIntervalMs ?? 2_000),
    };
    this.stream = stream;
    // Subscribe to live events first, so nothing slips between the backfill and the stream.
    stream.unsubscribe = await this.o.subscriber.subscribe(this.roomId, (event) =>
      this.onLive(stream, event),
    );
    this.send({ type: "subscribed", after, last_sequence, filter });
    await this.backfill(stream);
    stream.syncing = false;
    this.drain(stream);
  }

  private async subscribePresence(): Promise<void> {
    await this.stopPresence();
    if (!this.o.presence) {
      this.send({
        type: "error",
        subscription: "presence",
        error: new CrossoverError("NOT_FOUND", "Presence isn't available").toErrorBody().error,
      });
      return;
    }
    const stream: PresenceStream = {
      out: Promise.resolve(),
      pending: new Map(),
      intentsPending: false,
      intentsSyncing: this.o.intents !== undefined,
      intentsRefreshQueued: false,
      readable: new Map(),
      unsubscribe: async () => undefined,
    };
    this.presenceStream = stream;
    // Live updates first, so nothing slips between the snapshot and the stream.
    stream.unsubscribe = await this.o.presence.subscribe(this.roomId, (record) =>
      this.onPresence(stream, record),
    );
    if (this.o.intents) {
      const stop = await this.o.intents.subscribe(this.roomId, () => this.onIntentChange(stream));
      const stopPresence = stream.unsubscribe;
      stream.unsubscribe = async () => {
        await Promise.all([stopPresence(), stop()]);
      };
    }
    let snapshot: Presence[];
    let intentSnapshot: EditIntent[] | undefined;
    try {
      const [listed, listedIntents] = await Promise.all([
        this.o.dispatcher.dispatch(this.principal!, {
          id: newId("cmd"),
          method: "presence.list",
          params: {},
        }),
        this.o.intents
          ? this.o.dispatcher.dispatch(this.principal!, {
              id: newId("cmd"),
              method: "presence.list_intents",
              params: {},
            })
          : undefined,
      ]);
      snapshot = (listed.response as { presence: Presence[] }).presence;
      if (listedIntents)
        intentSnapshot = (listedIntents.response as { intents: EditIntent[] }).intents;
    } catch (error) {
      if (this.presenceStream === stream) await this.stopPresence();
      this.send({ type: "error", subscription: "presence", error: toHttpError(error).body.error });
      return;
    }
    if (this.presenceStream !== stream || this.closed) return;
    this.send({ type: "presence.snapshot", presence: snapshot });
    if (intentSnapshot) {
      this.send({ type: "presence.intents.snapshot", intents: intentSnapshot });
      stream.intentsSyncing = false;
      if (stream.intentsPending) this.queueIntentSnapshot(stream);
    }
    const listed = new Map(snapshot.map((record) => [record.participant_id, record.expires_at]));
    const pending = stream.pending!;
    stream.pending = undefined;
    for (const record of pending.values()) {
      const known = listed.get(record.participant_id);
      // An update the snapshot already includes (or that it superseded) isn't sent again.
      if (known === undefined || known < record.expires_at) this.sendPresence(stream, record);
    }
  }

  private onIntentChange(stream: PresenceStream): void {
    if (this.presenceStream !== stream || this.closed) return;
    stream.intentsPending = true;
    if (!stream.intentsSyncing) this.queueIntentSnapshot(stream);
  }

  /** Coalesce invalidations and always reload through the reader-filtered command. */
  private queueIntentSnapshot(stream: PresenceStream): void {
    if (stream.intentsRefreshQueued || stream.intentsSyncing) return;
    stream.intentsRefreshQueued = true;
    stream.out = stream.out
      .then(async () => {
        while (stream.intentsPending && this.presenceStream === stream && !this.closed) {
          stream.intentsPending = false;
          const listed = await this.o.dispatcher.dispatch(this.principal!, {
            id: newId("cmd"),
            method: "presence.list_intents",
            params: {},
          });
          if (this.presenceStream !== stream || this.closed) return;
          this.send({
            type: "presence.intents.snapshot",
            intents: (listed.response as { intents: EditIntent[] }).intents,
          });
        }
      })
      .catch((error: unknown) => this.o.onInternalError?.(error))
      .finally(() => {
        stream.intentsRefreshQueued = false;
        if (stream.intentsPending && !stream.intentsSyncing) this.queueIntentSnapshot(stream);
      });
  }

  private onPresence(stream: PresenceStream, record: Presence): void {
    if (this.presenceStream !== stream || this.closed) return;
    if (stream.pending) stream.pending.set(record.participant_id, record);
    else this.sendPresence(stream, record);
  }

  /** Send `record` as this participant may see it, after everything queued before it. */
  private sendPresence(stream: PresenceStream, record: Presence): void {
    stream.out = stream.out
      .then(async () => {
        const seen = await presenceFor(record, (path) => this.mayReadPath(stream, path));
        if (this.presenceStream !== stream || this.closed) return;
        this.send({ type: "presence", record: seen });
      })
      .catch((error: unknown) => this.o.onInternalError?.(error));
  }

  /** `workspace.read` on `path` for this participant; any refusal reads as no. */
  private async mayReadPath(stream: PresenceStream, path: string): Promise<boolean> {
    const known = stream.readable.get(path);
    if (known !== undefined) return known;
    let allowed = true;
    try {
      await authorize(
        this.principal!,
        "workspace.read",
        { room_id: this.roomId, path },
        { method: "presence.subscribe", params: {}, client: this.o.pool },
      );
    } catch (error) {
      if (!(error instanceof CrossoverError)) throw error;
      allowed = false;
    }
    if (stream.readable.size >= MAX_READABLE_CACHE) stream.readable.clear();
    stream.readable.set(path, allowed);
    return allowed;
  }

  private async stopPresence(): Promise<void> {
    const stream = this.presenceStream;
    this.presenceStream = undefined;
    await stream?.unsubscribe().catch(() => undefined);
  }

  private async subscribeSandboxOutput(frame: Record<string, unknown>): Promise<void> {
    const execId = frame.exec_id;
    const afterCursor = frame.after;
    if (
      !isId(execId, "exec") ||
      typeof afterCursor !== "number" ||
      !Number.isSafeInteger(afterCursor) ||
      afterCursor < 0
    ) {
      this.send({
        type: "error",
        error: new CrossoverError(
          "VALIDATION",
          "Invalid sandbox output cursor or exec_id",
        ).toErrorBody().error,
      });
      return;
    }
    if (!this.o.sandboxOutput) {
      this.send({
        type: "error",
        error: new CrossoverError("NOT_FOUND", "Sandbox output not found").toErrorBody().error,
      });
      return;
    }
    const previous = this.sandboxStreams.get(execId);
    if (previous) this.stopSandboxOutput(previous);
    const source = this.o.sandboxOutput;
    let lastSequence: number;
    try {
      await this.authorizeSandboxOutput(execId);
      lastSequence = await source.lastSequence(execId);
    } catch (error) {
      this.send({ type: "error", error: toHttpError(error).body.error });
      return;
    }
    if (afterCursor > lastSequence) {
      this.send({
        type: "error",
        error: new CrossoverError(
          "VALIDATION",
          "after is past the sandbox output sequence",
        ).toErrorBody().error,
      });
      return;
    }
    if (!previous && this.sandboxStreams.size >= 8) {
      this.send({
        type: "error",
        error: new CrossoverError(
          "VALIDATION",
          "At most 8 sandbox outputs may be subscribed",
        ).toErrorBody().error,
      });
      return;
    }
    const stream: SandboxStream = {
      execId,
      lastCursor: afterCursor,
      syncing: true,
      pending: [],
      pendingBytes: 0,
      bufferedBytes: 0,
      replayRequired: false,
      unsubscribe: () => {},
    };
    this.sandboxStreams.set(execId, stream);
    this.send({
      type: "sandbox.output.subscribed",
      exec_id: execId,
      after: afterCursor,
      last_sequence: lastSequence,
    });
    if (this.closed || this.sandboxStreams.get(execId) !== stream) return;
    const unsubscribe = source.subscribe(execId, (update) => this.onSandboxOutput(stream, update));
    stream.unsubscribe = unsubscribe;
    if (stream.replayRequired) {
      unsubscribe();
      return;
    }
    await this.backfillSandboxOutput(stream);
  }

  private unsubscribeSandboxOutput(frame: Record<string, unknown>): void {
    const execId = frame.exec_id;
    if (!isId(execId, "exec")) {
      this.send({
        type: "error",
        error: new CrossoverError("VALIDATION", "Unsubscribe needs an exec_ ID").toErrorBody()
          .error,
      });
      return;
    }
    const stream = this.sandboxStreams.get(execId);
    if (stream) this.stopSandboxOutput(stream);
  }

  private async authorizeSandboxOutput(execId: string): Promise<SandboxOutputMetadata> {
    const source = this.o.sandboxOutput!;
    const metadata = await source.get(execId);
    if (!metadata || metadata.room_id !== this.roomId)
      throw new CrossoverError("NOT_FOUND", "Sandbox output not found");
    try {
      await authorize(
        this.principal!,
        "sandbox.output",
        { room_id: this.roomId, sandbox_id: metadata.sandbox_id },
        { method: "sandbox.output.subscribe", params: { exec_id: execId }, client: this.o.pool },
      );
    } catch (error) {
      if (
        error instanceof CrossoverError &&
        [
          "FORBIDDEN",
          "APPROVAL_REQUIRED",
          "PARTICIPANT_PAUSED",
          "ROOM_PAUSED",
          "NOT_FOUND",
        ].includes(error.code)
      )
        throw new CrossoverError("NOT_FOUND", "Sandbox output not found");
      throw error;
    }
    const { rows } = await this.o.pool.query<{ role: string; authority: string }>(
      `SELECT role, authority FROM participants
       WHERE id = $1 AND room_id = $2 AND status = 'ACTIVE'`,
      [this.principal!.participant_id, this.roomId],
    );
    const viewer = rows[0];
    if (
      !viewer ||
      (metadata.participant_id !== this.principal!.participant_id &&
        viewer.role !== "LEAD" &&
        viewer.authority !== "OWNER" &&
        viewer.authority !== "ADMIN")
    )
      throw new CrossoverError("NOT_FOUND", "Sandbox output not found");
    return metadata;
  }

  private onSandboxOutput(stream: SandboxStream, update: SandboxOutputUpdate): void {
    if (this.sandboxStreams.get(stream.execId) !== stream || this.closed || stream.replayRequired)
      return;
    if (stream.syncing) {
      if (
        (update.kind === "chunk" &&
          (update.chunk.cursor <= stream.lastCursor ||
            stream.pending.some(
              (pending) => pending.kind === "chunk" && pending.chunk.cursor === update.chunk.cursor,
            ))) ||
        (update.kind === "finished" &&
          stream.pending.some((pending) => pending.kind === "finished"))
      )
        return;
      const bytes = sandboxUpdateBytes(update);
      if (
        stream.pendingBytes + stream.bufferedBytes + bytes >
        (this.o.maxSandboxOutputBufferedBytes ?? 1024 * 1024)
      ) {
        this.requireSandboxReplay(stream);
        return;
      }
      stream.pending.push(update);
      stream.pendingBytes += bytes;
      return;
    }
    this.deliverSandboxOutput(stream, update);
  }

  private async backfillSandboxOutput(stream: SandboxStream): Promise<void> {
    const source = this.o.sandboxOutput!;
    const pageSize = 32;
    for (;;) {
      if (this.sandboxStreams.get(stream.execId) !== stream || stream.replayRequired || this.closed)
        return;
      const chunks = await source.read(stream.execId, stream.lastCursor, pageSize);
      if (this.sandboxStreams.get(stream.execId) !== stream || stream.replayRequired || this.closed)
        return;
      for (const chunk of chunks) {
        if (!this.sendSandboxChunk(stream, chunk)) return;
      }
      if (chunks.length < pageSize) break;
    }
    while (stream.pending.length > 0) {
      const pending = stream.pending.splice(0).sort((a, b) => {
        if (a.kind === "finished") return 1;
        if (b.kind === "finished") return -1;
        return a.chunk.cursor - b.chunk.cursor;
      });
      stream.pendingBytes = 0;
      for (const update of pending) {
        if (
          this.sandboxStreams.get(stream.execId) !== stream ||
          stream.replayRequired ||
          this.closed
        )
          return;
        this.deliverSandboxOutput(stream, update);
      }
    }
    stream.syncing = false;
    const metadata = await source.get(stream.execId);
    if (
      this.sandboxStreams.get(stream.execId) === stream &&
      !stream.replayRequired &&
      !this.closed &&
      metadata?.finished_at !== undefined
    )
      this.deliverSandboxOutput(stream, { kind: "finished", metadata });
  }

  private deliverSandboxOutput(stream: SandboxStream, update: SandboxOutputUpdate): void {
    if (update.kind === "finished") {
      const sent = this.sendSandboxFrame(stream, {
        type: "sandbox.output.finished",
        exec_id: stream.execId,
        sequence: stream.lastCursor,
        exit_code: update.metadata.exit_code ?? null,
        duration_ms: update.metadata.duration_ms ?? null,
        reason: update.metadata.reason ?? null,
        truncated: update.metadata.truncated,
      });
      if (sent) this.stopSandboxOutput(stream);
      return;
    }
    if (update.chunk.cursor <= stream.lastCursor) return;
    this.sendSandboxChunk(stream, update.chunk);
  }

  private sendSandboxChunk(stream: SandboxStream, chunk: SandboxOutputChunk): boolean {
    if (chunk.cursor <= stream.lastCursor) return true;
    if (chunk.kind === "truncated") {
      return this.sendSandboxFrame(
        stream,
        { type: "sandbox.output.truncated", exec_id: stream.execId, sequence: chunk.cursor },
        chunk.cursor,
      );
    }
    return this.sendSandboxFrame(
      stream,
      {
        type: "sandbox.output",
        exec_id: stream.execId,
        sequence: chunk.cursor,
        stream: chunk.stream,
        encoding: "base64",
        data: Buffer.from(chunk.data).toString("base64"),
      },
      chunk.cursor,
    );
  }

  private sendSandboxFrame(
    stream: SandboxStream,
    frame: Record<string, unknown>,
    cursor?: number,
  ): boolean {
    if (this.sandboxStreams.get(stream.execId) !== stream || this.closed || stream.replayRequired)
      return false;
    const serialized = JSON.stringify(frame);
    const bytes = Buffer.byteLength(serialized);
    if (
      this.ws.readyState !== this.ws.OPEN ||
      stream.bufferedBytes + stream.pendingBytes + bytes >
        (this.o.maxSandboxOutputBufferedBytes ?? 1024 * 1024)
    ) {
      this.requireSandboxReplay(stream);
      return false;
    }
    stream.bufferedBytes += bytes;
    this.ws.send(serialized, (error) => {
      stream.bufferedBytes = Math.max(0, stream.bufferedBytes - bytes);
      if (error) void this.cleanup();
    });
    if (cursor !== undefined) stream.lastCursor = cursor;
    return this.sandboxStreams.get(stream.execId) === stream && !stream.replayRequired;
  }

  private requireSandboxReplay(stream: SandboxStream): void {
    if (this.sandboxStreams.get(stream.execId) !== stream || stream.replayRequired || this.closed)
      return;
    stream.replayRequired = true;
    stream.pending = [];
    stream.pendingBytes = 0;
    stream.unsubscribe();
    this.sandboxStreams.delete(stream.execId);
    if (this.ws.readyState === this.ws.OPEN)
      this.ws.send(
        JSON.stringify({
          type: "sandbox.output.resync_required",
          exec_id: stream.execId,
          after: stream.lastCursor,
        }),
      );
  }

  private stopSandboxOutput(stream?: SandboxStream): void {
    if (stream) {
      if (this.sandboxStreams.get(stream.execId) === stream)
        this.sandboxStreams.delete(stream.execId);
      stream.unsubscribe();
      return;
    }
    for (const current of this.sandboxStreams.values()) {
      this.sandboxStreams.delete(current.execId);
      current.unsubscribe();
    }
  }

  private async revalidateSandboxOutput(): Promise<void> {
    for (const stream of [...this.sandboxStreams.values()]) {
      try {
        await this.authorizeSandboxOutput(stream.execId);
      } catch (error) {
        this.stopSandboxOutput(stream);
        this.send({ type: "error", error: toHttpError(error).body.error });
      }
    }
  }

  private async stopStream(): Promise<void> {
    const stream = this.stream;
    this.stream = undefined;
    if (!stream) return;
    clearInterval(stream.poll);
    await stream.unsubscribe().catch(() => undefined);
  }

  private onLive(stream: Stream, event: RoomEvent): void {
    if (this.stream !== stream || this.closed) return;
    if (stream.syncing) {
      stream.pending.push(event);
      if (stream.pending.length > (this.o.maxBufferedEvents ?? 1000)) this.resync();
      return;
    }
    this.deliver(stream, event);
  }

  /** Send `event` if the subscriber wants it, after everything queued before it. */
  private emit(stream: Stream, event: RoomEvent): Promise<void> {
    stream.out = stream.out
      .then(() => {
        if (this.stream !== stream || this.closed) return;
        let wanted = true;
        try {
          wanted = stream.match(event);
        } catch (error) {
          // A filter that fails delivers: it may drop noise, never information.
          this.o.onInternalError?.(error);
        }
        if (!wanted) return;
        this.send({ type: "event", event: this.view(event) });
      })
      // One failing send must not leave every later one waiting behind a rejected promise.
      .catch(() => undefined);
    return stream.out;
  }

  /** Send `event` if it is the next one; on a gap, fetch the missing range from PostgreSQL. */
  private deliver(stream: Stream, event: RoomEvent): void {
    if (event.sequence <= stream.lastSent) return; // already sent (backfill overlapped)
    if (event.sequence === stream.lastSent + 1) {
      stream.lastSent = event.sequence;
      void this.emit(stream, event);
      return;
    }
    void this.catchUp(); // a gap: some message was missed
  }

  private drain(stream: Stream): void {
    const pending = stream.pending.splice(0).sort((a, b) => a.sequence - b.sequence);
    for (const event of pending) {
      if (this.stream !== stream || this.closed) return;
      this.deliver(stream, event);
    }
  }

  /** Fetch from PostgreSQL everything after what was last sent, in order, until caught up. */
  private async backfill(stream: Stream): Promise<void> {
    const pageSize = this.o.backfillPageSize ?? 200;
    for (;;) {
      if (this.stream !== stream || this.closed) return;
      const events = await listEvents(this.o.pool, this.roomId, {
        after: stream.lastSent,
        limit: pageSize,
      });
      for (const event of events) {
        stream.lastSent = event.sequence;
        await this.emit(stream, event);
      }
      if (events.length < pageSize) return;
    }
  }

  private async catchUp(): Promise<void> {
    const stream = this.stream;
    if (!stream || stream.syncing || this.closed) return;
    stream.syncing = true;
    try {
      await this.backfill(stream);
    } catch {
      // The next poll tries again.
    } finally {
      stream.syncing = false;
      this.drain(stream);
    }
  }

  private async cleanup(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    if (this.revalidate) clearInterval(this.revalidate);
    await this.stopStream();
    this.stopSandboxOutput();
    await this.stopPresence();
  }
}
