import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { authorize } from "@crossover/policy";
import { CrossoverError, newId } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Dispatcher } from "../../dispatcher.js";
import type { Principal } from "../../principal.js";
import { registerTaskCommands } from "./create-update.js";
import { MAX_EVIDENCE_BYTES } from "./evidence.js";
import { registerTaskLifecycleCommands } from "./lifecycle.js";
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
  params: Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined)),
  idempotency_key: `k-${++n}`,
});
const read = (method: string, params: Record<string, unknown> = {}) => ({
  id: newId("cmd"),
  method,
  params,
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
  registerTaskCommands(d);
  registerTaskReadCommands(d);
  registerTaskLifecycleCommands(d);
  const room = newId("room");
  await pool.query(
    `INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'n', 'o', 'x')`,
    [room],
  );
  return { d, room, lead: await add(room, "LEAD"), dev: await add(room, "DEVELOPER") };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const REQS = ["README exists", "Tests pass", "No lint errors"];

/** An in-progress task owned by `dev`, with three requirements. */
async function inProgress(s: Setup, extra: Record<string, unknown> = {}) {
  const t = (
    await s.d.dispatch(s.lead, cmd("tasks.create", { title: "Docs", requirements: REQS, ...extra }))
  ).response as TaskView;
  const claimed = (
    await s.d.dispatch(s.dev, cmd("tasks.claim", { task_id: t.id, expected_version: t.version }))
  ).response as TaskView;
  return (
    await s.d.dispatch(
      s.dev,
      cmd("tasks.start", { task_id: t.id, expected_version: claimed.version }),
    )
  ).response as TaskView;
}
const submit = (s: Setup, t: Pick<TaskView, "id" | "version">, evidence?: unknown) =>
  s.d.dispatch(
    s.dev,
    cmd("tasks.submit", { task_id: t.id, expected_version: t.version, evidence }),
  );
const get = async (s: Setup, id: string) =>
  (await s.d.dispatch(s.lead, read("tasks.get", { task_id: id }))).response as TaskView;
const proof = (ref = "ci run 1") => [{ kind: "check", ref }];

const rejects = async (p: Promise<unknown>, code: string) => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CrossoverError);
  expect((err as CrossoverError).code).toBe(code);
  return err as CrossoverError;
};
const setting = (s: Setup, on: boolean) =>
  pool.query("UPDATE rooms SET settings = settings || $2::jsonb WHERE id = $1", [
    s.room,
    JSON.stringify({ require_evidence: on }),
  ]);

describe("evidence on submit (§34.3)", () => {
  it("is stored on the task, carried in task.submitted, and shown with the indices still missing", async () => {
    const s = await setup();
    const t = await inProgress(s);
    expect((await get(s, t.id)).missing_evidence).toEqual([0, 1, 2]); // nothing proven yet
    const evidence = [
      {
        requirement: 1,
        proof: [
          { kind: "test", ref: "docs.test.ts > renders", note: "green" },
          { kind: "check", ref: "pnpm check" },
        ],
        sabotage: [{ broke: "removed the heading", failed: "docs.test.ts > renders" }],
      },
    ];
    const out = await submit(s, t, evidence);
    expect(out.events[0]!.type).toBe("task.submitted");
    expect(out.events[0]!.payload).toMatchObject({ evidence, missing_evidence: [0, 2] });
    const view = out.response as TaskView;
    expect(view).toMatchObject({ status: "REVIEW", evidence, missing_evidence: [0, 2] });
    expect(await get(s, t.id)).toMatchObject({ evidence, missing_evidence: [0, 2] });
    const listed = (
      (await s.d.dispatch(s.lead, read("tasks.list"))).response as { tasks: TaskView[] }
    ).tasks[0]!;
    expect(listed.missing_evidence).toEqual([0, 2]);
  });

  it("a submit with no evidence still works (off by default) and is flagged in the view", async () => {
    const s = await setup();
    const t = await inProgress(s);
    const out = await submit(s, t);
    expect(out.response).toMatchObject({
      status: "REVIEW",
      evidence: [],
      missing_evidence: [0, 1, 2],
    });
  });

  it("an out-of-range or duplicate requirement index is VALIDATION, and nothing is submitted", async () => {
    const s = await setup();
    const t = await inProgress(s);
    const high = await rejects(submit(s, t, [{ requirement: 3, proof: proof() }]), "VALIDATION");
    expect(high.details).toMatchObject({ requirement: 3, requirements: 3 });
    const dup = await rejects(
      submit(s, t, [
        { requirement: 0, proof: proof() },
        { requirement: 0, proof: proof("again") },
      ]),
      "VALIDATION",
    );
    expect(dup.details).toMatchObject({ requirement: 0 });
    await rejects(submit(s, t, [{ requirement: -1, proof: proof() }]), "VALIDATION");
    expect((await get(s, t.id)).status).toBe("IN_PROGRESS");
  });

  it("each requirement needs 1 to 10 proofs of a known kind, and at most 10 sabotage notes", async () => {
    const s = await setup();
    const t = await inProgress(s);
    await rejects(submit(s, t, [{ requirement: 0, proof: [] }]), "VALIDATION");
    await rejects(
      submit(s, t, [
        {
          requirement: 0,
          proof: Array.from({ length: 11 }, (_, i) => ({ kind: "test", ref: `t${i}` })),
        },
      ]),
      "VALIDATION",
    );
    await rejects(
      submit(s, t, [{ requirement: 0, proof: [{ kind: "vibes", ref: "x" }] }]),
      "VALIDATION",
    );
    await rejects(
      submit(s, t, [{ requirement: 0, proof: [{ kind: "test", ref: " " }] }]),
      "VALIDATION",
    );
    await rejects(
      submit(s, t, [
        {
          requirement: 0,
          proof: proof(),
          sabotage: Array.from({ length: 11 }, () => ({ broke: "a", failed: "b" })),
        },
      ]),
      "VALIDATION",
    );
    // The edges are fine.
    await submit(s, t, [
      {
        requirement: 0,
        proof: Array.from({ length: 10 }, (_, i) => ({ kind: "test", ref: `t${i}` })),
        sabotage: Array.from({ length: 10 }, () => ({ broke: "a", failed: "b" })),
      },
    ]);
  });

  it("the total is capped at 32 KiB", async () => {
    const s = await setup();
    const t = await inProgress(s);
    const bulky = (n: number) =>
      Array.from({ length: 3 }, (_, i) => ({
        requirement: i,
        proof: [{ kind: "test", ref: `r${i}`, note: "x".repeat(n) }],
        sabotage: Array.from({ length: 10 }, () => ({
          broke: "b".repeat(n / 2),
          failed: "f".repeat(n / 2),
        })),
      }));
    const err = await rejects(submit(s, t, bulky(1000)), "VALIDATION"); // ~30 proofs × 1 KB + overhead
    expect(err.details).toMatchObject({ limit: MAX_EVIDENCE_BYTES });
    await submit(s, t, bulky(200)); // 30 notes of 200 bytes, comfortably inside
  });

  it("a resubmit after request_changes replaces the evidence; the earlier stays in the events", async () => {
    const s = await setup();
    const t = await inProgress(s);
    const first = [{ requirement: 0, proof: proof("first") }];
    const submitted = (await submit(s, t, first)).response as TaskView;
    const reviewed = (
      await s.d.dispatch(
        s.lead,
        cmd("tasks.review", {
          task_id: t.id,
          expected_version: submitted.version,
          verdict: "request_changes",
          comments: "prove the rest",
        }),
      )
    ).response as TaskView;
    const second = [
      { requirement: 0, proof: proof("second") },
      { requirement: 1, proof: proof("second") },
      { requirement: 2, proof: proof("second") },
    ];
    await submit(s, reviewed, second);
    expect(await get(s, t.id)).toMatchObject({ evidence: second, missing_evidence: [] });
    const { rows } = await pool.query(
      "SELECT payload FROM events WHERE room_id = $1 AND type = 'task.submitted' ORDER BY sequence",
      [s.room],
    );
    expect(rows.map((r) => r.payload.evidence)).toEqual([first, second]);
  });

  it("resubmitting without evidence replaces it with none", async () => {
    const s = await setup();
    const t = await inProgress(s);
    const submitted = (await submit(s, t, [{ requirement: 0, proof: proof() }]))
      .response as TaskView;
    const reviewed = (
      await s.d.dispatch(
        s.lead,
        cmd("tasks.review", {
          task_id: t.id,
          expected_version: submitted.version,
          verdict: "request_changes",
        }),
      )
    ).response as TaskView;
    await submit(s, reviewed);
    expect(await get(s, t.id)).toMatchObject({ evidence: [], missing_evidence: [0, 1, 2] });
  });

  it("the reviewer's REVIEW_REQUEST says how many requirements lack evidence", async () => {
    const s = await setup();
    const inbox = async () =>
      (
        await pool.query(
          "SELECT summary FROM inbox_items WHERE room_id = $1 AND participant_id = $2 AND kind = 'REVIEW_REQUEST' ORDER BY created_at, id",
          [s.room, s.lead.participant_id],
        )
      ).rows.map((r) => r.summary as string);
    await submit(s, await inProgress(s), [{ requirement: 1, proof: proof() }]);
    await submit(s, await inProgress(s), [
      { requirement: 0, proof: proof() },
      { requirement: 1, proof: proof() },
      { requirement: 2, proof: proof() },
    ]);
    await submit(s, await inProgress(s));
    const [partial, full, none] = await inbox();
    expect(partial).toContain("2 of 3 requirements have no evidence");
    expect(full).toBe("Review requested: Docs");
    expect(none).toContain("3 of 3 requirements have no evidence");
  });

  describe("with the room setting require_evidence on", () => {
    it("a submit missing evidence for a requirement is VALIDATION naming the indices, and changes nothing", async () => {
      const s = await setup();
      await setting(s, true);
      const t = await inProgress(s);
      const err = await rejects(submit(s, t, [{ requirement: 1, proof: proof() }]), "VALIDATION");
      expect(err.details).toMatchObject({ missing_evidence: [0, 2] });
      await rejects(submit(s, t), "VALIDATION");
      expect(await get(s, t.id)).toMatchObject({ status: "IN_PROGRESS", evidence: [] });
      const { rows } = await pool.query(
        "SELECT count(*)::int AS n FROM inbox_items WHERE room_id = $1 AND kind = 'REVIEW_REQUEST'",
        [s.room],
      );
      expect(rows[0].n).toBe(0);
    });

    it("evidence for every requirement is accepted, with or without review", async () => {
      const s = await setup();
      await setting(s, true);
      const all = [0, 1, 2].map((requirement) => ({ requirement, proof: proof() }));
      expect((await submit(s, await inProgress(s), all)).response).toMatchObject({
        status: "REVIEW",
      });
      const noReview = await inProgress(s, { review_required: false });
      expect((await submit(s, noReview, all)).response).toMatchObject({
        status: "DONE",
        evidence: all,
      });
    });

    it("switching it off again accepts the same submit, flagged", async () => {
      const s = await setup();
      await setting(s, true);
      const t = await inProgress(s);
      await rejects(submit(s, t), "VALIDATION");
      await setting(s, false);
      expect((await submit(s, t)).response).toMatchObject({
        status: "REVIEW",
        missing_evidence: [0, 1, 2],
      });
    });
  });

  it("only the owner submits, as before (evidence doesn't change who may)", async () => {
    const s = await setup();
    const t = await inProgress(s);
    await rejects(
      s.d.dispatch(
        s.lead,
        cmd("tasks.submit", { task_id: t.id, expected_version: t.version, evidence: [] }),
      ),
      "FORBIDDEN",
    );
  });
});
