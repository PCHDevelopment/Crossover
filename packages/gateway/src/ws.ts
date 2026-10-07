import type { Pool } from "@crossover/db";
import {
  authenticate,
  type Dispatcher,
  type EventSubscriber,
  redactEventFor,
  type Principal,
} from "@crossover/kernel";
import { listEvents } from "@crossover/ledger";
import { CrossoverError, isId, newId, type RoomEvent } from "@crossover/protocol";
import type { FastifyInstance } from "fastify";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { toHttpError } from "./errors.js";

/** The WebSocket protocol versions this server speaks (§16.4). */
export const SUPPORTED_PROTOCOL_VERSIONS = [1] as const;

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
  /** Events fetched per backfill query. Default 200. */
  backfillPageSize?: number;
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
  /** Live events that arrived while a backfill was running. */
  pending: RoomEvent[];
  syncing: boolean;
  unsubscribe: () => Promise<void>;
  poll: ReturnType<typeof setInterval>;
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
 * - `subscribe { after }`: authorized as `room.events.subscribe`; the server sends
 *   `subscribed { after, last_sequence }` and then every event after `after` as
 *   `event { event }`, in sequence order and each exactly once: history from PostgreSQL, then
 *   live from Redis, and whenever a live event shows a gap (or nothing arrives for a while) the
 *   missing range is fetched from PostgreSQL.
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
        (principal) => {
          this.principal = principal; // a changed role changes what the stream shows
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
        params: { after: frame.after ?? 0 },
      });
    } catch (error) {
      this.send({ type: "error", error: toHttpError(error).body.error });
      return;
    }
    const { after, last_sequence } = auth.response as { after: number; last_sequence: number };
    await this.stopStream();

    const stream: Stream = {
      lastSent: after,
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
    this.send({ type: "subscribed", after, last_sequence });
    await this.backfill(stream);
    stream.syncing = false;
    this.drain(stream);
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

  /** Send `event` if it is the next one; on a gap, fetch the missing range from PostgreSQL. */
  private deliver(stream: Stream, event: RoomEvent): void {
    if (event.sequence <= stream.lastSent) return; // already sent (backfill overlapped)
    if (event.sequence === stream.lastSent + 1) {
      stream.lastSent = event.sequence;
      this.send({ type: "event", event: this.view(event) });
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
        this.send({ type: "event", event: this.view(event) });
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
  }
}
