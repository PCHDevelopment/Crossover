import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { authorize } from "@crossover/policy";
import { CrossoverError, newId } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Dispatcher } from "../../dispatcher.js";
import type { Principal } from "../../principal.js";
import { registerDecisionCommands, type DecisionView } from "./decisions.js";

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

async function add(room: string, role: string, authority = "MEMBER") {
  const id = newId("part");
  await pool.query(
    `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status)
     VALUES ($1, $2, 'AGENT', $1, $3, $4, 'ACTIVE')`,
    [id, room, authority, role],
  );
  return { participant_id: id, room_id: room, kind: "AGENT", authority, role } as Principal;
}

async function setup() {
  const d = new Dispatcher({ pool, authorize, nodeId: `node-${++n}` });
  registerDecisionCommands(d);
  const room = newId("room");
  await pool.query(
    `INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'n', 'o', 'x')`,
    [room],
  );
  return {
    d,
    room,
    lead: await add(room, "LEAD"),
    dev: await add(room, "DEVELOPER"),
    dev2: await add(room, "DEVELOPER"),
    reviewer: await add(room, "REVIEWER"),
    observer: await add(room, "OBSERVER"),
  };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const options = [
  { summary: "Use PostgreSQL", detail: "Already in the stack" },
  { summary: "Use SQLite" },
];
const propose = async (s: Setup, who: Principal = s.dev, extra: Record<string, unknown> = {}) =>
  s.d.dispatch(who, cmd("decisions.propose", { title: "Pick a database", options, ...extra }));
const position = (
  s: Setup,
  who: Principal,
  decision: string,
  option: string,
  argument = "because",
) =>
  s.d.dispatch(
    who,
    cmd("decisions.add_position", { decision_id: decision, option_id: option, argument }),
  );

const rejects = async (p: Promise<unknown>, code: string) => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CrossoverError);
  expect((err as CrossoverError).code).toBe(code);
  return err as CrossoverError;
};

describe("decisions.propose", () => {
  it("opens a PROPOSED decision at version 1 with server-assigned option ids", async () => {
    const s = await setup();
    const out = await propose(s, s.dev, {
      context: "We need storage",
      links: [{ kind: "task", id: "task_1" }],
    });
    const d = out.response as DecisionView;
    expect(d).toMatchObject({
      status: "PROPOSED",
      version: 1,
      title: "Pick a database",
      context: "We need storage",
      proposed_by: s.dev.participant_id,
      decided_by: null,
      outcome_option_id: null,
      supersedes: null,
      links: [{ kind: "task", id: "task_1" }],
      positions: [],
    });
    expect(d.id).toMatch(/^dec_/);
    expect(d.options).toEqual([
      { id: "opt_1", summary: "Use PostgreSQL", detail: "Already in the stack" },
      { id: "opt_2", summary: "Use SQLite", detail: "" },
    ]);
    expect(out.events.map((e) => e.type)).toEqual(["decision.proposed"]);
    expect(out.events[0]!.payload).toMatchObject({ decision: { id: d.id } });
  });

  it("takes a future decide_by and refuses one in the past", async () => {
    const s = await setup();
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect(
      ((await propose(s, s.dev, { decide_by: future })).response as DecisionView).decide_by,
    ).toBe(future);
    const err = await rejects(
      propose(s, s.dev, { decide_by: "2020-01-01T00:00:00Z" }),
      "VALIDATION",
    );
    expect(err.message).toContain("future");
  });

  it("needs at least two options, at most ten, and a title", async () => {
    const s = await setup();
    await rejects(propose(s, s.dev, { options: [{ summary: "only one" }] }), "VALIDATION");
    await rejects(
      propose(s, s.dev, { options: Array.from({ length: 11 }, (_, i) => ({ summary: `o${i}` })) }),
      "VALIDATION",
    );
    await rejects(propose(s, s.dev, { title: "  " }), "VALIDATION");
    await rejects(
      propose(s, s.dev, { options: [{ summary: "a" }, { summary: " " }] }),
      "VALIDATION",
    );
    await propose(s, s.dev, {
      options: Array.from({ length: 10 }, (_, i) => ({ summary: `o${i}` })),
    });
  });

  it("is for anyone with decisions.propose: developers and the lead, not an observer", async () => {
    const s = await setup();
    await propose(s, s.dev);
    await propose(s, s.lead);
    await propose(s, s.reviewer);
    await rejects(propose(s, s.observer), "FORBIDDEN");
  });

  it("a replay with the same idempotency key doesn't open a second decision", async () => {
    const s = await setup();
    const env = cmd("decisions.propose", { title: "Once", options });
    const a = await s.d.dispatch(s.dev, env);
    const b = await s.d.dispatch(s.dev, env);
    expect(b.replayed).toBe(true);
    expect((b.response as DecisionView).id).toBe((a.response as DecisionView).id);
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM decisions WHERE room_id = $1",
      [s.room],
    );
    expect(rows[0].n).toBe(1);
  });
});

describe("decisions.add_position", () => {
  it("records a position and emits decision.position_added", async () => {
    const s = await setup();
    const d = (await propose(s)).response as DecisionView;
    const out = await position(s, s.dev2, d.id, "opt_1", "It's what we know");
    expect(out.response).toMatchObject({
      decision_id: d.id,
      participant_id: s.dev2.participant_id,
      option_id: "opt_1",
      argument: "It's what we know",
      replaced: false,
    });
    expect(out.events.map((e) => e.type)).toEqual(["decision.position_added"]);
    const { rows } = await pool.query(
      "SELECT participant_id, option_id FROM decision_positions WHERE decision_id = $1",
      [d.id],
    );
    expect(rows).toEqual([{ participant_id: s.dev2.participant_id, option_id: "opt_1" }]);
  });

  it("one position per participant: adding another replaces it", async () => {
    const s = await setup();
    const d = (await propose(s)).response as DecisionView;
    await position(s, s.dev2, d.id, "opt_1", "first thoughts");
    const second = await position(s, s.dev2, d.id, "opt_2", "changed my mind");
    expect(second.response).toMatchObject({ option_id: "opt_2", replaced: true });
    const other = await position(s, s.reviewer, d.id, "opt_1");
    expect(other.response).toMatchObject({ replaced: false });
    const { rows } = await pool.query(
      "SELECT participant_id, option_id, argument FROM decision_positions WHERE decision_id = $1 ORDER BY participant_id",
      [d.id],
    );
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.participant_id === s.dev2.participant_id)).toMatchObject({
      option_id: "opt_2",
      argument: "changed my mind",
    });
  });

  it("the proposer may take a position too, and positions don't change the version", async () => {
    const s = await setup();
    const d = (await propose(s)).response as DecisionView;
    await position(s, s.dev, d.id, "opt_2");
    await position(s, s.lead, d.id, "opt_1");
    const { rows } = await pool.query("SELECT version FROM decisions WHERE id = $1", [d.id]);
    expect(rows[0].version).toBe(1);
  });

  it("on a decision that isn't PROPOSED → VALIDATION", async () => {
    const s = await setup();
    for (const status of ["ACCEPTED", "REJECTED", "WITHDRAWN", "SUPERSEDED", "VETOED"]) {
      const d = (await propose(s)).response as DecisionView;
      await pool.query(
        `UPDATE decisions SET status = $2,
           outcome_option_id = CASE WHEN $2 IN ('ACCEPTED','SUPERSEDED','VETOED') THEN 'opt_1' END
         WHERE id = $1`,
        [d.id, status],
      );
      const err = await rejects(position(s, s.dev2, d.id, "opt_1"), "VALIDATION");
      expect(err.details).toMatchObject({ status });
    }
  });

  it("an unknown option is VALIDATION, an unknown or foreign decision is NOT_FOUND", async () => {
    const s = await setup();
    const other = await setup();
    const d = (await propose(s)).response as DecisionView;
    const err = await rejects(position(s, s.dev2, d.id, "opt_9"), "VALIDATION");
    expect(err.details).toMatchObject({ options: ["opt_1", "opt_2"] });
    await rejects(position(s, s.dev2, "dec_nope", "opt_1"), "NOT_FOUND");
    const foreign = (await propose(other)).response as DecisionView;
    await rejects(position(s, s.dev2, foreign.id, "opt_1"), "NOT_FOUND");
  });

  it("an observer can't take a position, and a refused one leaves nothing", async () => {
    const s = await setup();
    const d = (await propose(s)).response as DecisionView;
    await rejects(position(s, s.observer, d.id, "opt_1"), "FORBIDDEN");
    await rejects(position(s, s.dev2, d.id, "opt_9"), "VALIDATION");
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM decision_positions WHERE decision_id = $1",
      [d.id],
    );
    expect(rows[0].n).toBe(0);
  });

  it("needs a non-empty argument", async () => {
    const s = await setup();
    const d = (await propose(s)).response as DecisionView;
    await rejects(position(s, s.dev2, d.id, "opt_1", "   "), "VALIDATION");
    await rejects(position(s, s.dev2, d.id, "opt_1", "x".repeat(10_001)), "VALIDATION");
  });

  it("concurrent positions by different participants all land, none lost", async () => {
    const s = await setup();
    const d = (await propose(s)).response as DecisionView;
    const who = [s.dev, s.dev2, s.reviewer, s.lead];
    await Promise.all(who.map((p, i) => position(s, p, d.id, i % 2 ? "opt_1" : "opt_2")));
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM decision_positions WHERE decision_id = $1",
      [d.id],
    );
    expect(rows[0].n).toBe(4);
  });
});
