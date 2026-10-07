import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { authorize } from "@crossover/policy";
import { CrossoverError, newId } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Dispatcher } from "../../dispatcher.js";
import type { Principal } from "../../principal.js";
import { registerDecisionDecideCommands } from "./decide.js";
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

/** `undefined` means "leave it out": the dispatcher takes plain JSON only. */
const cmd = (method: string, params: Record<string, unknown> = {}) => ({
  id: newId("cmd"),
  method,
  params: Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined)),
  idempotency_key: `k-${++n}`,
});
const read = (method: string, params: Record<string, unknown> = {}) => ({
  id: newId("cmd"),
  method,
  params,
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
  registerDecisionDecideCommands(d);
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
    observer: await add(room, "OBSERVER"),
  };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const propose = async (s: Setup, who: Principal = s.dev) =>
  (
    await s.d.dispatch(
      who,
      cmd("decisions.propose", {
        title: "Pick a database",
        options: [{ summary: "PostgreSQL" }, { summary: "SQLite" }],
      }),
    )
  ).response as DecisionView;
const decide = (
  s: Setup,
  who: Principal,
  d: Pick<DecisionView, "id" | "version">,
  extra: Record<string, unknown> = {},
) =>
  s.d.dispatch(
    who,
    cmd("decisions.decide", {
      decision_id: d.id,
      expected_version: d.version,
      outcome_option_id: "opt_1",
      rationale: "It's what we run",
      ...extra,
    }),
  );
const withdraw = (s: Setup, who: Principal, d: Pick<DecisionView, "id" | "version">) =>
  s.d.dispatch(who, cmd("decisions.withdraw", { decision_id: d.id, expected_version: d.version }));

const rejects = async (p: Promise<unknown>, code: string) => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CrossoverError);
  expect((err as CrossoverError).code).toBe(code);
  return err as CrossoverError;
};

describe("decisions.decide", () => {
  it("the lead accepts an option with a rationale: ACCEPTED, version 2, decided_by and decided_at", async () => {
    const s = await setup();
    const d = await propose(s);
    await s.d.dispatch(
      s.dev2,
      cmd("decisions.add_position", { decision_id: d.id, option_id: "opt_2", argument: "lighter" }),
    );
    const out = await decide(s, s.lead, d);
    expect(out.response).toMatchObject({
      status: "ACCEPTED",
      outcome_option_id: "opt_1",
      rationale: "It's what we run",
      decided_by: s.lead.participant_id,
      version: 2,
      positions: [{ participant_id: s.dev2.participant_id, option_id: "opt_2" }],
    });
    expect((out.response as DecisionView).decided_at).toEqual(expect.any(String));
    expect(out.events.map((e) => e.type)).toEqual(["decision.decided"]);
    expect(out.events[0]!.payload).toMatchObject({
      decision_id: d.id,
      status: "ACCEPTED",
      outcome_option_id: "opt_1",
      decided_by: s.lead.participant_id,
      from_version: 1,
      version: 2,
    });
  });

  it("the lead can reject the proposal instead", async () => {
    const s = await setup();
    const d = await propose(s);
    const out = await decide(s, s.lead, d, {
      outcome_option_id: undefined,
      reject: true,
      rationale: "Not now",
    });
    expect(out.response).toMatchObject({
      status: "REJECTED",
      outcome_option_id: null,
      rationale: "Not now",
    });
  });

  it("non-lead decide → FORBIDDEN, and nothing changes", async () => {
    const s = await setup();
    const d = await propose(s);
    for (const who of [s.dev, s.dev2, s.observer]) await rejects(decide(s, who, d), "FORBIDDEN");
    const { rows } = await pool.query("SELECT status, version FROM decisions WHERE id = $1", [
      d.id,
    ]);
    expect(rows[0]).toEqual({ status: "PROPOSED", version: 1 });
  });

  it("needs a rationale, and exactly one of an outcome or reject", async () => {
    const s = await setup();
    const d = await propose(s);
    await rejects(decide(s, s.lead, d, { rationale: "   " }), "VALIDATION");
    await rejects(decide(s, s.lead, d, { rationale: undefined }), "VALIDATION");
    await rejects(decide(s, s.lead, d, { reject: true }), "VALIDATION"); // both
    await rejects(decide(s, s.lead, d, { outcome_option_id: undefined }), "VALIDATION"); // neither
    await rejects(
      decide(s, s.lead, d, { reject: false, outcome_option_id: undefined }),
      "VALIDATION",
    );
  });

  it("the option must be the decision's own", async () => {
    const s = await setup();
    const d = await propose(s);
    const err = await rejects(decide(s, s.lead, d, { outcome_option_id: "opt_9" }), "VALIDATION");
    expect(err.details).toMatchObject({ options: ["opt_1", "opt_2"] });
  });

  it("a stale expected_version is CONFLICT_VERSION carrying the decision now", async () => {
    const s = await setup();
    const d = await propose(s);
    await decide(s, s.lead, d);
    const err = await rejects(decide(s, s.lead, d), "CONFLICT_VERSION");
    expect(err.details).toMatchObject({ current: { id: d.id, status: "ACCEPTED", version: 2 } });
  });

  it("only a PROPOSED decision can be decided", async () => {
    const s = await setup();
    for (const status of ["ACCEPTED", "REJECTED", "WITHDRAWN", "SUPERSEDED", "VETOED"]) {
      const d = await propose(s);
      await pool.query(
        `UPDATE decisions SET status = $2,
           outcome_option_id = CASE WHEN $2 IN ('ACCEPTED','SUPERSEDED','VETOED') THEN 'opt_1' END
         WHERE id = $1`,
        [d.id, status],
      );
      const err = await rejects(decide(s, s.lead, d), "VALIDATION");
      expect(err.details).toMatchObject({ status });
    }
  });

  it("unknown or other-room decisions are NOT_FOUND", async () => {
    const s = await setup();
    const other = await setup();
    const foreign = await propose(other);
    await rejects(decide(s, s.lead, { id: "dec_nope", version: 1 }), "NOT_FOUND");
    await rejects(decide(s, s.lead, foreign), "NOT_FOUND");
  });

  it("racing deciders: exactly one wins, the other sees the conflict", async () => {
    const s = await setup();
    const d = await propose(s);
    const lead2 = await add(s.room, "LEAD");
    const results = await Promise.allSettled([
      decide(s, s.lead, d, { outcome_option_id: "opt_1" }),
      decide(s, lead2, d, { outcome_option_id: "opt_2" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ code: "CONFLICT_VERSION" });
  });

  it("positions can no longer be added once it is decided", async () => {
    const s = await setup();
    const d = await propose(s);
    await decide(s, s.lead, d);
    await rejects(
      s.d.dispatch(
        s.dev,
        cmd("decisions.add_position", { decision_id: d.id, option_id: "opt_1", argument: "late" }),
      ),
      "VALIDATION",
    );
  });
});

describe("decisions.withdraw", () => {
  it("the proposer withdraws a PROPOSED decision", async () => {
    const s = await setup();
    const d = await propose(s);
    const out = await withdraw(s, s.dev, d);
    expect(out.response).toMatchObject({ status: "WITHDRAWN", version: 2 });
    expect(out.events.map((e) => e.type)).toEqual(["decision.withdrawn"]);
    expect(out.events[0]!.payload).toMatchObject({
      decision_id: d.id,
      withdrawn_by: s.dev.participant_id,
    });
  });

  it("anyone else, even the lead, is FORBIDDEN (not_proposer)", async () => {
    const s = await setup();
    const d = await propose(s);
    for (const who of [s.lead, s.dev2]) {
      const err = await rejects(withdraw(s, who, d), "FORBIDDEN");
      expect(err.details).toMatchObject({ reason: "not_proposer" });
    }
  });

  it("not once decided or already withdrawn → VALIDATION; stale version → CONFLICT_VERSION", async () => {
    const s = await setup();
    const decided = await propose(s);
    await decide(s, s.lead, decided);
    await rejects(withdraw(s, s.dev, { id: decided.id, version: 2 }), "VALIDATION");
    const d = await propose(s);
    await withdraw(s, s.dev, d);
    await rejects(withdraw(s, s.dev, { id: d.id, version: 2 }), "VALIDATION");
    await rejects(withdraw(s, s.dev, d), "CONFLICT_VERSION");
  });

  it("and a decided decision can't be withdrawn even with the right version", async () => {
    const s = await setup();
    const d = await propose(s);
    await decide(s, s.lead, d);
    const err = await rejects(withdraw(s, s.dev, { id: d.id, version: 2 }), "VALIDATION");
    expect(err.details).toMatchObject({ status: "ACCEPTED" });
  });
});

describe("decisions.get and decisions.list", () => {
  it("get returns the decision with its positions; an observer can read", async () => {
    const s = await setup();
    const d = await propose(s);
    await s.d.dispatch(
      s.dev2,
      cmd("decisions.add_position", { decision_id: d.id, option_id: "opt_1", argument: "yes" }),
    );
    const got = (await s.d.dispatch(s.observer, read("decisions.get", { decision_id: d.id })))
      .response as DecisionView;
    expect(got).toMatchObject({
      id: d.id,
      status: "PROPOSED",
      positions: [{ option_id: "opt_1", argument: "yes" }],
    });
    await rejects(
      s.d.dispatch(s.dev, read("decisions.get", { decision_id: "dec_nope" })),
      "NOT_FOUND",
    );
    const other = await setup();
    const foreign = await propose(other);
    await rejects(
      s.d.dispatch(s.dev, read("decisions.get", { decision_id: foreign.id })),
      "NOT_FOUND",
    );
  });

  it("list is room-scoped, oldest first, with position counts and no position bodies", async () => {
    const s = await setup();
    const other = await setup();
    await propose(other);
    const a = await propose(s);
    const b = await propose(s);
    await s.d.dispatch(
      s.dev2,
      cmd("decisions.add_position", { decision_id: b.id, option_id: "opt_1", argument: "x" }),
    );
    const out = (await s.d.dispatch(s.dev, read("decisions.list"))).response as {
      decisions: (Omit<DecisionView, "positions"> & { position_count: number })[];
      next_after: string | null;
    };
    expect(out.decisions.map((x) => [x.id, x.position_count])).toEqual([
      [a.id, 0],
      [b.id, 1],
    ]);
    expect(out.decisions[0]).not.toHaveProperty("positions");
    expect(out.next_after).toBeNull();
  });

  it("list filters by status and pages with next_after, each exactly once", async () => {
    const s = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await propose(s)).id);
    const decided = { id: ids[1]!, version: 1 };
    await decide(s, s.lead, decided);
    const proposed = (await s.d.dispatch(s.dev, read("decisions.list", { status: ["PROPOSED"] })))
      .response as { decisions: { id: string }[] };
    expect(proposed.decisions.map((x) => x.id)).toEqual(ids.filter((id) => id !== ids[1]));
    const accepted = (await s.d.dispatch(s.dev, read("decisions.list", { status: ["ACCEPTED"] })))
      .response as { decisions: { id: string }[] };
    expect(accepted.decisions.map((x) => x.id)).toEqual([ids[1]]);

    const seen: string[] = [];
    let after: string | undefined;
    for (;;) {
      const page = (
        await s.d.dispatch(s.dev, read("decisions.list", { limit: 2, ...(after ? { after } : {}) }))
      ).response as { decisions: { id: string }[]; next_after: string | null };
      seen.push(...page.decisions.map((x) => x.id));
      if (!page.next_after) break;
      after = page.next_after;
    }
    expect(seen).toEqual(ids);
  });

  it("list rejects a bad status or limit", async () => {
    const s = await setup();
    await rejects(s.d.dispatch(s.dev, read("decisions.list", { status: ["DONE"] })), "VALIDATION");
    await rejects(s.d.dispatch(s.dev, read("decisions.list", { limit: 0 })), "VALIDATION");
    await rejects(s.d.dispatch(s.dev, read("decisions.list", { limit: 101 })), "VALIDATION");
  });
});
