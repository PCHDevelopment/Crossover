import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { authorize } from "@crossover/policy";
import { newId } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { Dispatcher } from "./dispatcher.js";
import type { Principal } from "./principal.js";

// The real policy wired into the real dispatcher: commands declare their capability as the
// `action`, and `authorize` from @crossover/policy is the dispatcher's authorizer.

let db: TestDatabase;
let pool: Pool;
let n = 0;

beforeAll(async () => {
  db = await createTestDatabase();
  pool = db.pool;
  await pool.query("CREATE TABLE side_effects (id serial PRIMARY KEY, room_id text, tag text)");
});

afterAll(async () => {
  await db.drop();
});

async function room(): Promise<string> {
  const id = `room_${++n}`;
  await pool.query(
    `INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'n', 'o', 'x')`,
    [id],
  );
  return id;
}

async function login(roomId: string, role: string, authority = "MEMBER") {
  const id = `part_${++n}`;
  await pool.query(
    `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status)
     VALUES ($1, $2, 'HUMAN', 'Ada', $3, $4, 'ACTIVE')`,
    [id, roomId, authority, role],
  );
  // The snapshot `authenticate` would return. The policy re-reads role and authority from
  // the database, so these fields are not what decides.
  const principal: Principal = {
    participant_id: id,
    room_id: roomId,
    kind: "HUMAN",
    authority: authority as Principal["authority"],
    role: role as Principal["role"],
  };
  return { id, principal };
}

function dispatcher(): Dispatcher {
  const d = new Dispatcher({ pool, authorize, nodeId: `node-${++n}` });
  d.registerCommand({
    method: "workspace.apply_changeset",
    action: "workspace.write",
    params: z.object({}),
    mutating: true,
    execute: async (ctx) => {
      await ctx.client.query("INSERT INTO side_effects (room_id, tag) VALUES ($1, 'written')", [
        ctx.room_id,
      ]);
      return { response: "ok", events: [{ type: "workspace.changeset.applied" as const }] };
    },
  });
  d.registerCommand({
    method: "workspace.read",
    action: "workspace.read",
    params: z.object({}),
    mutating: false,
    execute: async () => ({ response: "contents" }),
  });
  d.registerCommand({
    method: "room.archive",
    action: "room.archive",
    params: z.object({}),
    mutating: true,
    execute: async () => ({ response: "archived" }),
  });
  return d;
}

let keyN = 0;
const cmd = (method: string) => ({
  id: newId("cmd"),
  method,
  params: {},
  idempotency_key: `k-${++keyN}`,
});
const effects = async (roomId: string) =>
  (await pool.query("SELECT 1 FROM side_effects WHERE room_id = $1", [roomId])).rowCount;
const lastSeq = async (roomId: string) =>
  Number(
    (await pool.query("SELECT last_sequence FROM rooms WHERE id = $1", [roomId])).rows[0]
      .last_sequence,
  );

describe("the real policy behind the dispatcher", () => {
  it("lets a developer write and read", async () => {
    const r = await room();
    const dev = await login(r, "DEVELOPER");
    const d = dispatcher();
    expect((await d.dispatch(dev.principal, cmd("workspace.apply_changeset"))).response).toBe("ok");
    expect((await d.dispatch(dev.principal, cmd("workspace.read"))).response).toBe("contents");
  });

  it("an observer can read but a write is FORBIDDEN, names the capability, and persists nothing", async () => {
    const r = await room();
    const obs = await login(r, "OBSERVER");
    const d = dispatcher();
    expect((await d.dispatch(obs.principal, cmd("workspace.read"))).response).toBe("contents");
    await expect(d.dispatch(obs.principal, cmd("workspace.apply_changeset"))).rejects.toMatchObject(
      {
        code: "FORBIDDEN",
        details: { missing_capability: "workspace.write", role: "OBSERVER" },
      },
    );
    expect(await effects(r)).toBe(0);
    expect(await lastSeq(r)).toBe(0);
  });

  it("owner-only commands: owner yes, admin and lead-member no", async () => {
    const r = await room();
    const [owner, admin, lead] = [
      await login(r, "DEVELOPER", "OWNER"),
      await login(r, "DEVELOPER", "ADMIN"),
      await login(r, "LEAD", "MEMBER"),
    ];
    const d = dispatcher();
    expect((await d.dispatch(owner.principal, cmd("room.archive"))).response).toBe("archived");
    for (const who of [admin, lead]) {
      await expect(d.dispatch(who.principal, cmd("room.archive"))).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    }
  });

  it("a participant demoted after authenticating is refused on the next command", async () => {
    const r = await room();
    const dev = await login(r, "DEVELOPER");
    const d = dispatcher();
    await d.dispatch(dev.principal, cmd("workspace.apply_changeset"));
    await pool.query("UPDATE participants SET role = 'OBSERVER' WHERE id = $1", [dev.id]);
    await expect(d.dispatch(dev.principal, cmd("workspace.apply_changeset"))).rejects.toMatchObject(
      { code: "FORBIDDEN" },
    );
    expect(await effects(r)).toBe(1);
  });

  it("a replay can't bypass the policy once the participant loses the capability", async () => {
    const r = await room();
    const dev = await login(r, "DEVELOPER");
    const d = dispatcher();
    const env = cmd("workspace.apply_changeset");
    await d.dispatch(dev.principal, env);
    await pool.query("UPDATE participants SET role = 'OBSERVER' WHERE id = $1", [dev.id]);
    await expect(d.dispatch(dev.principal, env)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("a command that doesn't declare a capability as its action is denied (fail closed)", async () => {
    const r = await room();
    const owner = await login(r, "LEAD", "OWNER");
    const d = new Dispatcher({ pool, authorize, nodeId: `node-${++n}` });
    d.registerCommand({
      method: "room.get_state",
      // no `action`: it defaults to the method name, and "room.get_state" isn't a capability
      // (the capability is room.read)
      params: z.object({}),
      mutating: false,
      execute: async () => ({ response: "x" }),
    });
    await expect(d.dispatch(owner.principal, cmd("room.get_state"))).rejects.toMatchObject({
      code: "FORBIDDEN",
      details: { missing_capability: "room.get_state", reason: "unknown_capability" },
    });
  });
});
