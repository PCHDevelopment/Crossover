import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import type { EventPublisher } from "@crossover/kernel";
import { newId } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeServer, type CrossoverServer } from "../compose.js";
import type { ServerConfig } from "../config.js";

/** Approval gates (§22.2) through the real server: the policy, the queue and the approved command. */

let db: TestDatabase;
let root: string;
let server: CrossoverServer;
let serial = 0;

beforeAll(async () => {
  db = await createTestDatabase();
  root = await mkdtemp(join(tmpdir(), "crossover-approvals-e2e-"));
  const config: ServerConfig = {
    databaseUrl: "unused: test pool is injected",
    redisUrl: process.env["REDIS_URL"] ?? "redis://localhost:6379",
    workspaceRoot: root,
    host: "127.0.0.1",
    port: 0,
    nodeId: `approvals-e2e-${process.pid}`,
    devLogin: true,
    healthImages: ["node:22-bookworm-slim"],
  };
  const publisher: EventPublisher = { publish: async () => undefined };
  server = await composeServer(config, { pool: db.pool, publisher });
});

afterAll(async () => {
  await server?.close();
  await db?.drop();
  await rm(root, { recursive: true, force: true });
});

const envelope = (method: string, params: Record<string, unknown> = {}) => ({
  id: newId("cmd"),
  method,
  params,
  idempotency_key: `approvals-e2e-${++serial}`,
});
const post = (url: string, payload: unknown, token?: string) =>
  server.app.inject({
    method: "POST",
    url,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    payload: JSON.stringify(payload),
  });
async function ok(res: Awaited<ReturnType<typeof post>>, status = 200) {
  expect(res.statusCode, res.body).toBe(status);
  return res.json();
}

async function newRoom() {
  const login = await ok(
    await post("/v1/auth/dev-login", { subject: `apr-${newId("usr")}`, display_name: "Owner" }),
  );
  const created = await ok(
    await post(
      "/v1/commands",
      envelope("room.create", {
        slug: `apr-${++serial}`,
        name: "Approvals",
        objective: "Ask first",
      }),
      login.session_token,
    ),
  );
  const roomId = created.response.room.id as string;
  const owner = (await ok(await post(`/v1/rooms/${roomId}/session`, {}, login.session_token)))
    .tokens.access_token as string;
  const join = async (name: string) => {
    const invite = await ok(
      await post(
        `/v1/rooms/${roomId}/commands`,
        envelope("room.invite", { role: "DEVELOPER" }),
        owner,
      ),
    );
    const joined = await ok(
      await post(`/v1/rooms/${roomId}/join`, {
        token: invite.one_time.token,
        manifest: {
          name,
          operator: { name: "P", contact: "p@example.com" },
          vendor: "Anthropic",
          model: "m",
          client: "mcp",
          client_version: "1",
          description: "d",
        },
      }),
      201,
    );
    const id = (
      await db.pool.query(
        "SELECT id FROM participants WHERE room_id = $1 AND display_name = $2 AND kind = 'AGENT'",
        [roomId, name],
      )
    ).rows[0].id as string;
    return { token: joined.tokens.access_token as string, id };
  };
  const dev = await join("Dev");
  const call = (token: string, method: string, params: Record<string, unknown> = {}) =>
    post(`/v1/rooms/${roomId}/commands`, envelope(method, params), token);
  const gate = async (participant: string, capability = "messages.send") =>
    ok(
      await call(owner, "capabilities.grant", {
        participant_id: participant,
        capability,
        requires_approval: true,
      }),
    );
  const events = async (type: string) =>
    (
      await db.pool.query(
        "SELECT actor_id, payload FROM events WHERE room_id = $1 AND type = $2 ORDER BY sequence",
        [roomId, type],
      )
    ).rows;
  const messages = async () =>
    (await ok(await call(owner, "messages.list"))).response.messages as {
      body: string;
      author_id: string;
    }[];
  const inbox = async (token: string) =>
    (await ok(await call(token, "inbox.list"))).response.items as {
      kind: string;
      ref: { id: string };
      summary: string;
    }[];
  return { roomId, owner, dev, call, gate, events, messages, inbox };
}

describe("approval gates over HTTP", () => {
  it("a gated command waits: 202 with an approval id, kept whole, told to the owner, deduplicated on retry", async () => {
    const r = await newRoom();
    await r.gate(r.dev.id);
    const request = envelope("messages.send", { body: "ship it" });
    const first = await post(`/v1/rooms/${r.roomId}/commands`, request, r.dev.token);
    expect(first.statusCode).toBe(202);
    const approvalId = first.json().error.details.approval_id as string;
    expect(first.json().error.code).toBe("APPROVAL_REQUIRED");
    expect(await r.messages()).toEqual([]);

    const retry = await post(`/v1/rooms/${r.roomId}/commands`, request, r.dev.token);
    expect(retry.json().error.details.approval_id).toBe(approvalId);
    expect(await r.events("approval.requested")).toHaveLength(1);

    const owner = (await r.inbox(r.owner)).filter((i) => i.kind === "APPROVAL");
    expect(owner).toHaveLength(1);
    expect(owner[0]).toMatchObject({ ref: { id: approvalId } });
    expect(owner[0]!.summary).toContain("messages.send");
    expect((await r.inbox(r.dev.token)).filter((i) => i.kind === "APPROVAL")).toEqual([]);

    const list = await ok(await r.call(r.owner, "approvals.list"));
    expect(list.response.approvals).toMatchObject([
      {
        id: approvalId,
        requester_id: r.dev.id,
        method: "messages.send",
        params: { body: "ship it" },
        status: "PENDING",
      },
    ]);
    expect(list.response.approvals[0].provenance).toMatchObject({
      author_id: r.dev.id,
      author_kind: "AGENT",
    });
    const mine = await ok(await r.call(r.dev.token, "approvals.list"));
    expect(mine.response.approvals).toHaveLength(1);
  });

  it("approving runs the command once, as the requester; the retry can't run it again; deciding twice is refused", async () => {
    const r = await newRoom();
    await r.gate(r.dev.id);
    const request = envelope("messages.send", { body: "ship it" });
    const approvalId = (await post(`/v1/rooms/${r.roomId}/commands`, request, r.dev.token)).json()
      .error.details.approval_id as string;

    const decide = envelope("approvals.decide", { approval_id: approvalId, decision: "approve" });
    const done = await post(`/v1/rooms/${r.roomId}/commands`, decide, r.owner);
    expect(done.statusCode).toBe(200);
    expect(done.json().response.approval).toMatchObject({ status: "APPROVED" });
    expect(done.json().response.result).toMatchObject({ body: "ship it", author_id: r.dev.id });
    expect(await r.messages()).toMatchObject([{ body: "ship it", author_id: r.dev.id }]);
    expect((await r.events("message.sent"))[0]!.actor_id).toBe(r.dev.id);
    expect(await r.events("approval.decided")).toMatchObject([
      { actor_id: expect.any(String), payload: { approval_id: approvalId, decision: "approve" } },
    ]);
    expect((await r.inbox(r.dev.token)).some((i) => i.kind === "APPROVAL")).toBe(true);

    // The same decide request again is a replay; another is refused; the requester's retry is not a second run.
    const replay = await post(`/v1/rooms/${r.roomId}/commands`, decide, r.owner);
    expect(replay.statusCode).toBe(200);
    const again = await r.call(r.owner, "approvals.decide", {
      approval_id: approvalId,
      decision: "approve",
    });
    expect(again.statusCode).toBe(400);
    expect(again.json().error.details.reason).toBe("already_decided");
    const retry = await post(`/v1/rooms/${r.roomId}/commands`, request, r.dev.token);
    expect(retry.statusCode).toBe(400);
    expect(retry.json().error.details.reason).toBe("already_approved");
    expect(await r.messages()).toHaveLength(1);
  });

  it("rejecting never runs it", async () => {
    const r = await newRoom();
    await r.gate(r.dev.id);
    const approvalId = (await r.call(r.dev.token, "messages.send", { body: "no" })).json().error
      .details.approval_id as string;
    const out = await ok(
      await r.call(r.owner, "approvals.decide", {
        approval_id: approvalId,
        decision: "reject",
        note: "not now",
      }),
    );
    expect(out.response.approval).toMatchObject({ status: "REJECTED", note: "not now" });
    expect(await r.messages()).toEqual([]);
    expect(await r.events("message.sent")).toEqual([]);
  });

  it("an approval lapses after 24 hours: it reads EXPIRED and can't be approved", async () => {
    const r = await newRoom();
    await r.gate(r.dev.id);
    const approvalId = (await r.call(r.dev.token, "messages.send", { body: "late" })).json().error
      .details.approval_id as string;
    await db.pool.query(
      "UPDATE approvals SET created_at = created_at - interval '25 hours', expires_at = clock_timestamp() - interval '1 hour' WHERE id = $1",
      [approvalId],
    );
    expect((await ok(await r.call(r.owner, "approvals.list"))).response.approvals).toEqual([]);
    const expired = await ok(await r.call(r.owner, "approvals.list", { status: "EXPIRED" }));
    expect(expired.response.approvals).toMatchObject([{ id: approvalId, status: "EXPIRED" }]);
    const res = await r.call(r.owner, "approvals.decide", {
      approval_id: approvalId,
      decision: "approve",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details.reason).toBe("expired");
    expect(await r.messages()).toEqual([]);
  });

  it("a developer can't decide; nobody decides their own request; a revoked capability stops an approved command", async () => {
    const r = await newRoom();
    const other = await (async () => {
      return r.dev;
    })();
    await r.gate(other.id);
    const approvalId = (await r.call(other.token, "messages.send", { body: "mine" })).json().error
      .details.approval_id as string;
    const byDev = await r.call(other.token, "approvals.decide", {
      approval_id: approvalId,
      decision: "approve",
    });
    expect(byDev.statusCode).toBe(403);

    // The owner is gated too: their own request can't be approved by themselves.
    const ownerId = (await db.pool.query("SELECT owner_id FROM rooms WHERE id = $1", [r.roomId]))
      .rows[0].owner_id as string;
    await r.gate(ownerId);
    const ownReq = (await r.call(r.owner, "messages.send", { body: "owner's" })).json().error
      .details.approval_id as string;
    const self = await r.call(r.owner, "approvals.decide", {
      approval_id: ownReq,
      decision: "approve",
    });
    expect(self.statusCode).toBe(403);
    expect(self.json().error.details.reason).toBe("self_approval");

    // Revoke the developer's capability after they asked: approving no longer runs it.
    await ok(
      await r.call(r.owner, "capabilities.revoke", {
        participant_id: other.id,
        capability: "messages.send",
      }),
    );
    const blocked = await r.call(r.owner, "approvals.decide", {
      approval_id: approvalId,
      decision: "approve",
    });
    expect(blocked.statusCode).toBe(403);
    expect(await r.messages()).toEqual([]);
    const still = await ok(await r.call(r.owner, "approvals.list"));
    expect(still.response.approvals.map((a: { id: string }) => a.id)).toContain(approvalId);
  });
});
