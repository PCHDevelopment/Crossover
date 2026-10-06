import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { newId } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { allowAll, Dispatcher, type UserPrincipal } from "../../dispatcher.js";
import type { Principal } from "../../principal.js";
import { registerRoomCommands } from "./create.js";
import { StateSectionRegistry, defaultStateSections, type RoomState } from "./state.js";

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

let keyN = 0;
const cmd = (method: string, params: Record<string, unknown> = {}) => ({
  id: newId("cmd"),
  method,
  params,
  idempotency_key: `k-${++keyN}`,
});
const user = (): UserPrincipal => ({ user_id: `user_secret_${++n}`, display_name: "Peter" });

interface Created {
  d: Dispatcher;
  room: string;
  owner: Principal;
}

/** A dispatcher with the room commands, and a room created through `room.create`. */
async function newRoom(options: { sections?: StateSectionRegistry } = {}): Promise<Created> {
  const d = new Dispatcher({ pool, authorize: allowAll, nodeId: `node-${++n}` });
  registerRoomCommands(d, options.sections ? { stateSections: options.sections } : {});
  const out = await d.dispatchRoomless(
    user(),
    cmd("room.create", {
      slug: `state-${++n}-${Date.now().toString(36)}`,
      name: "Crossover",
      objective: "Ship it",
    }),
  );
  const { room, participant } = out.response as {
    room: { id: string };
    participant: { id: string };
  };
  return {
    d,
    room: room.id,
    owner: {
      participant_id: participant.id,
      room_id: room.id,
      kind: "HUMAN",
      authority: "OWNER",
      role: "LEAD",
    },
  };
}

const getState = async (c: Created, params: Record<string, unknown> = {}) =>
  (await c.d.dispatch(c.owner, cmd("room.get_state", params))).response as RoomState;

async function addParticipant(room: string, fields: Record<string, unknown> = {}) {
  const cols: Record<string, unknown> = {
    id: newId("part"),
    room_id: room,
    kind: "AGENT",
    display_name: "Bot",
    role: "DEVELOPER",
    status: "ACTIVE",
    joined_at: new Date(),
    ...fields,
  };
  const keys = Object.keys(cols);
  await pool.query(
    `INSERT INTO participants (${keys.join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")})`,
    Object.values(cols),
  );
  return cols["id"] as string;
}

describe("room.get_state (summary)", () => {
  it("returns the room fields, the participants and last_sequence as named sections", async () => {
    const c = await newRoom();
    const state = await getState(c);
    expect(state.view).toBe("summary");
    expect(state.last_sequence).toBe(2); // room.created + participant.joined
    expect(Object.keys(state.sections).sort()).toEqual(["participants", "room"]);
    expect(state.sections["room"]).toMatchObject({
      id: c.room,
      name: "Crossover",
      objective: "Ship it",
      status: "ACTIVE",
      owner_id: c.owner.participant_id,
      lead_participant_id: c.owner.participant_id,
      settings: {},
      archived_at: null,
    });
    expect(typeof (state.sections["room"] as { created_at: unknown }).created_at).toBe("string");
    const participants = state.sections["participants"] as Record<string, unknown>[];
    expect(participants).toHaveLength(1);
    expect(participants[0]).toMatchObject({
      id: c.owner.participant_id,
      kind: "HUMAN",
      display_name: "Peter",
      authority: "OWNER",
      role: "LEAD",
      status: "ACTIVE",
    });
  });

  it("defaults to the summary view when none is given", async () => {
    const c = await newRoom();
    expect((await getState(c, {})).view).toBe("summary");
  });

  it("never exposes secrets: no user_id, budgets or agent manifest", async () => {
    const c = await newRoom();
    await addParticipant(c.room, {
      agent_manifest: JSON.stringify({ vendor: "acme", model: "m1", note: "internal" }),
      budgets: JSON.stringify({ tokens: 5 }),
    });
    const json = JSON.stringify(await getState(c));
    expect(json).not.toContain("user_secret_");
    expect(json).not.toContain("user_id");
    expect(json).not.toContain("agent_manifest");
    expect(json).not.toContain("budgets");
    expect(json).not.toContain("acme");
  });

  it("hides removed participants but lists the others in join order", async () => {
    const c = await newRoom();
    const first = await addParticipant(c.room, {
      display_name: "A",
      joined_at: new Date(Date.now() + 1_000),
    });
    const second = await addParticipant(c.room, {
      display_name: "B",
      joined_at: new Date(Date.now() + 2_000),
    });
    await addParticipant(c.room, { display_name: "Gone", status: "REMOVED" });
    await addParticipant(c.room, { display_name: "Invited", status: "INVITED", joined_at: null });
    const names = (
      (await getState(c)).sections["participants"] as { id: string; display_name: string }[]
    ).map((p) => p.display_name);
    expect(names).toEqual(["Peter", "A", "B", "Invited"]); // not-yet-joined last
    void first;
    void second;
  });

  it("last_sequence follows the ledger", async () => {
    const c = await newRoom();
    c.d.registerCommand({
      method: "messages.send",
      params: z.object({}),
      mutating: true,
      execute: async () => ({
        response: null,
        events: [{ type: "message.sent" as const }, { type: "message.sent" as const }],
      }),
    });
    expect((await getState(c)).last_sequence).toBe(2);
    await c.d.dispatch(c.owner, cmd("messages.send"));
    expect((await getState(c)).last_sequence).toBe(4);
    const { rows } = await pool.query("SELECT max(sequence) AS m FROM events WHERE room_id = $1", [
      c.room,
    ]);
    expect(Number(rows[0].m)).toBe(4);
  });

  it("only describes the principal's own room", async () => {
    const [a, b] = [await newRoom(), await newRoom()];
    await addParticipant(b.room, { display_name: "Only in B" });
    const state = await getState(a);
    expect(JSON.stringify(state)).not.toContain("Only in B");
    expect((state.sections["room"] as { id: string }).id).toBe(a.room);
  });
});

describe("room.get_state (full)", () => {
  it("adds budgets and the agent manifest, includes removed participants, still never user_id", async () => {
    const c = await newRoom();
    await addParticipant(c.room, {
      display_name: "Bot",
      agent_manifest: JSON.stringify({
        vendor: "acme",
        model: "m1",
        wake_webhook_url: "https://agent.internal/wake?token=s3cret",
      }),
      budgets: JSON.stringify({ tokens: 5 }),
    });
    await addParticipant(c.room, { display_name: "Gone", status: "REMOVED" });
    const state = await getState(c, { view: "full" });
    expect(state.view).toBe("full");
    const participants = state.sections["participants"] as Record<string, unknown>[];
    expect(participants.map((p) => p["display_name"])).toEqual(["Peter", "Bot", "Gone"]);
    const bot = participants.find((p) => p["display_name"] === "Bot")!;
    // The manifest is there, minus the agent's private wake endpoint.
    expect(bot["agent_manifest"]).toEqual({ vendor: "acme", model: "m1" });
    expect(JSON.stringify(state)).not.toContain("wake_webhook_url");
    expect(JSON.stringify(state)).not.toContain("s3cret");
    // A human has no manifest.
    expect(participants.find((p) => p["display_name"] === "Peter")!["agent_manifest"]).toBeNull();
    expect(bot["budgets"]).toEqual({ tokens: 5 });
    expect(JSON.stringify(state)).not.toContain("user_id");
    expect(JSON.stringify(state)).not.toContain("user_secret_");
  });

  it("rejects an unknown view", async () => {
    const c = await newRoom();
    await expect(getState(c, { view: "everything" })).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("another room, or none: NOT_FOUND (never FORBIDDEN)", () => {
  it("a room_id that isn't the principal's room → NOT_FOUND, the same as for a room that doesn't exist", async () => {
    const [a, b] = [await newRoom(), await newRoom()];
    const other = await a.d
      .dispatch(a.owner, cmd("room.get_state", { room_id: b.room }))
      .catch((e: unknown) => e);
    const missing = await a.d
      .dispatch(a.owner, cmd("room.get_state", { room_id: "room_nope" }))
      .catch((e: unknown) => e);
    for (const err of [other, missing]) {
      expect(err).toMatchObject({ code: "NOT_FOUND", message: "Room not found" });
    }
    // Identical to the caller: nothing tells an existing room from a missing one.
    expect((other as Error).message).toBe((missing as Error).message);
  });

  it("the principal's own room_id is fine", async () => {
    const c = await newRoom();
    expect((await getState(c, { room_id: c.room })).last_sequence).toBe(2);
  });

  it("a principal whose room doesn't exist → NOT_FOUND", async () => {
    const c = await newRoom();
    const ghost: Principal = { ...c.owner, room_id: "room_missing" };
    await expect(c.d.dispatch(ghost, cmd("room.get_state"))).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("sections", () => {
  it("later milestones add sections through the registry", async () => {
    const sections = defaultStateSections();
    sections.register({
      name: "tasks",
      load: async ({ room_id, view }) => ({ room_id, view, open: 0 }),
    });
    sections.register({ name: "debug", views: ["full"], load: async () => "only in full" });
    const c = await newRoom({ sections });
    const summary = await getState(c);
    expect(Object.keys(summary.sections).sort()).toEqual(["participants", "room", "tasks"]);
    expect(summary.sections["tasks"]).toEqual({ room_id: c.room, view: "summary", open: 0 });
    const full = await getState(c, { view: "full" });
    expect(Object.keys(full.sections).sort()).toEqual(["debug", "participants", "room", "tasks"]);
  });

  it("rejects a duplicate section name", () => {
    const sections = defaultStateSections();
    expect(() => sections.register({ name: "room", load: async () => null })).toThrow(
      /already registered/,
    );
  });

  it("every section is read in one snapshot: a write between two sections isn't visible", async () => {
    const sections = new StateSectionRegistry();
    sections.register({
      name: "before",
      load: async ({ client, room_id }) =>
        Number(
          (await client.query("SELECT last_sequence FROM rooms WHERE id = $1", [room_id])).rows[0]
            .last_sequence,
        ),
    });
    sections.register({
      name: "interleaved",
      load: async ({ room_id }) => {
        // Another connection commits a ledger change while the state is being read.
        await pool.query("UPDATE rooms SET last_sequence = last_sequence + 10 WHERE id = $1", [
          room_id,
        ]);
        return null;
      },
    });
    sections.register({
      name: "after",
      load: async ({ client, room_id }) =>
        Number(
          (await client.query("SELECT last_sequence FROM rooms WHERE id = $1", [room_id])).rows[0]
            .last_sequence,
        ),
    });
    const c = await newRoom({ sections });
    const state = await getState(c);
    expect(state.last_sequence).toBe(2);
    expect(state.sections["before"]).toBe(2);
    expect(state.sections["after"]).toBe(2); // not 12: same snapshot as `before` and last_sequence
  });

  it("releases its connection even when a section fails", async () => {
    const sections = new StateSectionRegistry();
    sections.register({
      name: "boom",
      load: async () => {
        throw new Error("section failed");
      },
    });
    const c = await newRoom({ sections });
    for (let i = 0; i < 5; i++) {
      await expect(getState(c)).rejects.toThrow("section failed");
    }
    expect(pool.totalCount - pool.idleCount).toBe(0);
    // ...and the pooled connection isn't left inside a transaction.
    const client = await pool.connect();
    try {
      expect((await client.query("SELECT txid_current_if_assigned() AS x")).rows).toHaveLength(1);
    } finally {
      client.release();
    }
  });
});

describe("authorization", () => {
  it("declares room.read as its action and runs it through the authorizer", async () => {
    const actions: string[] = [];
    const d = new Dispatcher({
      pool,
      authorize: async (_p, action) => void actions.push(action),
      nodeId: `node-${++n}`,
    });
    registerRoomCommands(d);
    const out = await d.dispatchRoomless(
      user(),
      cmd("room.create", {
        slug: `auth-${++n}-${Date.now().toString(36)}`,
        name: "n",
        objective: "o",
      }),
    );
    const { room, participant } = out.response as {
      room: { id: string };
      participant: { id: string };
    };
    await d.dispatch(
      {
        participant_id: participant.id,
        room_id: room.id,
        kind: "HUMAN",
        authority: "OWNER",
        role: "LEAD",
      },
      cmd("room.get_state"),
    );
    expect(actions).toEqual(["room.read"]);
  });
});
