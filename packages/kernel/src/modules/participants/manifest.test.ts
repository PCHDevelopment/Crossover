import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { authorize } from "@crossover/policy";
import { CrossoverError, newId } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Dispatcher } from "../../dispatcher.js";
import type { Principal } from "../../principal.js";
import type { AgentManifest } from "../invites/join.js";
import { registerParticipantLifecycleCommands } from "./lifecycle.js";
import { registerParticipantManifestCommand, syncAgentClientInfo } from "./manifest.js";

let db: TestDatabase;
let pool: Pool;
let n = 0;

beforeAll(async () => {
  db = await createTestDatabase();
  pool = db.pool;
});

afterAll(async () => {
  await db.drop();
});

const cmd = (method: string, params: Record<string, unknown> = {}) => ({
  id: newId("cmd"),
  method,
  params,
  idempotency_key: `k-${++n}`,
});

const WEBHOOK = "https://hooks.example.com/wake?token=s3cret";
const manifest = (extra: Partial<AgentManifest> = {}): AgentManifest => ({
  name: "Claude-1",
  operator: { name: "Peter", contact: "p@example.com" },
  vendor: "Anthropic",
  model: "model-a",
  client: "mcp",
  client_version: "1.0.0",
  description: "Writes code",
  ...extra,
});

async function add(
  room: string,
  role: string,
  kind: "AGENT" | "HUMAN" = "AGENT",
  authority = "MEMBER",
  m: AgentManifest | null = kind === "AGENT" ? manifest() : null,
) {
  const id = newId("part");
  await pool.query(
    `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status, agent_manifest)
     VALUES ($1, $2, $3, $1, $4, $5, 'ACTIVE', $6::jsonb)`,
    [id, room, kind, authority, role, m ? JSON.stringify(m) : null],
  );
  return { participant_id: id, room_id: room, kind, authority, role } as Principal;
}

async function setup() {
  const d = new Dispatcher({ pool, authorize, nodeId: `node-${++n}` });
  registerParticipantManifestCommand(d);
  registerParticipantLifecycleCommands(d);
  const room = newId("room");
  await pool.query(
    `INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'n', 'o', 'x')`,
    [room],
  );
  return {
    d,
    room,
    lead: await add(room, "LEAD"),
    owner: await add(room, "DEVELOPER", "HUMAN", "OWNER"),
    agent: await add(room, "DEVELOPER"),
    other: await add(room, "DEVELOPER"),
    human: await add(room, "DEVELOPER", "HUMAN"),
  };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const update = (s: Setup, who: Principal, m: AgentManifest, participantId?: string) =>
  s.d.dispatch(
    who,
    cmd("participants.update_manifest", {
      manifest: m,
      ...(participantId ? { participant_id: participantId } : {}),
    }),
  );
const stored = async (s: Setup, who: Principal) =>
  (await pool.query("SELECT agent_manifest FROM participants WHERE id = $1", [who.participant_id]))
    .rows[0].agent_manifest as AgentManifest;
const manifestEvents = async (s: Setup) =>
  (
    await pool.query(
      "SELECT actor_id, payload FROM events WHERE room_id = $1 AND type = 'participant.manifest_changed' ORDER BY sequence",
      [s.room],
    )
  ).rows as { actor_id: string; payload: Record<string, unknown> }[];
const inbox = async (s: Setup, who: Principal) =>
  (
    await pool.query(
      "SELECT kind, ref, summary, author_id FROM inbox_items WHERE room_id = $1 AND participant_id = $2",
      [s.room, who.participant_id],
    )
  ).rows as {
    kind: string;
    ref: { kind: string; id: string };
    summary: string;
    author_id: string;
  }[];

const rejects = async (p: Promise<unknown>, code: string) => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CrossoverError);
  expect((err as CrossoverError).code).toBe(code);
  return err as CrossoverError;
};

describe("participants.update_manifest (§34.6)", () => {
  it("stores the new manifest and emits participant.manifest_changed with what changed", async () => {
    const s = await setup();
    const next = manifest({ model: "model-b", client_version: "1.1.0" });
    const out = await update(s, s.agent, next);
    expect(out.response).toMatchObject({
      participant_id: s.agent.participant_id,
      changed: true,
      changes: {
        model: { before: "model-a", after: "model-b" },
        client_version: { before: "1.0.0", after: "1.1.0" },
      },
    });
    expect(await stored(s, s.agent)).toEqual(next);
    expect(out.events.map((e) => e.type)).toEqual(["participant.manifest_changed"]);
    expect(out.events[0]!.payload).toEqual({
      participant_id: s.agent.participant_id,
      changes: {
        model: { before: "model-a", after: "model-b" },
        client_version: { before: "1.0.0", after: "1.1.0" },
      },
    });
    expect((await manifestEvents(s))[0]!.actor_id).toBe(s.agent.participant_id);
  });

  it("the lead and the owner each get one MANIFEST_CHANGED item; nobody else, nor the agent itself", async () => {
    const s = await setup();
    await update(s, s.agent, manifest({ vendor: "OtherCo", model: "model-z" }));
    for (const who of [s.lead, s.owner]) {
      const items = await inbox(s, who);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        kind: "MANIFEST_CHANGED",
        ref: { kind: "participant", id: s.agent.participant_id },
      });
      expect(items[0]!.summary).toContain("vendor Anthropic → OtherCo");
      expect(items[0]!.summary).toContain("model model-a → model-z");
      // It quotes the agent's declared vendor and model, so it says the agent wrote it.
      expect(items[0]!.author_id).toBe(s.agent.participant_id);
    }
    for (const who of [s.agent, s.other, s.human]) expect(await inbox(s, who)).toEqual([]);
  });

  it("an identical manifest is a no-op: no event, no inbox item, no write", async () => {
    const s = await setup();
    const out = await update(s, s.agent, manifest());
    expect(out.response).toMatchObject({ changed: false, changes: {} });
    expect(out.events).toEqual([]);
    expect(await manifestEvents(s)).toEqual([]);
    expect(await inbox(s, s.lead)).toEqual([]);
  });

  it("a changed wake webhook is reported only as a flag, never the URL", async () => {
    const s = await setup();
    const added = await update(s, s.agent, manifest({ wake_webhook_url: WEBHOOK }));
    expect(added.response).toMatchObject({
      changed: true,
      changes: {},
      wake_webhook_url_changed: true,
    });
    const replaced = await update(
      s,
      s.agent,
      manifest({ wake_webhook_url: "https://hooks.example.com/other?token=n3w" }),
    );
    expect(replaced.events[0]!.payload).toMatchObject({ wake_webhook_url_changed: true });
    await update(s, s.agent, manifest()); // removed
    expect(await manifestEvents(s)).toHaveLength(3);
    // Nothing the room can read mentions the URL: not the events, not the inbox, not the responses.
    const everything = JSON.stringify({
      events: (await pool.query("SELECT payload FROM events WHERE room_id = $1", [s.room])).rows,
      inbox: (await pool.query("SELECT summary, ref FROM inbox_items WHERE room_id = $1", [s.room]))
        .rows,
      responses: [added.response, replaced.response],
    });
    expect(everything).not.toContain("hooks.example.com");
    expect(everything).not.toContain("s3cret");
    expect(
      (await inbox(s, s.lead))
        .map((i) => i.summary)
        .every((t) => t.includes("wake webhook changed")),
    ).toBe(true);
    // The stored manifest does hold it, for the platform's own wake-ups.
  });

  it("keeps the fields the platform added at join (self_declared), and doesn't call it a change", async () => {
    const s = await setup();
    await pool.query(
      "UPDATE participants SET agent_manifest = agent_manifest || $2::jsonb WHERE id = $1",
      [s.agent.participant_id, JSON.stringify({ self_declared: ["vendor", "model"] })],
    );
    const same = await update(s, s.agent, manifest());
    expect(same.response).toMatchObject({ changed: false });
    const changed = await update(s, s.agent, manifest({ model: "model-b" }));
    expect(changed.response).toMatchObject({ changed: true });
    expect(await stored(s, s.agent)).toEqual({
      ...manifest({ model: "model-b" }),
      self_declared: ["vendor", "model"],
    });
  });

  it("a change to only the name or description is stored and told to no one", async () => {
    const s = await setup();
    const next = manifest({ name: "Claude-1b", description: "Now also reviews" });
    const out = await update(s, s.agent, next);
    expect(out.response).toMatchObject({ changed: true, changes: {} });
    expect(out.events).toEqual([]);
    expect(await stored(s, s.agent)).toEqual(next);
    expect(await inbox(s, s.lead)).toEqual([]);
  });

  it("another participant's manifest → FORBIDDEN, even for the lead or the owner", async () => {
    const s = await setup();
    for (const who of [s.other, s.lead, s.owner]) {
      const err = await rejects(
        update(s, who, manifest({ model: "x" }), s.agent.participant_id),
        "FORBIDDEN",
      );
      expect(err.details).toMatchObject({ reason: "not_self" });
    }
    expect((await stored(s, s.agent)).model).toBe("model-a");
    // Naming yourself explicitly is fine.
    await update(s, s.agent, manifest({ model: "mine" }), s.agent.participant_id);
  });

  it("a human has no manifest → VALIDATION", async () => {
    const s = await setup();
    const err = await rejects(update(s, s.human, manifest()), "VALIDATION");
    expect(err.details).toMatchObject({ kind: "HUMAN" });
  });

  it("is validated like the join manifest", async () => {
    const s = await setup();
    const bad: Record<string, unknown>[] = [
      { ...manifest(), extra: 1 },
      { ...manifest(), client: "carrier-pigeon" },
      { ...manifest(), wake_webhook_url: "http://insecure.example.com" },
      { ...manifest(), model: "" },
      { ...manifest(), client_version: "v".repeat(51) },
    ];
    for (const m of bad) {
      await rejects(update(s, s.agent, m as unknown as AgentManifest), "VALIDATION");
    }
    expect(await stored(s, s.agent)).toEqual(manifest());
  });

  it("a paused agent can't update it", async () => {
    const s = await setup();
    await s.d.dispatch(
      s.owner,
      cmd("participants.pause", { participant_id: s.agent.participant_id }),
    );
    await rejects(update(s, s.agent, manifest({ model: "sneaky" })), "PARTICIPANT_PAUSED");
  });
});

describe("syncAgentClientInfo (the MCP gateway's side)", () => {
  it("a new client version is one event as system and one inbox item each for the lead and owner", async () => {
    const s = await setup();
    expect(await syncAgentClientInfo(s.d, s.agent, { name: "claude-code", version: "2.0.0" })).toBe(
      true,
    );
    const events = await manifestEvents(s);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor_id: "system",
      payload: {
        participant_id: s.agent.participant_id,
        changes: { client_version: { before: "1.0.0", after: "2.0.0" } },
      },
    });
    expect((await stored(s, s.agent)).client_version).toBe("2.0.0");
    for (const who of [s.lead, s.owner]) expect(await inbox(s, who)).toHaveLength(1);
  });

  it("reconnecting with the same version produces nothing", async () => {
    const s = await setup();
    await syncAgentClientInfo(s.d, s.agent, { name: "claude-code", version: "2.0.0" });
    // The stored manifest has the platform's own fields too; they don't make a reconnect a change.
    await pool.query(
      "UPDATE participants SET agent_manifest = agent_manifest || $2::jsonb WHERE id = $1",
      [s.agent.participant_id, JSON.stringify({ self_declared: ["vendor", "model"] })],
    );
    const writes = async () =>
      (
        await pool.query("SELECT xmin::text AS x FROM participants WHERE id = $1", [
          s.agent.participant_id,
        ])
      ).rows[0].x as string;
    const before = await writes();
    expect(await syncAgentClientInfo(s.d, s.agent, { name: "claude-code", version: "2.0.0" })).toBe(
      false,
    );
    expect(await writes(), "an unchanged reconnect writes nothing").toBe(before);
    expect(await syncAgentClientInfo(s.d, s.agent, { name: "claude-code", version: "2.0.0" })).toBe(
      false,
    );
    expect(await syncAgentClientInfo(s.d, s.agent, { name: "other-name", version: "2.0.0" })).toBe(
      false,
    );
    expect(await manifestEvents(s)).toHaveLength(1);
    expect(await inbox(s, s.lead)).toHaveLength(1);
    // The version going back is a change again.
    expect(await syncAgentClientInfo(s.d, s.agent, { version: "1.0.0" })).toBe(true);
    expect(await manifestEvents(s)).toHaveLength(2);
  });

  it("the client name is applied only when it is one of the manifest's client kinds", async () => {
    const s = await setup();
    await syncAgentClientInfo(s.d, s.agent, { name: "cli", version: "1.0.0" });
    const m = await stored(s, s.agent);
    expect(m.client).toBe("cli");
    expect((await manifestEvents(s))[0]!.payload).toMatchObject({
      changes: { client: { before: "mcp", after: "cli" } },
    });
    await syncAgentClientInfo(s.d, s.agent, { name: "Claude Code", version: "1.0.0" });
    expect((await stored(s, s.agent)).client).toBe("cli"); // free text isn't a client kind
  });

  it("keeps the rest of the manifest, the webhook included, and ignores a malformed clientInfo", async () => {
    const s = await setup();
    await pool.query("UPDATE participants SET agent_manifest = $2::jsonb WHERE id = $1", [
      s.agent.participant_id,
      JSON.stringify(manifest({ wake_webhook_url: WEBHOOK })),
    ]);
    await syncAgentClientInfo(s.d, s.agent, { version: "3.0.0" });
    expect((await stored(s, s.agent)).wake_webhook_url).toBe(WEBHOOK);
    for (const info of [
      {},
      { version: "" },
      { version: 7 },
      { version: "x".repeat(51) },
      { name: "cli" },
    ]) {
      expect(await syncAgentClientInfo(s.d, s.agent, info as never)).toBe(false);
    }
    expect(await manifestEvents(s)).toHaveLength(1);
  });

  it("is for agents, and skips a frozen room", async () => {
    const s = await setup();
    expect(await syncAgentClientInfo(s.d, s.human, { version: "9" })).toBe(false);
    await pool.query("UPDATE rooms SET status = 'PAUSED' WHERE id = $1", [s.room]);
    expect(await syncAgentClientInfo(s.d, s.agent, { version: "9.9.9" })).toBe(false);
    expect((await stored(s, s.agent)).client_version).toBe("1.0.0");
    expect(await manifestEvents(s)).toEqual([]);
  });
});
