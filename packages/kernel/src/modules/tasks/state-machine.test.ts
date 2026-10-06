import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { authorize } from "@crossover/policy";
import { CrossoverError, newId } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Dispatcher } from "../../dispatcher.js";
import type { Principal } from "../../principal.js";
import { registerTaskCommands } from "./create-update.js";
import { registerTaskLifecycleCommands, type HealthGate } from "./lifecycle.js";
import { registerTaskReadCommands } from "./read.js";
import type { TaskView } from "./task.js";

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

async function add(
  room: string,
  role: string,
  kind: "HUMAN" | "AGENT",
  authority = "MEMBER",
): Promise<Principal> {
  const id = newId("part");
  await pool.query(
    `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status)
     VALUES ($1, $2, $3, $1, $4, $5, 'ACTIVE')`,
    [id, room, kind, authority, role],
  );
  return { participant_id: id, room_id: room, kind, authority, role } as Principal;
}

async function setup(healthGate?: HealthGate) {
  const d = new Dispatcher({ pool, authorize, nodeId: `node-${++n}` });
  registerTaskCommands(d);
  registerTaskReadCommands(d);
  registerTaskLifecycleCommands(d, healthGate ? { healthGate } : {});
  const room = newId("room");
  const ownerId = newId("part");
  await pool.query(
    `INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'n', 'o', $2)`,
    [room, ownerId],
  );
  const agents = [];
  for (let i = 0; i < 3; i++) agents.push(await add(room, "DEVELOPER", "AGENT"));
  await pool.query(
    `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status)
     VALUES ($1, $2, 'HUMAN', 'owner', 'OWNER', 'DEVELOPER', 'ACTIVE')`,
    [ownerId, room],
  );
  return {
    d,
    room,
    agents,
    agent: agents[0]!,
    lead: await add(room, "LEAD", "AGENT"),
    owner: {
      participant_id: ownerId,
      room_id: room,
      kind: "HUMAN",
      authority: "OWNER",
      role: "DEVELOPER",
    } as Principal,
    admin: await add(room, "DEVELOPER", "HUMAN", "ADMIN"),
    human: await add(room, "DEVELOPER", "HUMAN"),
    reviewer: await add(room, "REVIEWER", "AGENT"),
    observer: await add(room, "OBSERVER", "AGENT"),
  };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const call = (
  s: Setup,
  who: Principal,
  method: string,
  task: Pick<TaskView, "id" | "version">,
  extra: Record<string, unknown> = {},
) => s.d.dispatch(who, cmd(method, { task_id: task.id, expected_version: task.version, ...extra }));

type State = "OPEN" | "CLAIMED" | "IN_PROGRESS" | "BLOCKED" | "REVIEW" | "DONE" | "CANCELLED";
const STATES: State[] = [
  "OPEN",
  "CLAIMED",
  "IN_PROGRESS",
  "BLOCKED",
  "REVIEW",
  "DONE",
  "CANCELLED",
];

/** A task in `state`; it is owned by `s.agent` from CLAIMED on, and `s.reviewer` is named its reviewer. */
async function inState(s: Setup, state: State): Promise<TaskView> {
  let t = (
    await s.d.dispatch(
      s.agents[1]!,
      cmd("tasks.create", {
        title: "T",
        requirements: ["r"],
        reviewer_id: s.reviewer.participant_id,
      }),
    )
  ).response as TaskView;
  const go = async (who: Principal, method: string, extra: Record<string, unknown> = {}) => {
    t = (await call(s, who, method, t, extra)).response as TaskView;
  };
  const path: Record<State, (() => Promise<void>)[]> = {
    OPEN: [],
    CLAIMED: [() => go(s.agent, "tasks.claim")],
    IN_PROGRESS: [() => go(s.agent, "tasks.claim"), () => go(s.agent, "tasks.start")],
    BLOCKED: [
      () => go(s.agent, "tasks.claim"),
      () => go(s.agent, "tasks.start"),
      () => go(s.agent, "tasks.block", { reason: "stuck" }),
    ],
    REVIEW: [
      () => go(s.agent, "tasks.claim"),
      () => go(s.agent, "tasks.start"),
      () => go(s.agent, "tasks.submit"),
    ],
    DONE: [
      () => go(s.agent, "tasks.claim"),
      () => go(s.agent, "tasks.start"),
      () => go(s.agent, "tasks.submit"),
      () => go(s.lead, "tasks.review", { verdict: "approve" }),
    ],
    CANCELLED: [() => go(s.lead, "tasks.cancel")],
  };
  for (const step of path[state]) await step();
  expect(t.status).toBe(state);
  return t;
}

// ---- The spec, written down independently of the implementation (ARCHITECTURE §8.2, §6.1).
type Actor =
  "TASK_OWNER" | "LEAD" | "PROJECT_OWNER" | "ADMIN" | "OTHER_DEV" | "REVIEWER" | "OBSERVER";
const ACTORS: Actor[] = [
  "TASK_OWNER",
  "LEAD",
  "PROJECT_OWNER",
  "ADMIN",
  "OTHER_DEV",
  "REVIEWER",
  "OBSERVER",
];
const who = (s: Setup, a: Actor): Principal =>
  ({
    TASK_OWNER: s.agent,
    LEAD: s.lead,
    PROJECT_OWNER: s.owner,
    ADMIN: s.admin,
    OTHER_DEV: s.agents[2]!,
    REVIEWER: s.reviewer,
    OBSERVER: s.observer,
  })[a];

interface Row {
  /** The command, with extra params. */
  method: string;
  extra?: Record<string, unknown>;
  label: string;
  /** Who holds the capability (the policy gate); everyone else is FORBIDDEN. */
  gate: Actor[];
  /** The state it moves from, and where it ends up. */
  from: State[];
  to: State;
  /** After the gate: who may act on a task in a state that has (or lacks) an owner. */
  rule: "any" | "owner" | "owner_or_lead" | "reviewer_or_lead" | "managers";
  /** What a gate-passing actor gets in the wrong state (after the actor rule). */
  wrongState: "VALIDATION" | "CONFLICT_VERSION";
}

const ROWS: Row[] = [
  {
    method: "tasks.claim",
    label: "claim",
    gate: ["TASK_OWNER", "LEAD", "PROJECT_OWNER", "ADMIN", "OTHER_DEV"],
    from: ["OPEN"],
    to: "CLAIMED",
    rule: "any",
    wrongState: "CONFLICT_VERSION",
  },
  {
    method: "tasks.assign",
    extra: { participant_id: "$other" },
    label: "assign",
    gate: ["LEAD", "PROJECT_OWNER", "ADMIN"],
    from: ["OPEN"],
    to: "CLAIMED",
    rule: "any",
    wrongState: "CONFLICT_VERSION",
  },
  {
    method: "tasks.start",
    label: "start",
    gate: ["TASK_OWNER", "LEAD", "PROJECT_OWNER", "ADMIN", "OTHER_DEV"],
    from: ["CLAIMED"],
    to: "IN_PROGRESS",
    rule: "owner",
    wrongState: "VALIDATION",
  },
  {
    method: "tasks.block",
    extra: { reason: "why" },
    label: "block",
    gate: ["TASK_OWNER", "LEAD", "PROJECT_OWNER", "ADMIN", "OTHER_DEV"],
    from: ["IN_PROGRESS"],
    to: "BLOCKED",
    rule: "owner_or_lead",
    wrongState: "VALIDATION",
  },
  {
    method: "tasks.unblock",
    label: "unblock",
    gate: ["TASK_OWNER", "LEAD", "PROJECT_OWNER", "ADMIN", "OTHER_DEV"],
    from: ["BLOCKED"],
    to: "IN_PROGRESS",
    rule: "owner_or_lead",
    wrongState: "VALIDATION",
  },
  {
    method: "tasks.submit",
    label: "submit",
    gate: ["TASK_OWNER", "LEAD", "PROJECT_OWNER", "ADMIN", "OTHER_DEV"],
    from: ["IN_PROGRESS"],
    to: "REVIEW",
    rule: "owner",
    wrongState: "VALIDATION",
  },
  {
    method: "tasks.review",
    extra: { verdict: "approve" },
    label: "review(approve)",
    gate: ["REVIEWER", "LEAD"],
    from: ["REVIEW"],
    to: "DONE",
    rule: "reviewer_or_lead",
    wrongState: "VALIDATION",
  },
  {
    method: "tasks.review",
    extra: { verdict: "request_changes" },
    label: "review(request_changes)",
    gate: ["REVIEWER", "LEAD"],
    from: ["REVIEW"],
    to: "IN_PROGRESS",
    rule: "reviewer_or_lead",
    wrongState: "VALIDATION",
  },
  {
    method: "tasks.release",
    label: "release",
    gate: ["TASK_OWNER", "LEAD", "PROJECT_OWNER", "ADMIN", "OTHER_DEV"],
    from: ["CLAIMED", "IN_PROGRESS", "BLOCKED"],
    to: "OPEN",
    rule: "owner_or_lead",
    wrongState: "VALIDATION",
  },
  {
    method: "tasks.reopen",
    label: "reopen",
    gate: ["LEAD", "PROJECT_OWNER", "ADMIN"],
    from: ["DONE"],
    to: "IN_PROGRESS",
    rule: "managers",
    wrongState: "VALIDATION",
  },
  {
    method: "tasks.cancel",
    label: "cancel",
    gate: ["LEAD", "PROJECT_OWNER", "ADMIN"],
    from: ["OPEN", "CLAIMED", "IN_PROGRESS", "BLOCKED", "REVIEW"],
    to: "CANCELLED",
    rule: "managers",
    wrongState: "VALIDATION",
  },
];

/** What the spec says should happen: the resulting state, or an error code. */
function expected(
  row: Row,
  state: State,
  actor: Actor,
): State | "FORBIDDEN" | "VALIDATION" | "CONFLICT_VERSION" {
  if (!row.gate.includes(actor)) return "FORBIDDEN";
  const hasOwner = state !== "OPEN" && !(state === "CANCELLED"); // CANCELLED here was cancelled while OPEN
  const isOwner = actor === "TASK_OWNER" && hasOwner;
  const isLead = actor === "LEAD" || actor === "PROJECT_OWNER" || actor === "ADMIN";
  const actorOk =
    row.rule === "any" ||
    row.rule === "managers" ||
    (row.rule === "owner" && isOwner) ||
    (row.rule === "owner_or_lead" && (isOwner || isLead)) ||
    (row.rule === "reviewer_or_lead" && (actor === "REVIEWER" || actor === "LEAD") && !isOwner);
  if (!actorOk) return "FORBIDDEN";
  return row.from.includes(state) ? row.to : row.wrongState;
}

describe("task state machine conformance (§8.2)", () => {
  for (const row of ROWS) {
    describe(row.label, () => {
      for (const state of STATES) {
        it.each(ACTORS)(`${state} + %s`, async (actor) => {
          const s = await setup();
          const task = await inState(s, state);
          const extra = Object.fromEntries(
            Object.entries(row.extra ?? {}).map(([k, v]) => [
              k,
              v === "$other" ? s.agents[2]!.participant_id : v,
            ]),
          );
          const want = expected(row, state, actor);
          const outcome = await call(s, who(s, actor), row.method, task, extra).then(
            (out) => (out.response as TaskView).status,
            (e: unknown) => (e instanceof CrossoverError ? e.code : String(e)),
          );
          expect(outcome).toBe(want);
          if (want !== outcome || typeof want !== "string") return;
          // A refused command changes nothing.
          if (["FORBIDDEN", "VALIDATION", "CONFLICT_VERSION"].includes(want)) {
            const { rows } = await pool.query("SELECT status, version FROM tasks WHERE id = $1", [
              task.id,
            ]);
            expect(rows[0]).toEqual({ status: task.status, version: task.version });
          }
        });
      }
    });
  }

  it("covers every transition of the §8.2 table", () => {
    const covered = new Set(
      ROWS.flatMap((r) => r.from.map((f) => `${f}->${r.to} via ${r.method}`)),
    );
    for (const edge of [
      "OPEN->CLAIMED via tasks.claim",
      "OPEN->CLAIMED via tasks.assign",
      "CLAIMED->IN_PROGRESS via tasks.start",
      "IN_PROGRESS->BLOCKED via tasks.block",
      "BLOCKED->IN_PROGRESS via tasks.unblock",
      "IN_PROGRESS->REVIEW via tasks.submit",
      "REVIEW->DONE via tasks.review",
      "REVIEW->IN_PROGRESS via tasks.review",
      "CLAIMED->OPEN via tasks.release",
      "IN_PROGRESS->OPEN via tasks.release",
      "BLOCKED->OPEN via tasks.release",
      "DONE->IN_PROGRESS via tasks.reopen",
      "OPEN->CANCELLED via tasks.cancel",
      "CLAIMED->CANCELLED via tasks.cancel",
      "IN_PROGRESS->CANCELLED via tasks.cancel",
      "BLOCKED->CANCELLED via tasks.cancel",
      "REVIEW->CANCELLED via tasks.cancel",
    ]) {
      expect(covered.has(edge), edge).toBe(true);
    }
  });

  it("submit goes straight to DONE when review is not required (the one branch the table can't show)", async () => {
    const s = await setup();
    const t = (
      await s.d.dispatch(
        s.agent,
        cmd("tasks.create", { title: "T", requirements: ["r"], review_required: false }),
      )
    ).response as TaskView;
    const c = (await call(s, s.agent, "tasks.claim", t)).response as TaskView;
    const r = (await call(s, s.agent, "tasks.start", c)).response as TaskView;
    expect(((await call(s, s.agent, "tasks.submit", r)).response as TaskView).status).toBe("DONE");
  });

  it("every state has at least one command that is refused in it", () => {
    for (const state of STATES) {
      const refused = ROWS.some((r) => !r.from.includes(state));
      expect(refused, state).toBe(true);
    }
  });
});
