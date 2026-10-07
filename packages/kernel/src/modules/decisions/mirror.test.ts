import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { authorize } from "@crossover/policy";
import { CrossoverError, newId } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Dispatcher } from "../../dispatcher.js";
import type { Principal } from "../../principal.js";
import { registerMemoryCommands } from "../memory/memory.js";
import { registerDecisionDecideCommands } from "./decide.js";
import { registerDecisionCommands, type DecisionView } from "./decisions.js";
import { decisionMemoryKey } from "./mirror.js";

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

async function add(room: string, role: string) {
  const id = newId("part");
  await pool.query(
    `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status)
     VALUES ($1, $2, 'AGENT', $1, 'MEMBER', $3, 'ACTIVE')`,
    [id, room, role],
  );
  return {
    participant_id: id,
    room_id: room,
    kind: "AGENT",
    authority: "MEMBER",
    role,
  } as Principal;
}

async function setup() {
  const d = new Dispatcher({ pool, authorize, nodeId: `node-${++n}` });
  registerDecisionCommands(d);
  registerDecisionDecideCommands(d);
  registerMemoryCommands(d);
  const room = newId("room");
  await pool.query(
    `INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'n', 'o', 'x')`,
    [room],
  );
  return { d, room, lead: await add(room, "LEAD"), dev: await add(room, "DEVELOPER") };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const propose = async (s: Setup) =>
  (
    await s.d.dispatch(
      s.dev,
      cmd("decisions.propose", {
        title: "Pick a database",
        options: [{ summary: "PostgreSQL" }, { summary: "SQLite" }],
      }),
    )
  ).response as DecisionView;
const decide = (s: Setup, d: DecisionView, extra: Record<string, unknown> = {}) =>
  s.d.dispatch(
    s.lead,
    cmd("decisions.decide", {
      decision_id: d.id,
      expected_version: d.version,
      outcome_option_id: "opt_2",
      rationale: "Simple wins",
      ...extra,
    }),
  );
const entry = async (s: Setup, key: string) =>
  (
    await pool.query(
      "SELECT value, content_type, author_id, revision, source_refs, deleted FROM memory_entries WHERE room_id = $1 AND key = $2",
      [s.room, key],
    )
  ).rows[0] as
    | {
        value: string;
        content_type: string;
        author_id: string;
        revision: number;
        source_refs: unknown;
        deleted: boolean;
      }
    | undefined;

describe("decision → memory mirror (§7.4)", () => {
  it("an accepted decision is written to decisions/<id> as the system, in the same transaction", async () => {
    const s = await setup();
    const d = await propose(s);
    const out = await decide(s, d);
    const e = (await entry(s, decisionMemoryKey(d.id)))!;
    expect(e).toMatchObject({
      author_id: "system",
      content_type: "application/json",
      revision: 1,
      deleted: false,
      source_refs: [{ kind: "decision", id: d.id }],
    });
    expect(JSON.parse(e.value)).toEqual({
      id: d.id,
      title: "Pick a database",
      status: "ACCEPTED",
      outcome_option_id: "opt_2",
      outcome_summary: "SQLite",
      rationale: "Simple wins",
      proposed_by: s.dev.participant_id,
      decided_by: s.lead.participant_id,
      decided_at: (out.response as DecisionView).decided_at,
      supersedes: null,
      version: 2,
    });
    expect(out.events.map((ev) => [ev.type, ev.actor_id])).toEqual([
      ["decision.decided", s.lead.participant_id],
      ["memory.updated", "system"],
    ]);
    expect(out.events[1]!.payload).toMatchObject({
      key: decisionMemoryKey(d.id),
      revision: 1,
      author_id: "system",
    });
  });

  it("the projection is deterministic: the same decision always gives the same bytes", async () => {
    const s = await setup();
    const a = await propose(s);
    const b = await propose(s);
    await decide(s, a);
    await decide(s, b);
    const va = JSON.parse((await entry(s, decisionMemoryKey(a.id)))!.value);
    const vb = JSON.parse((await entry(s, decisionMemoryKey(b.id)))!.value);
    expect(Object.keys(va)).toEqual(Object.keys(vb));
  });

  it("a rejected, withdrawn or still-open decision is not mirrored", async () => {
    const s = await setup();
    const rejected = await propose(s);
    await decide(s, rejected, { outcome_option_id: undefined, reject: true, rationale: "No" });
    const withdrawn = await propose(s);
    await s.d.dispatch(
      s.dev,
      cmd("decisions.withdraw", { decision_id: withdrawn.id, expected_version: 1 }),
    );
    const open = await propose(s);
    for (const d of [rejected, withdrawn, open]) {
      expect(await entry(s, decisionMemoryKey(d.id))).toBeUndefined();
    }
  });

  it("if the mirror fails, the decision isn't decided either (one transaction)", async () => {
    const s = await setup();
    const d = await propose(s);
    // A history row that will collide with the mirror's first revision.
    await pool.query(
      `INSERT INTO memory_entries (room_id, key, value, content_type, author_id, revision, deleted)
       VALUES ($1, $2, '', 'application/json', 'system', 1, true)`,
      [s.room, decisionMemoryKey(d.id)],
    );
    await pool.query(
      `INSERT INTO memory_revisions (room_id, key, revision, value, content_type, author_id)
       VALUES ($1, $2, 2, '', 'application/json', 'system')`,
      [s.room, decisionMemoryKey(d.id)],
    );
    await expect(decide(s, d)).rejects.toBeDefined();
    const { rows } = await pool.query("SELECT status, version FROM decisions WHERE id = $1", [
      d.id,
    ]);
    expect(rows[0]).toEqual({ status: "PROPOSED", version: 1 });
  });

  it("a refused decide (non-lead, stale) leaves no mirror behind", async () => {
    const s = await setup();
    const d = await propose(s);
    await expect(
      s.d.dispatch(
        s.dev,
        cmd("decisions.decide", {
          decision_id: d.id,
          expected_version: 1,
          outcome_option_id: "opt_1",
          rationale: "mine",
        }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await entry(s, decisionMemoryKey(d.id))).toBeUndefined();
  });

  it("participants can't write under decisions/*, not even the lead, nor over a mirror", async () => {
    const s = await setup();
    const d = await propose(s);
    await decide(s, d);
    for (const who of [s.lead, s.dev]) {
      for (const [key, expected] of [
        ["decisions/dec_made_up", 0],
        [decisionMemoryKey(d.id), 1],
      ] as const) {
        const err = await s.d
          .dispatch(who, cmd("memory.put", { key, value: "x", expected_revision: expected }))
          .then(
            () => undefined,
            (e: unknown) => e,
          );
        expect(err).toBeInstanceOf(CrossoverError);
        expect((err as CrossoverError).code).toBe("FORBIDDEN");
      }
    }
    expect((await entry(s, decisionMemoryKey(d.id)))!.revision).toBe(1);
  });
});
