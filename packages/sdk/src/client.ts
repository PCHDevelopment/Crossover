import { CrossoverError, isMutatingMethod, newId, type MethodName } from "@crossover/protocol";
import { makeApi, type Api, type CallOptions, type CommandResult } from "./api.js";
import { TokenStore, type RoomTokens, type TokenOptions } from "./tokens.js";
import { errorFromBody, postJson, type FetchLike, type RetryOptions } from "./http.js";
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

/** What a room session says about the participant it is for, with its tokens. */
export interface RoomSessionInfo {
  participant_id: string;
  room_id: string;
  role: string;
  authority: string;
  display_name: string;
  tokens: RoomTokens;
}

/** A room a user belongs to (`GET /v1/rooms`). */
export interface UserRoomInfo {
  id: string;
  slug: string;
  name: string;
  objective: string;
  status: string;
  participant_id: string;
  role: string;
  authority: string;
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
  /** Token stores by the refresh token they started from: one per login. */
  private readonly stores = new Map<string, TokenStore>();

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

  /** The rooms a signed-in user belongs to. */
  async rooms(session: string): Promise<UserRoomInfo[]> {
    const res = await this.fetchImpl(`${this.options.baseUrl}/v1/rooms`, {
      headers: { authorization: `Bearer ${session}` },
    });
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) throw errorFromBody(json, res.status);
    return (json as { rooms: UserRoomInfo[] }).rooms;
  }

  /** Create a room as a signed-in user. */
  createRoom(
    session: string,
    input: { slug: string; name: string; objective: string; settings?: Record<string, unknown> },
  ): Promise<CommandResult<{ room: { id: string } & Record<string, unknown> }>> {
    return this.userCommand(session, "room.create", input);
  }

  /** Exchange a user session for a room access token (the user must be a participant). */
  async roomSession(session: string, roomId: string): Promise<RoomSessionInfo> {
    const { json } = await postJson(
      this.fetchImpl,
      `${this.options.baseUrl}/v1/rooms/${encodeURIComponent(roomId)}/session`,
      session,
      {},
      this.options.retry,
    );
    return json as RoomSessionInfo;
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
      // An invite is single-use: a retry after a lost answer would be refused, so don't retry.
      { ...this.options.retry, attempts: 1 },
    );
    return json as Record<string, unknown> & { tokens: RoomTokens };
  }

  /**
   * Work in a room with its access token, or with the `tokens` that `join` / `roomSession`
   * returned: then an expired access token is renewed with the refresh token (once, however many
   * calls and subscriptions notice) and the request retried, and `onTokens` receives each new pair
   * to persist (refresh tokens are single-use). `onTokens` runs after the new pair is held in
   * memory: if it throws, the call that triggered the refresh fails with that error but the client
   * keeps working with the new pair (so persist best-effort, and expect a restart to need a new
   * login if you lost it). Rooms entered with the same refresh token share one token store, so two
   * `room()` calls never refresh the same login twice.
   */
  room(roomId: string, tokens: string | RoomTokens, options: TokenOptions = {}): RoomClient {
    const login = typeof tokens === "string" ? undefined : tokens.refresh_token;
    let store = login ? this.stores.get(login) : undefined;
    if (!store) {
      store = new TokenStore(
        tokens,
        `${this.options.baseUrl}/v1/auth/refresh`,
        this.fetchImpl,
        this.options.retry,
        options,
      );
      if (login) this.stores.set(login, store);
    }
    return new RoomClient(this, roomId, store, this.fetchImpl);
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
    private readonly tokens: TokenStore,
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
    // One envelope, so a retry after renewing the token carries the same idempotency key.
    const body = envelope(method, params, options);
    const url = `${this.client.options.baseUrl}/v1/rooms/${encodeURIComponent(this.roomId)}/commands`;
    for (let renewed = false; ; renewed = true) {
      const token = this.tokens.access;
      try {
        const { json } = await postJson(
          this.fetchImpl,
          url,
          token,
          body,
          this.client.options.retry,
          options.signal,
        );
        return json as CommandResult<R>;
      } catch (error) {
        const expired = error instanceof CrossoverError && error.code === "UNAUTHENTICATED";
        if (!expired || renewed || !(await this.tokens.refreshAfter(token))) throw error;
      }
    }
  }

  private wsConfig(): WsConfig {
    const o = this.client.options;
    const WebSocket = o.WebSocket ?? (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
    if (!WebSocket)
      throw new Error("No WebSocket available: pass `WebSocket` in the client options");
    return {
      url: `${o.baseUrl.replace(/^http/, "ws")}/v1/rooms/${encodeURIComponent(this.roomId)}/ws`,
      token: this.tokens.access,
      getToken: () => this.tokens.access,
      refresh: (failed) => this.tokens.refreshAfter(failed),
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
