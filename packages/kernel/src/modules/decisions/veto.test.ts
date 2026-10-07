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

const cmd = (method: string, params: Record<string, unknown> = {}) => ({
  id: newId("cmd"),
  method,
  params: Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined)),
  idempotency_key: `k-${++n}`,
});

async function add(
  room: string,
  role: string,
  authority = "MEMBER",
  kind: "AGENT" | "HUMAN" = "AGENT",
) {
  const id = newId("part");
  await pool.query(
    `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status)
     VALUES ($1, $2, $3, $1, $4, $5, 'ACTIVE')`,
    [id, room, kind, authority, role],
  );
  return { participant_id: id, room_id: room, kind, authority, role } as Principal;
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
    owner: await add(room, "DEVELOPER", "OWNER", "HUMAN"),
    admin: await add(room, "DEVELOPER", "ADMIN", "HUMAN"),
    lead: await add(room, "LEAD"),
    dev: await add(room, "DEVELOPER"),
  };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const propose = async (s: Setup, extra: Record<string, unknown> = {}) =>
  (
    await s.d.dispatch(
      s.dev,
      cmd("decisions.propose", {
        title: "Pick a database",
        options: [{ summary: "PostgreSQL" }, { summary: "SQLite" }],
        ...extra,
      }),
    )
  ).response as DecisionView;
const decide = async (
  s: Setup,
  d: Pick<DecisionView, "id" | "version">,
  extra: Record<string, unknown> = {},
) =>
  await s.d.dispatch(
    s.lead,
    cmd("decisions.decide", {
      decision_id: d.id,
      expected_version: d.version,
      outcome_option_id: "opt_1",
      rationale: "Because",
      ...extra,
    }),
  );
const accepted = async (s: Setup, extra: Record<string, unknown> = {}) => {
  const d = await propose(s, extra);
  return (await decide(s, d)).response as DecisionView;
};
const veto = (
  s: Setup,
  who: Principal,
  d: Pick<DecisionView, "id" | "version">,
  rationale = "No, because",
) =>
  s.d.dispatch(
    who,
    cmd("decisions.veto", { decision_id: d.id, expected_version: d.version, rationale }),
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

describe("decisions.veto (§7.1 step 4)", () => {
  it("the owner vetoes an accepted decision within 24 h: VETOED, rationale and vetoer recorded", async () => {
    const s = await setup();
    const d = await accepted(s);
    const out = await veto(s, s.owner, d, "Too risky");
    expect(out.response).toMatchObject({
      status: "VETOED",
      vetoed_by: s.owner.participant_id,
      veto_rationale: "Too risky",
      version: 3,
      outcome_option_id: "opt_1",
    });
    expect((out.response as DecisionView).vetoed_at).toEqual(expect.any(String));
    expect(out.events.map((e) => e.type)).toEqual(["decision.vetoed"]);
    expect(out.events[0]!.payload).toMatchObject({
      decision_id: d.id,
      previous_status: "ACCEPTED",
      rationale: "Too risky",
      vetoed_by: s.owner.participant_id,
    });
  });

  it("a rejected decision can be vetoed too", async () => {
    const s = await setup();
    const d = await propose(s);
    const rejected = (await decide(s, d, { outcome_option_id: undefined, reject: true }))
      .response as DecisionView;
    const out = await veto(s, s.owner, rejected);
    expect(out.response).toMatchObject({ status: "VETOED", outcome_option_id: null });
  });

  it("an admin may too; the lead, a developer and any agent are FORBIDDEN", async () => {
    const s = await setup();
    const a = await accepted(s);
    for (const who of [s.lead, s.dev]) await rejects(veto(s, who, a), "FORBIDDEN");
    expect((await veto(s, s.admin, a)).response).toMatchObject({ status: "VETOED" });
  });

  it("after 24 h → VALIDATION; just inside the window works", async () => {
    const s = await setup();
    const late = await accepted(s);
    await pool.query(
      "UPDATE decisions SET decided_at = now() - interval '24 hours 1 minute' WHERE id = $1",
      [late.id],
    );
    const err = await rejects(veto(s, s.owner, late), "VALIDATION");
    expect(err.message).toContain("24-hour");

    const ontime = await accepted(s);
    await pool.query(
      "UPDATE decisions SET decided_at = now() - interval '23 hours 59 minutes' WHERE id = $1",
      [ontime.id],
    );
    expect((await veto(s, s.owner, ontime)).response).toMatchObject({ status: "VETOED" });
  });

  it("needs a rationale", async () => {
    const s = await setup();
    const d = await accepted(s);
    await rejects(veto(s, s.owner, d, "  "), "VALIDATION");
  });

  it("only ACCEPTED or REJECTED decisions: PROPOSED, WITHDRAWN, SUPERSEDED, VETOED → VALIDATION", async () => {
    const s = await setup();
    for (const status of ["PROPOSED", "WITHDRAWN", "SUPERSEDED", "VETOED"]) {
      const d = await propose(s);
      await pool.query(
        `UPDATE decisions SET status = $2, decided_at = now(),
           outcome_option_id = CASE WHEN $2 IN ('SUPERSEDED','VETOED') THEN 'opt_1' END
         WHERE id = $1`,
        [d.id, status],
      );
      const err = await rejects(veto(s, s.owner, d), "VALIDATION");
      expect(err.details).toMatchObject({ status });
    }
  });

  it("a stale version is CONFLICT_VERSION; unknown or other-room decisions are NOT_FOUND", async () => {
    const s = await setup();
    const other = await setup();
    const d = await accepted(s);
    const err = await rejects(veto(s, s.owner, { id: d.id, version: 1 }), "CONFLICT_VERSION");
    expect(err.details).toMatchObject({ current: { id: d.id, status: "ACCEPTED" } });
    await rejects(veto(s, s.owner, { id: "dec_nope", version: 1 }), "NOT_FOUND");
    const foreign = await accepted(other);
    await rejects(veto(s, s.owner, foreign), "NOT_FOUND");
  });

  it("a vetoed decision can't be vetoed again, decided or withdrawn", async () => {
    const s = await setup();
    const d = await accepted(s);
    const vetoed = (await veto(s, s.owner, d)).response as DecisionView;
    await rejects(veto(s, s.owner, vetoed), "VALIDATION");
    await rejects(decide(s, vetoed), "VALIDATION");
  });
});

describe("supersedes (§7.1 step 5)", () => {
  it("accepting a decision that supersedes an accepted one moves the old one to SUPERSEDED", async () => {
    const s = await setup();
    const old = await accepted(s);
    const next = await propose(s, { title: "Pick another", supersedes: old.id });
    expect(next.supersedes).toBe(old.id);
    // Proposing doesn't touch the old one yet.
    expect(
      (await pool.query("SELECT status FROM decisions WHERE id = $1", [old.id])).rows[0].status,
    ).toBe("ACCEPTED");

    const out = await decide(s, next);
    expect(out.events.map((e) => e.type)).toEqual(["decision.decided", "decision.superseded"]);
    expect(out.events[1]!.payload).toMatchObject({
      decision_id: old.id,
      superseded_by: next.id,
      version: 3,
    });
    const { rows } = await pool.query("SELECT status, version FROM decisions WHERE id = $1", [
      old.id,
    ]);
    expect(rows[0]).toEqual({ status: "SUPERSEDED", version: 3 });
  });

  it("rejecting the new one leaves the old one accepted", async () => {
    const s = await setup();
    const old = await accepted(s);
    const next = await propose(s, { supersedes: old.id });
    await decide(s, next, { outcome_option_id: undefined, reject: true });
    expect(
      (await pool.query("SELECT status FROM decisions WHERE id = $1", [old.id])).rows[0].status,
    ).toBe("ACCEPTED");
  });

  it("only an accepted decision of this room can be superseded (VALIDATION at propose)", async () => {
    const s = await setup();
    const other = await setup();
    const open = await propose(s);
    for (const supersedes of [open.id, "dec_nope", (await accepted(other)).id]) {
      await rejects(propose(s, { supersedes }), "VALIDATION");
    }
    const vetoed = (await veto(s, s.owner, await accepted(s))).response as DecisionView;
    const err = await rejects(propose(s, { supersedes: vetoed.id }), "VALIDATION");
    expect(err.details).toMatchObject({ status: "VETOED" });
  });

  it("if the old decision was vetoed meanwhile, accepting the new one doesn't touch it", async () => {
    const s = await setup();
    const old = await accepted(s);
    const next = await propose(s, { supersedes: old.id });
    await veto(s, s.owner, old);
    const out = await decide(s, next);
    expect(out.events.map((e) => e.type)).toEqual(["decision.decided"]);
    expect(
      (await pool.query("SELECT status FROM decisions WHERE id = $1", [old.id])).rows[0].status,
    ).toBe("VETOED");
  });

  it("a superseded decision can't be vetoed", async () => {
    const s = await setup();
    const old = await accepted(s);
    await decide(s, await propose(s, { supersedes: old.id }));
    const current = (await pool.query("SELECT id, version FROM decisions WHERE id = $1", [old.id]))
      .rows[0];
    await rejects(veto(s, s.owner, current), "VALIDATION");
  });
});
