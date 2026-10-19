import { agentCardSchema } from "@crossover/a2a";
import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import {
  Dispatcher,
  findOrCreateUser,
  issueTokens,
  registerInviteCommands,
  registerJoinCommand,
  registerLeadCommands,
  registerMessageCommands,
  registerParticipantLifecycleCommands,
  registerParticipantRoleCommand,
  registerRoomCommands,
  registerTaskCommands,
  registerTaskLifecycleCommands,
  registerTaskReadCommands,
  type Principal,
  type RoomInviteSecret,
  type TokenPair,
} from "@crossover/kernel";
import { authorize } from "@crossover/policy";
import { newId } from "@crossover/protocol";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerA2aInbound } from "./a2a-inbound.js";

let db: TestDatabase;
let pool: Pool;
let n = 0;
const apps: FastifyInstance[] = [];

beforeAll(async () => {
  db = await createTestDatabase();
  pool = db.pool;
});
afterAll(async () => {
  await Promise.all(apps.map((app) => app.close()));
  await db.drop();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Rpc = Record<string, any>;

const manifest = (name: string) => ({
  name,
  operator: { name: "Peter", contact: "p@example.com" },
  vendor: "Anthropic",
  model: "m",
  client: "a2a",
  client_version: "1",
  description: "d",
});

/** A room with an owner, a lead agent and a developer agent, behind the real policy. */
async function setup(options: { lead?: boolean } = {}) {
  const dispatcher = new Dispatcher({ pool, authorize, nodeId: `node-${++n}` });
  registerRoomCommands(dispatcher);
  registerInviteCommands(dispatcher);
  registerJoinCommand(dispatcher);
  registerParticipantRoleCommand(dispatcher);
  registerLeadCommands(dispatcher);
  registerParticipantLifecycleCommands(dispatcher);
  registerTaskCommands(dispatcher);
  registerTaskReadCommands(dispatcher);
  registerTaskLifecycleCommands(dispatcher);
  registerMessageCommands(dispatcher);
  const app = Fastify();
  registerA2aInbound(app, { dispatcher, pool, publicBaseUrl: "https://crossover.example/" });
  apps.push(app);
  await app.ready();

  const user = await findOrCreateUser(pool, {
    provider: "test",
    subject: `a2a-${++n}`,
    display_name: "Peter",
  });
  const created = await dispatcher.dispatchRoomless(
    { user_id: user.id, display_name: "Peter" },
    {
      id: newId("cmd"),
      method: "room.create",
      params: {
        slug: `a2a-${++n}-${Date.now().toString(36)}`,
        name: "Alpha room",
        objective: "Ship it",
      },
      idempotency_key: `k-${++n}`,
    },
  );
  const { room, participant } = created.response as {
    room: { id: string };
    participant: { id: string };
  };
  const ownerP: Principal = {
    participant_id: participant.id,
    room_id: room.id,
    kind: "HUMAN",
    authority: "OWNER",
    role: "LEAD",
  };
  const join = async (name: string) => {
    const invite = await dispatcher.dispatch(ownerP, {
      id: newId("cmd"),
      method: "room.invite",
      params: { role: "DEVELOPER" },
      idempotency_key: `k-${++n}`,
    });
    const joined = await dispatcher.dispatchAnonymous(
      "room.join",
      { token: (invite.one_time as RoomInviteSecret).token, manifest: manifest(name) },
      room.id,
    );
    const id = (joined.response as { participant_id: string }).participant_id;
    return {
      id,
      token: (joined.one_time as TokenPair).access_token,
      principal: {
        participant_id: id,
        room_id: room.id,
        kind: "AGENT",
        authority: "MEMBER",
        role: "DEVELOPER",
      } as Principal,
    };
  };
  const lead = await join("Lead");
  const dev = await join("Dev");
  if (options.lead !== false)
    await dispatcher.dispatch(ownerP, {
      id: newId("cmd"),
      method: "room.set_lead",
      params: { participant_id: lead.id },
      idempotency_key: `k-${++n}`,
    });
  else {
    // The creator holds the lead role until it is moved; a room with no lead has nobody in it.
    await pool.query("UPDATE rooms SET lead_participant_id = NULL WHERE id = $1", [room.id]);
    await pool.query(
      "UPDATE participants SET role = 'DEVELOPER' WHERE room_id = $1 AND role = 'LEAD'",
      [room.id],
    );
  }
  const ownerToken = (await issueTokens(pool, participant.id)).access_token;

  const rpc = async (
    token: string | undefined,
    method: string,
    params?: unknown,
    options: { roomId?: string; version?: string | null; raw?: string } = {},
  ) => {
    const response = await app.inject({
      method: "POST",
      url: `/a2a/rooms/${options.roomId ?? room.id}`,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(options.version === null ? {} : { "a2a-version": options.version ?? "1.0" }),
      },
      payload:
        options.raw ??
        JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
    });
    return { status: response.statusCode, body: response.json() as Rpc };
  };
  const as = (principal: Principal) => ({
    dispatch: (method: string, params: Record<string, unknown>) =>
      dispatcher.dispatch(principal, {
        id: newId("cmd"),
        method,
        params,
        idempotency_key: `k-${++n}`,
      }),
  });
  const task = async (title = "Fix the login") =>
    (
      await as(lead.principal).dispatch("tasks.create", {
        title,
        requirements: ["It works"],
      })
    ).response as { id: string };
  /** Move a task to a status directly; every state but OPEN needs an owner. */
  const setStatus = (
    id: string,
    status: string,
    blockedReason: string | null = null,
    ownerId: string = dev.id,
  ) =>
    pool.query(
      `UPDATE tasks SET status = $2, owner_id = CASE WHEN $2 = 'OPEN' THEN NULL ELSE $3 END,
              blocked_reason = $4 WHERE id = $1`,
      [id, status, ownerId, blockedReason],
    );
  /** The messages of the room, oldest first, as the tables hold them. */
  const messages = async () =>
    (
      await pool.query<{
        body: string;
        author_id: string;
        mentions: string[];
        refs: { id: string }[];
      }>(
        "SELECT body, author_id, mentions, refs FROM messages WHERE room_id = $1 ORDER BY created_at, id",
        [room.id],
      )
    ).rows;
  const taskCount = async () =>
    Number(
      (await pool.query("SELECT count(*) AS n FROM tasks WHERE room_id = $1", [room.id])).rows[0].n,
    );
  const card = (token: string | undefined, roomId = room.id) =>
    app.inject({
      method: "GET",
      url: `/a2a/rooms/${roomId}/.well-known/agent-card.json`,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  return {
    app,
    room: room.id,
    ownerId: participant.id,
    ownerToken,
    lead,
    dev,
    rpc,
    as,
    task,
    card,
    setStatus,
    messages,
    taskCount,
  };
}

describe("A2A inbound: the agent card (T1623)", () => {
  it("card needs a bearer; another room's token gets 404", async () => {
    const a = await setup();
    const b = await setup();
    const missing = await a.card(undefined);
    expect(missing.statusCode).toBe(401);
    expect(missing.headers["www-authenticate"]).toBe("Bearer");
    const wrongRoom = await a.card(b.dev.token);
    expect(wrongRoom.statusCode).toBe(404);
    expect((await a.card(a.dev.token, "room_nonexistent")).statusCode).toBe(404);
    expect(wrongRoom.json()).toEqual((await a.card(a.dev.token, "room_nonexistent")).json());
    expect((await a.card(a.dev.token)).statusCode).toBe(200);
  });

  it("card lists one JSONRPC 1.0 interface at /a2a/rooms/<id>", async () => {
    const s = await setup();
    const response = await s.card(s.dev.token);
    const card = agentCardSchema.parse(response.json());
    expect(card).toMatchObject({
      name: "Alpha room",
      description: "Ship it",
      capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
      provider: { organization: "Crossover", url: "https://crossover.example" },
    });
    expect(card.supportedInterfaces).toEqual([
      {
        url: `https://crossover.example/a2a/rooms/${s.room}`,
        protocolBinding: "JSONRPC",
        protocolVersion: "1.0",
      },
    ]);
    expect(response.headers["cache-control"]).toBe("no-store");
  });
});

describe("A2A inbound: the JSON-RPC pipeline (T1623)", () => {
  it("a missing token is 401 and another room's token is 404", async () => {
    const a = await setup();
    const b = await setup();
    expect((await a.rpc(undefined, "GetTask", { id: "x" })).status).toBe(401);
    expect((await a.rpc(b.dev.token, "GetTask", { id: "x" })).status).toBe(404);
  });

  it("missing A2A-Version → -32009", async () => {
    const s = await setup();
    for (const version of [null, "0.3", "1.0.0"]) {
      const { status, body } = await s.rpc(s.dev.token, "GetTask", { id: "x" }, { version });
      expect(status).toBe(200);
      expect(body["error"].code).toBe(-32009);
    }
  });

  it("bad JSON → -32700; batch → -32600; unknown method → -32601", async () => {
    const s = await setup();
    expect((await s.rpc(s.dev.token, "", undefined, { raw: "{nope" })).body["error"].code).toBe(
      -32700,
    );
    expect((await s.rpc(s.dev.token, "", undefined, { raw: "[]" })).body["error"].code).toBe(
      -32600,
    );
    expect(
      (await s.rpc(s.dev.token, "", undefined, { raw: '{"jsonrpc":"1.0","id":7,"method":"x"}' }))
        .body,
    ).toMatchObject({ id: 7, error: { code: -32600 } });
    expect((await s.rpc(s.dev.token, "Nope")).body["error"].code).toBe(-32601);
  });

  it("streaming and push methods → -32004 / -32003; the extended card → -32007", async () => {
    const s = await setup();
    for (const [method, code] of [
      ["SendStreamingMessage", -32004],
      ["SubscribeToTask", -32004],
      ["CreateTaskPushNotificationConfig", -32003],
      ["GetTaskPushNotificationConfig", -32003],
      ["ListTaskPushNotificationConfigs", -32003],
      ["DeleteTaskPushNotificationConfig", -32003],
      ["GetExtendedAgentCard", -32007],
    ] as const)
      expect((await s.rpc(s.dev.token, method, {})).body["error"].code, method).toBe(code);
  });
});

describe("A2A inbound: GetTask, ListTasks and CancelTask (T1623)", () => {
  it("GetTask maps each Crossover status per the §15.5 table", async () => {
    const s = await setup();
    const expected: Record<string, string> = {
      OPEN: "TASK_STATE_SUBMITTED",
      CLAIMED: "TASK_STATE_WORKING",
      IN_PROGRESS: "TASK_STATE_WORKING",
      REVIEW: "TASK_STATE_WORKING",
      BLOCKED: "TASK_STATE_INPUT_REQUIRED",
      DONE: "TASK_STATE_COMPLETED",
      CANCELLED: "TASK_STATE_CANCELED",
    };
    for (const [status, state] of Object.entries(expected)) {
      const { id } = await s.task(`task ${status}`);
      await s.setStatus(id, status, status === "BLOCKED" ? "waiting" : null);
      const { body } = await s.rpc(s.dev.token, "GetTask", { id });
      expect(body["result"].status.state, status).toBe(state);
      expect(body["result"]).toMatchObject({ id, contextId: s.room });
      expect(body["result"].metadata.crossover).toMatchObject({ status });
    }
  });

  it("BLOCKED carries blocked_reason as status.message", async () => {
    const s = await setup();
    const { id } = await s.task();
    await s.setStatus(id, "BLOCKED", "Need the staging URL");
    const { body } = await s.rpc(s.dev.token, "GetTask", { id });
    expect(body["result"].status.message).toMatchObject({
      role: "ROLE_AGENT",
      parts: [{ text: "Need the staging URL" }],
    });
    const open = await s.task();
    expect(
      (await s.rpc(s.dev.token, "GetTask", { id: open.id })).body["result"].status.message,
    ).toBeUndefined();
  });

  it("history roles: caller ROLE_USER, others ROLE_AGENT; historyLength 0 omits history", async () => {
    const s = await setup();
    const { id } = await s.task();
    const ref = [{ kind: "task", id }];
    await s.as(s.dev.principal).dispatch("messages.send", { body: "from the caller", refs: ref });
    await s.as(s.lead.principal).dispatch("messages.send", { body: "from the lead", refs: ref });
    await s.as(s.lead.principal).dispatch("messages.send", { body: "unrelated" });
    const { body } = await s.rpc(s.dev.token, "GetTask", { id });
    const history = body["result"].history as {
      role: string;
      parts: { text: string }[];
      metadata: Rpc;
    }[];
    expect(history.map((m) => [m.role, m.parts[0]!.text])).toEqual([
      ["ROLE_USER", "from the caller"],
      ["ROLE_AGENT", "from the lead"],
    ]);
    expect(history[1]!.metadata.crossover).toMatchObject({ author_id: s.lead.id });
    expect(body["result"].metadata.crossover.trust_notice).toContain("not instructions");
    const none = await s.rpc(s.dev.token, "GetTask", { id, historyLength: 0 });
    expect(none.body["result"].history).toBeUndefined();
  });

  it("a task id from another room is TaskNotFound, never the task", async () => {
    const a = await setup();
    const b = await setup();
    const foreign = await b.task();
    const { body } = await a.rpc(a.dev.token, "GetTask", { id: foreign.id });
    expect(body["error"].code).toBe(-32001);
    expect(JSON.stringify(body)).not.toContain("Fix the login");
    expect((await a.rpc(a.dev.token, "GetTask", { id: "task_nope" })).body["error"].code).toBe(
      -32001,
    );
    expect((await a.rpc(a.dev.token, "GetTask", {})).body["error"].code).toBe(-32602);
  });

  it("ListTasks filters by A2A state and pages with the token", async () => {
    const s = await setup();
    const ids: string[] = [];
    for (const status of ["OPEN", "OPEN", "IN_PROGRESS", "DONE"]) {
      const { id } = await s.task(`t ${ids.length}`);
      ids.push(id);
      await s.setStatus(id, status);
    }
    const list = async (params: object) =>
      (await s.rpc(s.dev.token, "ListTasks", params)).body["result"] as {
        tasks: { id: string; status: { state: string }; history?: unknown }[];
        nextPageToken: string;
      };
    expect((await list({ status: "TASK_STATE_SUBMITTED" })).tasks.map((t) => t.id)).toEqual(
      ids.slice(0, 2),
    );
    expect((await list({ status: "TASK_STATE_WORKING" })).tasks.map((t) => t.id)).toEqual([ids[2]]);
    expect((await list({ status: "TASK_STATE_FAILED" })).tasks).toEqual([]);
    expect((await list({ contextId: "room_other" })).tasks).toEqual([]);
    const page1 = await list({ pageSize: 3 });
    expect(page1.tasks).toHaveLength(3);
    expect(page1.tasks[0]!.history).toBeUndefined();
    expect(page1.nextPageToken).not.toBe("");
    const page2 = await list({ pageSize: 3, pageToken: page1.nextPageToken });
    expect(page2.tasks.map((t) => t.id)).toEqual([ids[3]]);
    expect(page2.nextPageToken).toBe("");
  });

  it("CancelTask by a developer → -32002; by the lead → TASK_STATE_CANCELED", async () => {
    const s = await setup();
    const { id } = await s.task();
    const denied = await s.rpc(s.dev.token, "CancelTask", { id });
    expect(denied.body["error"]).toMatchObject({
      code: -32002,
      data: { crossover: { error: { code: "FORBIDDEN" } } },
    });
    const cancelled = await s.rpc(s.lead.token, "CancelTask", { id });
    expect(cancelled.body["result"].status.state).toBe("TASK_STATE_CANCELED");
    const again = await s.rpc(s.lead.token, "CancelTask", { id });
    expect(again.body["error"].code).toBe(-32002);
    expect((await s.rpc(s.lead.token, "CancelTask", { id: "task_nope" })).body["error"].code).toBe(
      -32001,
    );
  });
});

const send = (
  s: Awaited<ReturnType<typeof setup>>,
  token: string,
  message: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) =>
  s.rpc(token, "SendMessage", {
    message: {
      messageId: `m-${++n}`,
      role: "ROLE_USER",
      parts: [{ text: "Please add a login page" }],
      ...message,
    },
    ...extra,
  });

describe("A2A inbound: SendMessage (T1623)", () => {
  it("creates a task, mentions the lead, and answers TASK_STATE_SUBMITTED at once", async () => {
    const s = await setup();
    const { body } = await send(s, s.dev.token, {
      parts: [{ text: "Add a login page\nWith a remember-me box" }],
    });
    const task = body["result"].task;
    expect(task.status.state).toBe("TASK_STATE_SUBMITTED");
    expect(task).toMatchObject({ contextId: s.room, id: expect.stringMatching(/^task_/) });
    const created = (await s.rpc(s.dev.token, "GetTask", { id: task.id })).body["result"];
    expect(created.metadata.crossover.status).toBe("OPEN");
    const row = await pool.query(
      "SELECT title, description, requirements FROM tasks WHERE id = $1",
      [task.id],
    );
    expect(row.rows[0]).toEqual({
      title: "Add a login page",
      description: "Add a login page\nWith a remember-me box",
      requirements: ["Answer the requesting agent's message"],
    });
    const [note] = await s.messages();
    expect(note).toMatchObject({
      body: "New A2A request: Add a login page",
      author_id: s.dev.id,
      mentions: [s.lead.id],
      refs: [{ kind: "task", id: task.id }],
    });
    expect(task.history).toHaveLength(1);
    expect(task.history[0].role).toBe("ROLE_USER");
  });

  it("uses the crossover.title and crossover.requirements metadata when given", async () => {
    const s = await setup();
    const { body } = await send(s, s.dev.token, {
      metadata: { "crossover.title": "  Ship it  ", "crossover.requirements": ["A", "B"] },
    });
    const row = await pool.query("SELECT title, requirements FROM tasks WHERE id = $1", [
      body["result"].task.id,
    ]);
    expect(row.rows[0]).toEqual({ title: "Ship it", requirements: ["A", "B"] });
    const long = await send(s, s.dev.token, { parts: [{ text: "x".repeat(300) }] });
    const longRow = await pool.query("SELECT title FROM tasks WHERE id = $1", [
      long.body["result"].task.id,
    ]);
    expect(longRow.rows[0].title).toHaveLength(200);
  });

  it("same messageId twice from one caller → one task; another caller's is separate", async () => {
    const s = await setup();
    const message = { messageId: "retry-me" };
    const first = (await send(s, s.dev.token, message)).body["result"].task.id;
    const again = (await send(s, s.dev.token, message)).body["result"].task.id;
    expect(again).toBe(first);
    expect(await s.taskCount()).toBe(1);
    expect((await s.messages()).filter((m) => m.body.startsWith("New A2A request"))).toHaveLength(
      1,
    );
    const other = (await send(s, s.lead.token, message)).body["result"].task.id;
    expect(other).not.toBe(first);
    expect(await s.taskCount()).toBe(2);
  });

  it("a lead's own request mentions nobody; a room with no lead still creates the task", async () => {
    const s = await setup();
    await send(s, s.lead.token, {});
    expect((await s.messages())[0]!.mentions).toEqual([]);
    const none = await setup({ lead: false });
    const { body } = await send(none, none.dev.token, {});
    expect(body["result"].task.status.state).toBe("TASK_STATE_SUBMITTED");
    expect((await none.messages())[0]!.mentions).toEqual([]);
  });

  it("with taskId: posts a message with the task ref and mentions the lead and a human owner, never an agent owner", async () => {
    const s = await setup();
    const human = await s.task("owned by a human");
    await s.setStatus(human.id, "IN_PROGRESS", null, s.ownerId);
    const agentOwned = await s.task("owned by an agent");
    await s.setStatus(agentOwned.id, "IN_PROGRESS", null, s.dev.id);

    const reply = await send(s, s.lead.token, { taskId: human.id, parts: [{ text: "Any news?" }] });
    // The lead is the caller, so only the human owner is mentioned.
    expect(reply.body["result"].task.id).toBe(human.id);
    let messages = await s.messages();
    expect(messages.at(-1)).toMatchObject({
      body: "Any news?",
      mentions: [s.ownerId],
      refs: [{ id: human.id }],
    });

    await send(s, s.dev.token, { taskId: human.id, parts: [{ text: "Done soon" }] });
    messages = await s.messages();
    expect(messages.at(-1)!.mentions.sort()).toEqual([s.lead.id, s.ownerId].sort());

    // An agent owner is not mentioned; only the lead.
    await send(s, s.lead.token, { taskId: agentOwned.id, parts: [{ text: "Status?" }] });
    expect((await s.messages()).at(-1)!.mentions).toEqual([]);
    await send(s, s.dev.token, { taskId: agentOwned.id, parts: [{ text: "Working on it" }] });
    expect((await s.messages()).at(-1)!.mentions).toEqual([s.lead.id]);
    expect(await s.taskCount()).toBe(2);
  });

  it("with taskId and no lead: still mentions the human owner and does not fail", async () => {
    const s = await setup({ lead: false });
    const t = await s.task();
    await s.setStatus(t.id, "IN_PROGRESS", null, s.ownerId);
    const { body } = await send(s, s.dev.token, { taskId: t.id, parts: [{ text: "ping" }] });
    expect(body["error"]).toBeUndefined();
    expect((await s.messages()).at(-1)!.mentions).toEqual([s.ownerId]);
  });

  it("an unknown task, or another room's, is TaskNotFound", async () => {
    const a = await setup();
    const b = await setup();
    const foreign = await b.task();
    expect((await send(a, a.dev.token, { taskId: foreign.id })).body["error"].code).toBe(-32001);
    expect((await send(a, a.dev.token, { taskId: "task_nope" })).body["error"].code).toBe(-32001);
    expect((await a.messages()).length).toBe(0);
  });

  it("file part → -32005; bad role, contextId, messageId or text → -32602", async () => {
    const s = await setup();
    const code = async (message: Record<string, unknown>) =>
      (await send(s, s.dev.token, message)).body["error"]?.code;
    expect(await code({ parts: [{ url: "https://example.com/a.pdf" }] })).toBe(-32005);
    expect(await code({ parts: [{ raw: "aGk=" }] })).toBe(-32005);
    expect(await code({ role: "ROLE_AGENT" })).toBe(-32602);
    expect(await code({ contextId: "room_other" })).toBe(-32602);
    expect(await code({ messageId: "m".repeat(101) })).toBe(-32602);
    expect(await code({ parts: [{ text: "x".repeat(20_001) }] })).toBe(-32602);
    expect(await code({ parts: [{ text: "   " }] })).toBe(-32602);
    expect((await s.rpc(s.dev.token, "SendMessage", {})).body["error"].code).toBe(-32602);
    expect(await s.taskCount()).toBe(0);
  });

  it("a data part becomes a fenced json block after the text", async () => {
    const s = await setup();
    const { body } = await send(s, s.dev.token, {
      parts: [{ text: "Config:" }, { data: { retries: 3 } }],
    });
    const row = await pool.query("SELECT description FROM tasks WHERE id = $1", [
      body["result"].task.id,
    ]);
    expect(row.rows[0].description).toBe('Config:\n\n```json\n{\n  "retries": 3\n}\n```');
  });
});
