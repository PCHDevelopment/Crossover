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
async function setup() {
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
  await dispatcher.dispatch(ownerP, {
    id: newId("cmd"),
    method: "room.set_lead",
    params: { participant_id: lead.id },
    idempotency_key: `k-${++n}`,
  });
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
  const setStatus = (id: string, status: string, blockedReason: string | null = null) =>
    pool.query(
      `UPDATE tasks SET status = $2, owner_id = CASE WHEN $2 = 'OPEN' THEN NULL ELSE $3 END,
              blocked_reason = $4 WHERE id = $1`,
      [id, status, dev.id, blockedReason],
    );
  const card = (token: string | undefined, roomId = room.id) =>
    app.inject({
      method: "GET",
      url: `/a2a/rooms/${roomId}/.well-known/agent-card.json`,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  return { app, room: room.id, ownerToken, lead, dev, rpc, as, task, card, setStatus };
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
    // SendMessage arrives with the next part.
    expect((await s.rpc(s.dev.token, "SendMessage", {})).body["error"].code).toBe(-32601);
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
