import {
  A2A_ERRORS,
  A2A_PROTOCOL_VERSION,
  agentCardSchema,
  cancelTaskRequestSchema,
  fromA2aStates,
  getTaskRequestSchema,
  jsonRpcError,
  jsonRpcRequestSchema,
  listTasksRequestSchema,
  sendMessageRequestSchema,
  toA2aTask,
  type AgentCard,
  type CrossoverMessageView,
  type CrossoverTaskView,
} from "@crossover/a2a";
import type { Pool } from "@crossover/db";
import { toHttpError } from "@crossover/gateway";
import { authenticate, type Dispatcher, type Principal } from "@crossover/kernel";
import { CrossoverError, newId } from "@crossover/protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export interface A2aInboundOptions {
  dispatcher: Dispatcher;
  pool: Pool;
  /** The server's public origin, no path. */
  publicBaseUrl: string;
  /** Called for an unexpected failure (a 500 on REST); never given parameters. */
  onInternalError?: (
    error: unknown,
    context: { method: string; room_id: string; participant_id: string },
  ) => void;
}

const BEARER = /^Bearer ([^\s]+)$/i;
const BODY_LIMIT = 1_048_576;
const DEFAULT_HISTORY = 20;
const MAX_HISTORY = 100;
const DEFAULT_PAGE = 50;
const NO_STORE = "no-store";
const MAX_TEXT_CHARS = 20_000;
const MAX_TITLE_CHARS = 200;
const DEFAULT_TITLE = "A2A request";
const DEFAULT_REQUIREMENT = "Answer the requesting agent's message";

/** A JSON-RPC method this server declines on purpose, with the error that says why (§15.5). */
const DECLINED: Record<string, { code: number; message: string }> = {
  SendStreamingMessage: {
    code: A2A_ERRORS.UnsupportedOperation,
    message: "Streaming is not supported",
  },
  SubscribeToTask: { code: A2A_ERRORS.UnsupportedOperation, message: "Streaming is not supported" },
  CreateTaskPushNotificationConfig: {
    code: A2A_ERRORS.PushNotificationNotSupported,
    message: "Push notifications are not supported",
  },
  GetTaskPushNotificationConfig: {
    code: A2A_ERRORS.PushNotificationNotSupported,
    message: "Push notifications are not supported",
  },
  ListTaskPushNotificationConfigs: {
    code: A2A_ERRORS.PushNotificationNotSupported,
    message: "Push notifications are not supported",
  },
  DeleteTaskPushNotificationConfig: {
    code: A2A_ERRORS.PushNotificationNotSupported,
    message: "Push notifications are not supported",
  },
  GetExtendedAgentCard: {
    code: A2A_ERRORS.ExtendedAgentCardNotConfigured,
    message: "No extended agent card is configured",
  },
};

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

function bearer(request: FastifyRequest): string {
  const match = request.headers.authorization ? BEARER.exec(request.headers.authorization) : null;
  if (!match?.[1]) throw new CrossoverError("UNAUTHENTICATED", "Missing or invalid bearer token");
  return match[1];
}

/**
 * Serve the room's A2A endpoint (T1623, §15.5): `POST /a2a/rooms/:roomId` (JSON-RPC 2.0, A2A v1.0)
 * and `GET /a2a/rooms/:roomId/.well-known/agent-card.json`. Both need the room access token from
 * the normal join flow; an unknown room and a room the token isn't for look the same (404).
 * Every read and write is one `dispatcher.dispatch` as the caller, so the participant view and
 * the policy apply as for REST and MCP; this module has no SQL.
 */
export function registerA2aInbound(app: FastifyInstance, options: A2aInboundOptions): void {
  const { dispatcher, pool } = options;
  const base = options.publicBaseUrl.replace(/\/+$/, "");

  /** The caller, or the HTTP answer to send instead. */
  async function caller(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Principal | undefined> {
    const roomId = (request.params as { roomId: string }).roomId;
    let principal: Principal;
    try {
      principal = await authenticate(pool, bearer(request));
    } catch (error) {
      const mapped = toHttpError(error);
      if (mapped.status === 401) void reply.header("WWW-Authenticate", "Bearer");
      await reply.status(mapped.status).header("Cache-Control", NO_STORE).send(mapped.body);
      return undefined;
    }
    if (principal.room_id !== roomId) {
      const body = new CrossoverError("NOT_FOUND", "Not found").toErrorBody();
      await reply.status(404).header("Cache-Control", NO_STORE).send(body);
      return undefined;
    }
    return principal;
  }

  const call = async (
    principal: Principal,
    method: string,
    params: Record<string, unknown>,
    key?: string,
  ) =>
    (
      await dispatcher.dispatch(principal, {
        id: newId("cmd"),
        method,
        params,
        ...(key === undefined ? {} : { idempotency_key: key }),
      })
    ).response;

  /** A task by id; `NOT_FOUND` (also for another room's id) is A2A's TaskNotFound. */
  async function loadTask(principal: Principal, id: string): Promise<CrossoverTaskView> {
    try {
      return (await call(principal, "tasks.get", { task_id: id })) as CrossoverTaskView;
    } catch (error) {
      if (error instanceof CrossoverError && error.code === "NOT_FOUND")
        throw new RpcError(A2A_ERRORS.TaskNotFound, "Task not found");
      throw error;
    }
  }

  /** The lead and each participant's kind, from the summary room state (no SQL here). */
  async function roomPeople(principal: Principal) {
    const state = (await call(principal, "room.get_state", { view: "summary" })) as {
      sections: {
        room: { lead_participant_id: string | null };
        participants: { id: string; kind: string }[];
      };
    };
    return {
      lead: state.sections.room.lead_participant_id,
      kindOf: (id: string | null) => state.sections.participants.find((p) => p.id === id)?.kind,
    };
  }

  /** The text of a message: its text parts, then each data part as a fenced JSON block. */
  function messageText(
    parts: { text?: string | undefined; data?: unknown; raw?: unknown; url?: unknown }[],
  ) {
    if (parts.some((part) => part.raw !== undefined || part.url !== undefined))
      throw new RpcError(A2A_ERRORS.ContentTypeNotSupported, "Files are not supported");
    const text = parts
      .map((part) =>
        part.text !== undefined
          ? part.text
          : `\`\`\`json\n${JSON.stringify(part.data, null, 2)}\n\`\`\``,
      )
      .join("\n\n");
    if (text.trim() === "" || text.length > MAX_TEXT_CHARS)
      throw new RpcError(A2A_ERRORS.InvalidParams, "The message text is empty or too long");
    return text;
  }

  async function history(principal: Principal, taskId: string, length: number) {
    if (length === 0) return undefined;
    const listed = (await call(principal, "messages.list", {
      ref: { kind: "task", id: taskId },
      limit: length,
    })) as { messages: CrossoverMessageView[] };
    return listed.messages;
  }

  async function handle(principal: Principal, method: string, params: unknown): Promise<unknown> {
    const parse = <T>(schema: { safeParse(v: unknown): { success: boolean; data?: T } }): T => {
      const parsed = schema.safeParse(params ?? {});
      if (!parsed.success) throw new RpcError(A2A_ERRORS.InvalidParams, "Invalid parameters");
      return parsed.data as T;
    };
    const room = principal.room_id;
    switch (method) {
      case "GetTask": {
        const p = parse(getTaskRequestSchema);
        const task = await loadTask(principal, p.id);
        const length = Math.min(p.historyLength ?? DEFAULT_HISTORY, MAX_HISTORY);
        return toA2aTask(task, {
          contextId: room,
          callerId: principal.participant_id,
          history: await history(principal, task.id, length),
        });
      }
      case "SendMessage": {
        const p = parse(sendMessageRequestSchema);
        const m = p.message;
        if (m.role !== "ROLE_USER")
          throw new RpcError(A2A_ERRORS.InvalidParams, "The message role must be ROLE_USER");
        if (m.contextId !== undefined && m.contextId !== room)
          throw new RpcError(A2A_ERRORS.InvalidParams, "Unknown contextId");
        if (m.messageId.length > 100)
          throw new RpcError(A2A_ERRORS.InvalidParams, "messageId is too long");
        const text = messageText(m.parts);
        const people = await roomPeople(principal);
        const caller = principal.participant_id;
        let taskId: string;
        if (m.taskId === undefined) {
          const meta = m.metadata ?? {};
          const named = typeof meta["crossover.title"] === "string" ? meta["crossover.title"] : "";
          // From the text parts only: a data part's fenced block must never become a title.
          const firstLine = m.parts
            .flatMap((part) => (part.text === undefined ? [] : part.text.split("\n")))
            .find((line) => line.trim());
          const title = (named.trim() || firstLine?.trim() || DEFAULT_TITLE).slice(
            0,
            MAX_TITLE_CHARS,
          );
          const requirements = meta["crossover.requirements"];
          const created = (await call(
            principal,
            "tasks.create",
            {
              title,
              description: text,
              requirements: Array.isArray(requirements) ? requirements : [DEFAULT_REQUIREMENT],
            },
            `a2a:create:${m.messageId}`,
          )) as CrossoverTaskView;
          taskId = created.id;
          await call(
            principal,
            "messages.send",
            {
              body: `New A2A request: ${title}`,
              refs: [{ kind: "task", id: taskId }],
              mentions: people.lead && people.lead !== caller ? [people.lead] : [],
            },
            `a2a:notify:${m.messageId}`,
          );
        } else {
          const task = await loadTask(principal, m.taskId);
          taskId = task.id;
          // The lead (an agent or a human) and the owner when a human; an agent that merely owns
          // the task is not mentioned. Each key has its own prefix with the caller's value last,
          // so a messageId containing ":" cannot collide with another operation's key.
          const targets = [
            people.lead,
            task.owner_id && people.kindOf(task.owner_id) === "HUMAN" ? task.owner_id : null,
          ].filter((id): id is string => id !== null && id !== caller);
          await call(
            principal,
            "messages.send",
            { body: text, refs: [{ kind: "task", id: taskId }], mentions: [...new Set(targets)] },
            `a2a:reply:${m.messageId}`,
          );
        }
        const task = await loadTask(principal, taskId);
        const length = Math.min(p.configuration?.historyLength ?? DEFAULT_HISTORY, MAX_HISTORY);
        return {
          task: toA2aTask(task, {
            contextId: room,
            callerId: caller,
            history: await history(principal, taskId, length),
          }),
        };
      }
      case "ListTasks": {
        const p = parse(listTasksRequestSchema);
        if (p.contextId !== undefined && p.contextId !== room)
          return { tasks: [], nextPageToken: "" };
        const statuses = p.status === undefined ? undefined : fromA2aStates([p.status]);
        if (statuses?.length === 0) return { tasks: [], nextPageToken: "" };
        const listed = (await call(principal, "tasks.list", {
          ...(statuses ? { status: statuses } : {}),
          limit: p.pageSize ?? DEFAULT_PAGE,
          ...(p.pageToken === undefined ? {} : { cursor: p.pageToken }),
        })) as { tasks: CrossoverTaskView[]; next_cursor: string | null };
        return {
          tasks: listed.tasks.map((t) =>
            toA2aTask(t, { contextId: room, callerId: principal.participant_id }),
          ),
          nextPageToken: listed.next_cursor ?? "",
        };
      }
      case "CancelTask": {
        const p = parse(cancelTaskRequestSchema);
        const task = await loadTask(principal, p.id);
        try {
          const cancelled = (await call(
            principal,
            "tasks.cancel",
            { task_id: task.id, expected_version: task.version },
            `a2a:cancel:${task.id}:${task.version}`,
          )) as CrossoverTaskView;
          return toA2aTask(cancelled, { contextId: room, callerId: principal.participant_id });
        } catch (error) {
          if (error instanceof CrossoverError && ["FORBIDDEN", "VALIDATION"].includes(error.code))
            throw new RpcError(A2A_ERRORS.TaskNotCancelable, "Task cannot be canceled", {
              crossover: toHttpError(error).body,
            });
          throw error;
        }
      }
      default: {
        const declined = DECLINED[method];
        if (declined) throw new RpcError(declined.code, declined.message);
        throw new RpcError(A2A_ERRORS.MethodNotFound, "Method not found");
      }
    }
  }

  function failure(
    id: string | number | null,
    error: unknown,
    principal: Principal,
    method: string,
  ) {
    if (error instanceof RpcError) return jsonRpcError(id, error.code, error.message, error.data);
    if (error instanceof CrossoverError) {
      if (error.code === "VALIDATION")
        return jsonRpcError(id, A2A_ERRORS.InvalidParams, error.message);
      if (error.code === "NOT_FOUND")
        return jsonRpcError(id, A2A_ERRORS.TaskNotFound, error.message);
    }
    const mapped = toHttpError(error);
    if (mapped.status === 500) {
      try {
        options.onInternalError?.(error, {
          method,
          room_id: principal.room_id,
          participant_id: principal.participant_id,
        });
      } catch {
        // A failing logger must not change the answer.
      }
      return jsonRpcError(id, A2A_ERRORS.Internal, "Internal error");
    }
    return jsonRpcError(id, A2A_ERRORS.Internal, mapped.body.error.message, {
      crossover: mapped.body,
    });
  }

  app.register(async (scope) => {
    // Its own parser, so a body that is not JSON is a JSON-RPC parse error, not a Fastify 400.
    scope.addContentTypeParser(
      "application/json",
      { parseAs: "string", bodyLimit: BODY_LIMIT },
      (_request, body, done) => done(null, body),
    );

    scope.post("/a2a/rooms/:roomId", async (request, reply) => {
      const principal = await caller(request, reply);
      if (!principal) return reply;
      void reply.header("Cache-Control", NO_STORE);
      const version =
        request.headers["a2a-version"] ?? (request.query as Record<string, string>)["A2A-Version"];
      if (version !== A2A_PROTOCOL_VERSION)
        return jsonRpcError(null, A2A_ERRORS.VersionNotSupported, "Version not supported");
      let body: unknown;
      try {
        body = JSON.parse(typeof request.body === "string" ? request.body : "");
      } catch {
        return jsonRpcError(null, A2A_ERRORS.JSONParse, "Parse error");
      }
      if (Array.isArray(body))
        return jsonRpcError(null, A2A_ERRORS.InvalidRequest, "Batch requests are not supported");
      const envelope = jsonRpcRequestSchema.safeParse(body);
      if (!envelope.success) {
        const id = (body as { id?: unknown } | null)?.id;
        return jsonRpcError(
          typeof id === "string" || typeof id === "number" ? id : null,
          A2A_ERRORS.InvalidRequest,
          "Invalid request",
        );
      }
      const { id, method, params } = envelope.data;
      try {
        return { jsonrpc: "2.0", id, result: await handle(principal, method, params) };
      } catch (error) {
        return failure(id, error, principal, method);
      }
    });

    scope.get("/a2a/rooms/:roomId/.well-known/agent-card.json", async (request, reply) => {
      const principal = await caller(request, reply);
      if (!principal) return reply;
      const state = (await call(principal, "room.get_state", { view: "summary" })) as {
        sections: { room: { name: string; objective: string } };
      };
      const { name, objective } = state.sections.room;
      const url = `${base}/a2a/rooms/${principal.room_id}`;
      const card: AgentCard = {
        name,
        description: objective.slice(0, 1_000),
        version: "1.0.0",
        supportedInterfaces: [
          { url, protocolBinding: "JSONRPC", protocolVersion: A2A_PROTOCOL_VERSION },
        ],
        capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
        defaultInputModes: ["text/plain", "application/json"],
        defaultOutputModes: ["text/plain", "application/json"],
        skills: [
          {
            id: "crossover.task",
            name: "Room task",
            description:
              "Send a request; it becomes a task in this room. SendMessage answers at once with the task's current state; poll GetTask.",
            tags: ["tasks", "collaboration"],
          },
        ],
        provider: { organization: "Crossover", url: base },
        securitySchemes: {
          bearer: {
            httpAuthSecurityScheme: {
              scheme: "Bearer",
              description: "Room access token from the invite join flow",
            },
          },
        },
      };
      return reply.header("Cache-Control", NO_STORE).send(agentCardSchema.parse(card));
    });
  });
}
