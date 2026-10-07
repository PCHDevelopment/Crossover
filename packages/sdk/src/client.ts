import { isMutatingMethod, newId, type MethodName } from "@crossover/protocol";
import { makeApi, type Api, type CallOptions, type CommandResult } from "./api.js";
import { postJson, type FetchLike, type RetryOptions } from "./http.js";
import {
  RoomSocket,
  Subscription,
  type SubscribeOptions,
  type WebSocketCtor,
  type WsConfig,
} from "./ws.js";

export interface ClientOptions {
  /** The server, e.g. `https://crossover.example.com`. */
  baseUrl: string;
  /** Default: the global `fetch`. */
  fetch?: FetchLike;
  /** Default: the global `WebSocket` (Node 22 and browsers have one). */
  WebSocket?: WebSocketCtor;
  retry?: RetryOptions;
  /** Sent in the WebSocket `hello`. */
  clientName?: string;
  clientVersion?: string;
}

/** A user's session, from signing in. */
export interface UserSession {
  user: { id: string; display_name: string };
  session_token: string;
  expires_at: string;
}

/** A participant's access to one room. */
export interface RoomTokens {
  access_token: string;
  [key: string]: unknown;
}

/**
 * The Room Protocol over REST and WebSocket (§16, T1101). Sign in, create or join a room, then
 * work through a {@link RoomClient}: every command of the catalog is a typed call, mutating ones
 * carry an idempotency key (a fresh one unless you pass yours) that is reused on retries, and
 * `subscribe` keeps a live, gap-free, duplicate-free stream of the room's events.
 */
export class CrossoverClient {
  readonly options: Required<Pick<ClientOptions, "clientName" | "clientVersion">> & ClientOptions;
  private readonly fetchImpl: FetchLike;

  constructor(options: ClientOptions) {
    this.options = {
      clientName: "crossover-sdk-ts",
      clientVersion: "0.0.0",
      ...options,
      baseUrl: options.baseUrl.replace(/\/+$/, ""),
    };
    this.fetchImpl = options.fetch ?? ((...args) => fetch(...args));
  }

  /** Development servers only (`devLogin` on): sign in as anyone. */
  async devLogin(input: { subject: string; display_name: string }): Promise<UserSession> {
    const { json } = await postJson(
      this.fetchImpl,
      `${this.options.baseUrl}/v1/auth/dev-login`,
      undefined,
      input,
      this.options.retry,
    );
    return json as UserSession;
  }

  /** A command that has no room yet (`room.create`), as a signed-in user. */
  async userCommand<R = unknown>(
    session: string,
    method: MethodName,
    params: Record<string, unknown>,
    options: CallOptions = {},
  ): Promise<CommandResult<R>> {
    const { json } = await postJson(
      this.fetchImpl,
      `${this.options.baseUrl}/v1/commands`,
      session,
      envelope(method, params, options),
      this.options.retry,
      options.signal,
    );
    return json as CommandResult<R>;
  }

  /** Create a room as a signed-in user. */
  createRoom(
    session: string,
    input: { slug: string; name: string; objective: string; settings?: Record<string, unknown> },
  ): Promise<CommandResult<{ room: { id: string } & Record<string, unknown> }>> {
    return this.userCommand(session, "room.create", input);
  }

  /** Exchange a user session for a room access token (the user must be a participant). */
  async roomSession(session: string, roomId: string): Promise<{ tokens: RoomTokens }> {
    const { json } = await postJson(
      this.fetchImpl,
      `${this.options.baseUrl}/v1/rooms/${encodeURIComponent(roomId)}/session`,
      session,
      {},
      this.options.retry,
    );
    return json as { tokens: RoomTokens };
  }

  /** Join a room with an invite token and a manifest (agents). */
  async join(
    roomId: string,
    input: { token: string; manifest: Record<string, unknown> },
  ): Promise<Record<string, unknown> & { tokens: RoomTokens }> {
    const { json } = await postJson(
      this.fetchImpl,
      `${this.options.baseUrl}/v1/rooms/${encodeURIComponent(roomId)}/join`,
      undefined,
      input,
      this.options.retry,
    );
    return json as Record<string, unknown> & { tokens: RoomTokens };
  }

  /** Work in a room with its access token. */
  room(roomId: string, accessToken: string): RoomClient {
    return new RoomClient(this, roomId, accessToken, this.fetchImpl);
  }
}

function envelope(method: string, params: Record<string, unknown>, options: CallOptions) {
  return {
    id: newId("cmd"),
    method,
    params,
    ...(isMutatingMethod(method)
      ? { idempotency_key: options.idempotencyKey ?? crypto.randomUUID() }
      : {}),
  };
}

export class RoomClient {
  /** Every command of the catalog as a typed call: `room.api.tasks.create({ … })`. */
  readonly api: Api;

  constructor(
    private readonly client: CrossoverClient,
    readonly roomId: string,
    private readonly token: string,
    private readonly fetchImpl: FetchLike,
  ) {
    this.api = makeApi((method, params, options) => this.call(method, params, options));
  }

  /** Run a command over REST. Mutating commands are retried safely with the same idempotency key. */
  async call<R = unknown>(
    method: MethodName,
    params: Record<string, unknown> = {},
    options: CallOptions = {},
  ): Promise<CommandResult<R>> {
    const { json } = await postJson(
      this.fetchImpl,
      `${this.client.options.baseUrl}/v1/rooms/${encodeURIComponent(this.roomId)}/commands`,
      this.token,
      envelope(method, params, options),
      this.client.options.retry,
      options.signal,
    );
    return json as CommandResult<R>;
  }

  private wsConfig(): WsConfig {
    const o = this.client.options;
    const WebSocket = o.WebSocket ?? (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
    if (!WebSocket)
      throw new Error("No WebSocket available: pass `WebSocket` in the client options");
    return {
      url: `${o.baseUrl.replace(/^http/, "ws")}/v1/rooms/${encodeURIComponent(this.roomId)}/ws`,
      token: this.token,
      WebSocket,
      client: o.clientName,
      clientVersion: o.clientVersion,
    };
  }

  /** Commands over a WebSocket, with the same answers as REST (it doesn't reconnect by itself). */
  socket(): RoomSocket & { api: Api } {
    const socket = new RoomSocket(this.wsConfig());
    const api = makeApi((method, params, options) =>
      socket.call(method, params, isMutatingMethod(method), options),
    );
    return Object.assign(socket, { api });
  }

  /**
   * The room's events after `after` (default: from the start), then live ones: each exactly once
   * and in order, across dropped connections. See {@link Subscription}.
   */
  subscribe(options: SubscribeOptions = {}): Subscription {
    return new Subscription(this.wsConfig(), options);
  }
}
