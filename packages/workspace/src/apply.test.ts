import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withTransaction } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { allowAll, Dispatcher, type Authorizer, type CommandContext } from "@crossover/kernel";
import { CrossoverError, newId } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { git } from "./git.js";
import { materialize } from "./materialize.js";
import { merge } from "./merge.js";
import { parseConflicts } from "./parse-check.js";
import {
  apply as applyChangeset,
  registerWorkspaceCommands,
  type ApplyResponse,
  type ApplyExtras,
  type WorkspaceCommandDeps,
} from "./apply.js";
import { changesetParamsSchema } from "./changeset.js";
import { UPSTREAM_ACTOR } from "./upstream-import.js";
import { ConflictEscalationSweeper } from "./conflict-escalation-sweeper.js";
import { HealthCheckQueue } from "./health-queue.js";
import { provisionWorkspace } from "./provision.js";
import type { Operation } from "./operations.js";

let db: TestDatabase;
const dirs: string[] = [];

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function objectKeys(value: unknown): string[] {
  if (value === null || typeof value !== "object") {
    throw new Error("Expected a non-null object response");
  }
  return Object.keys(value);
}

beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(authorize: Authorizer = allowAll, deps: WorkspaceCommandDeps = {}) {
  const room = newId("room");
  const actor = newId("part");
  const root = await mkdtemp(join(tmpdir(), "crossover-apply-test-"));
  dirs.push(root);
  await db.pool.query(
    "INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'Room', 'Ship', $2)",
    [room, actor],
  );
  await db.pool.query(
    `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status)
     VALUES ($2, $1, 'HUMAN', 'Actor', 'MEMBER', 'DEVELOPER', 'ACTIVE')`,
    [room, actor],
  );
  const workspace = await withTransaction(db.pool, (client) =>
    provisionWorkspace(client, room, root),
  );
  const { rows } = await db.pool.query("SELECT repo_path FROM workspaces WHERE room_id = $1", [
    room,
  ]);
  const repo = rows[0].repo_path as string;
  const options = { gitDir: repo, timeoutMs: 10_000 };
  const dispatcher = new Dispatcher({ pool: db.pool, authorize, nodeId: room });
  const scheduledAdvances: Array<{ room_id: string; revision: number }> = [];
  registerWorkspaceCommands(dispatcher, {
    ...deps,
    scheduleSandboxAdvance: (roomId, revision) => {
      scheduledAdvances.push({ room_id: roomId, revision });
      deps.scheduleSandboxAdvance?.(roomId, revision);
    },
  });
  const head = async () => (await git(["rev-parse", "refs/room/canonical"], options)).stdout.trim();
  const request = (operations: Operation[], base = 0, key = newId("cmd")) => ({
    id: newId("cmd"),
    method: "workspace.apply_changeset",
    idempotency_key: key,
    params: { source: "API", message: "Edit", base_workspace_revision: base, operations },
  });
  const dispatch = (input: Parameters<Dispatcher["dispatch"]>[1]) =>
    dispatcher.dispatch(
      {
        room_id: room,
        participant_id: actor,
        kind: "HUMAN",
        authority: "MEMBER",
        role: "DEVELOPER",
      },
      input,
    );
  const dispatchAs =
    (
      participantId: string,
      role: "DEVELOPER" | "LEAD" = "DEVELOPER",
      kind: "HUMAN" | "AGENT" = "HUMAN",
    ) =>
    (input: Parameters<Dispatcher["dispatch"]>[1]) =>
      dispatcher.dispatch(
        {
          room_id: room,
          participant_id: participantId,
          kind,
          authority: "MEMBER",
          role,
        },
        input,
      );
  const addParticipant = async (id: string, kind: "HUMAN" | "AGENT" = "HUMAN") =>
    db.pool.query(
      `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status)
       VALUES ($2, $1, $3, 'Member', 'MEMBER', 'DEVELOPER', 'ACTIVE')`,
      [room, id, kind],
    );
  const apply = (operations: Operation[], base = 0) => dispatch(request(operations, base));
  // Call `apply` directly with `extras` (e.g. an upstream actor), outside the
  // dispatcher, so the test can exercise caller-specific pipeline behavior.
  const applyDirect = async (operations: Operation[], base: number, extras: ApplyExtras) => {
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      const ctx: CommandContext = {
        client,
        room_id: room,
        command_id: newId("cmd"),
        idempotency_key: newId("cmd"),
        principal: {
          room_id: room,
          participant_id: actor,
          kind: "HUMAN",
          authority: "MEMBER",
          role: "DEVELOPER",
        },
        authorize: async () => {},
        authorizeAs: async () => {},
        afterCommit: () => {},
      };
      const params = changesetParamsSchema.parse({
        source: "API",
        message: "Edit",
        base_workspace_revision: base,
        operations,
      });
      const out = await applyChangeset(ctx, params, deps, extras);
      await client.query("COMMIT");
      return out;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  };
  const rowsFor = async (
    table: "changesets" | "workspace_revisions" | "file_revisions" | "events" | "conflicts",
  ) => (await db.pool.query(`SELECT * FROM ${table} WHERE room_id = $1`, [room])).rows;
  return {
    room,
    actor,
    workspace,
    repo,
    options,
    head,
    request,
    dispatch,
    dispatchAs,
    addParticipant,
    apply,
    applyDirect,
    rowsFor,
    dispatcher,
    scheduledAdvances,
  };
}

async function seedConflict(
  f: Awaited<ReturnType<typeof fixture>>,
  submitter = f.actor,
  kind: "HUMAN" | "AGENT" = "HUMAN",
) {
  await f.apply([{ type: "create", path: "escalate.txt", content: "base\n" }]);
  await f.apply([{ type: "modify", path: "escalate.txt", content: "head\n" }], 1);
  const result = await f.dispatchAs(
    submitter,
    "DEVELOPER",
    kind,
  )(f.request([{ type: "modify", path: "escalate.txt", content: "submitted\n" }], 1));
  return result.response as { conflict_id: string; changeset_id: string; status: string };
}

describe("workspace.apply_changeset", () => {
  // Measured (T1529): idle 1673 ms, 3x load 3335 ms; budget 7x.
  it("records a parse conflict from a real clean merge of Python edits", async () => {
    const f = await fixture();
    const path = "src/main.py";
    const baseContent = "if x:\n    a()\n\nb()\n";
    const ours = "a()\n\nb()\n";
    const theirs = "if x:\n    a()\n\n    b()\n";
    await f.apply([{ type: "create", path, content: baseContent }]);
    const base = await f.head();
    await f.apply([{ type: "modify", path, content: theirs }], 1);
    const head = await f.head();
    const candidate = await materialize(f.repo, base, [{ type: "modify", path, content: ours }]);
    const merged = await merge(f.repo, base, head, candidate);
    expect(merged.clean).toBe(true);
    if (!merged.clean) throw new Error("Expected a clean Git merge");
    expect((await git(["show", `${merged.tree}:${path}`], f.options)).stdout).toBe(
      "a()\n\n    b()\n",
    );
    await expect(parseConflicts(f.repo, head, candidate, merged)).resolves.toEqual([path]);

    const response = await f.apply([{ type: "modify", path, content: ours }], 1);

    expect(response.response).toMatchObject({ status: "CONFLICT" });
    expect(await f.rowsFor("conflicts")).toMatchObject([{ files: [{ path, kind: "PARSE" }] }]);
    expect(await f.rowsFor("workspace_revisions")).toHaveLength(3);
  }, 25_000);

  it("logs parser failures and lets a clean ChangeSet apply", async () => {
    const logger = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const f = await fixture(allowAll, {
        parseConflicts: async () => {
          throw new Error("Tree-sitter unavailable");
        },
      });
      const response = await f.apply([
        { type: "create", path: "src/main.ts", content: "const value = 1;\n" },
      ]);
      expect(response.response).toMatchObject({ status: "APPLIED" });
      expect(logger).toHaveBeenCalledWith(
        "Workspace syntax check failed; allowing the clean merge",
        expect.objectContaining({ room_id: f.room }),
      );
    } finally {
      logger.mockRestore();
    }
  });

  // Measured (T1529): idle 2191 ms, 3x load 4485 ms; budget 7x.
  it("coalesces ten rapid applied revisions into the active and latest health checks", async () => {
    const firstGate = deferred();
    const secondGate = deferred();
    const secondStarted = deferred();
    const started: number[] = [];
    const queue = new HealthCheckQueue({
      run: async (_roomId, revision) => {
        started.push(revision);
        if (revision === 1) await firstGate.promise;
        else {
          secondStarted.resolve();
          await secondGate.promise;
        }
      },
    });
    const f = await fixture(allowAll, {
      scheduleHealthCheck: (roomId, revision) => queue.enqueue(roomId, revision),
    });

    for (let revision = 0; revision < 10; revision += 1) {
      await f.apply(
        [{ type: "create", path: `rapid-${revision}.txt`, content: `${revision}\n` }],
        revision,
      );
    }
    expect(started).toEqual([1]);

    firstGate.resolve();
    await secondStarted.promise;
    expect(started).toEqual([1, 10]);
    secondGate.resolve();
    await queue.close();
  }, 35_000);

  it("schedules Zoekt indexing after apply without waiting for the index process", async () => {
    const releaseIndex = deferred();
    const started = deferred();
    const queue = new HealthCheckQueue({
      run: async () => {
        started.resolve();
        await releaseIndex.promise;
      },
    });
    const f = await fixture(allowAll, {
      scheduleSearchIndex: (roomId, revision) => queue.enqueue(roomId, revision),
    });
    try {
      const applied = await f.apply([{ type: "create", path: "index-me.txt", content: "head\n" }]);
      expect(applied.response).toMatchObject({ status: "APPLIED", applied_revision: 1 });
      await started.promise;
    } finally {
      releaseIndex.resolve();
      await queue.close();
    }
  });

  // Measured (T1529): idle 2682 ms, 3x load 3714 ms; budget 7x.
  it("does not schedule health checks for conflicted or rejected ChangeSets", async () => {
    const scheduled: number[] = [];
    const f = await fixture(allowAll, {
      scheduleHealthCheck: (_roomId, revision) => scheduled.push(revision),
    });

    await f.apply([{ type: "create", path: "file.txt", content: "base\n" }]);
    await f.apply([{ type: "modify", path: "file.txt", content: "head\n" }], 1);
    const conflict = await f.apply(
      [{ type: "modify", path: "file.txt", content: "conflicting\n" }],
      1,
    );
    expect(conflict.response).toMatchObject({ status: "CONFLICT" });
    await expect(
      f.apply([{ type: "create", path: "rejected.txt", content: "x" }], 99),
    ).rejects.toMatchObject({ code: "VALIDATION" });

    expect(scheduled).toEqual([1, 2]);
  }, 30_000);

  it("apply_changeset refuses source BRANCH from a client", async () => {
    const f = await fixture();
    const base = f.request([{ type: "create", path: "file", content: "x" }]);
    await expect(
      f.dispatch({ ...base, params: { ...base.params, source: "BRANCH" } }),
    ).rejects.toMatchObject({ code: "VALIDATION", details: { reason: "reserved_source" } });
    expect(await f.rowsFor("changesets")).toEqual([]);
  });

  it("requires RESOLUTION and conflict_id together", async () => {
    const f = await fixture();
    const base = f.request([{ type: "create", path: "file", content: "x" }]);
    await expect(
      f.dispatch({ ...base, params: { ...base.params, source: "RESOLUTION" } }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(
      f.dispatch({
        ...base,
        params: { ...base.params, conflict_id: "conf_missing" } as typeof base.params & {
          conflict_id: string;
        },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await f.rowsFor("changesets")).toEqual([]);
  });

  // Measured (T1529): idle 1975 ms, 3x load 2437 ms; budget 7x.
  it("lets the lead resolve a conflict and supersedes its original ChangeSet", async () => {
    const f = await fixture();
    const lead = newId("part");
    await f.addParticipant(lead);
    await db.pool.query("UPDATE rooms SET lead_participant_id = $2 WHERE id = $1", [f.room, lead]);
    await f.apply([{ type: "create", path: "file", content: "base\n" }]);
    await f.apply([{ type: "modify", path: "file", content: "head\n" }], 1);
    const conflictResult = await f.apply(
      [{ type: "modify", path: "file", content: "submitter\n" }],
      1,
    );
    const conflictId = (conflictResult.response as { conflict_id: string }).conflict_id;
    const originalId = (conflictResult.response as { changeset_id: string }).changeset_id;
    const resolution = f.request([{ type: "modify", path: "file", content: "resolved\n" }], 2);
    const resolutionRequest = {
      ...resolution,
      params: { ...resolution.params, source: "RESOLUTION" as const, conflict_id: conflictId },
    };
    const result = await f.dispatchAs(lead, "LEAD")(resolutionRequest);
    expect(result.response).toMatchObject({ status: "APPLIED", applied_revision: 3 });
    expect(f.scheduledAdvances).toEqual([
      { room_id: f.room, revision: 1 },
      { room_id: f.room, revision: 2 },
      { room_id: f.room, revision: 3 },
    ]);
    expect(result.events.map((event) => event.type)).toEqual([
      "workspace.changeset.applied",
      "workspace.conflict.resolved",
    ]);
    expect(await f.rowsFor("conflicts")).toMatchObject([
      {
        id: conflictId,
        status: "RESOLVED",
        resolver_id: lead,
        resolution_changeset_id: (result.response as { changeset_id: string }).changeset_id,
      },
    ]);
    expect((await f.rowsFor("changesets")).find((row) => row.id === originalId)).toMatchObject({
      status: "REJECTED",
      rejection_reason: "SUPERSEDED",
    });
    const revisionCount = (await f.rowsFor("workspace_revisions")).length;
    await expect(
      f.dispatchAs(
        lead,
        "LEAD",
      )({
        ...resolutionRequest,
        id: newId("cmd"),
        idempotency_key: newId("cmd"),
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT_VERSION",
      details: { status: "RESOLVED" },
    });
    expect((await f.rowsFor("workspace_revisions")).length).toBe(revisionCount);
    expect((await f.rowsFor("changesets")).find((row) => row.id === originalId)?.status).toBe(
      "REJECTED",
    );
  }, 20_000);

  it("keeps an escalated conflict escalated when a resolution attempt fails", async () => {
    let failMerge = false;
    const f = await fixture(allowAll, {
      merge: async (...args) =>
        failMerge
          ? {
              clean: false,
              tree: "",
              conflicts: {
                files: [{ path: "file", stages: [] }],
                messages: [{ paths: ["file"], type: "CONFLICT (content)", message: "conflict" }],
              },
            }
          : (await import("./merge.js")).merge(...args),
    });
    await f.apply([{ type: "create", path: "file", content: "base\n" }]);
    await f.apply([{ type: "modify", path: "file", content: "head\n" }], 1);
    const conflictResult = await f.apply(
      [{ type: "modify", path: "file", content: "submitter\n" }],
      1,
    );
    const conflictId = (conflictResult.response as { conflict_id: string }).conflict_id;
    const originalId = (conflictResult.response as { changeset_id: string }).changeset_id;
    await db.pool.query("UPDATE conflicts SET status = 'ESCALATED' WHERE id = $1", [conflictId]);
    failMerge = true;
    const retry = f.request([{ type: "modify", path: "file", content: "retry\n" }], 2);
    const retryRequest = {
      ...retry,
      params: { ...retry.params, source: "RESOLUTION" as const, conflict_id: conflictId },
    };
    const retryResult = await f.dispatch(retryRequest);
    expect(retryResult.response).toMatchObject({ status: "CONFLICT", conflict_id: conflictId });
    expect(retryResult.events).toEqual([]);
    expect(await f.rowsFor("conflicts")).toMatchObject([
      { id: conflictId, status: "ESCALATED", attempts: 1, changeset_id: originalId },
    ]);
    expect(await f.rowsFor("conflicts")).toHaveLength(1);
    expect(await f.dispatch({ ...retryRequest, id: newId("cmd") })).toEqual({
      ...retryResult,
      replayed: true,
    });
    expect((await f.rowsFor("conflicts"))[0]?.attempts).toBe(1);
  });

  it("denies a participant who is neither submitter, lead, nor owner", async () => {
    const f = await fixture();
    const outsider = newId("part");
    await f.addParticipant(outsider);
    await f.apply([{ type: "create", path: "file", content: "base\n" }]);
    await f.apply([{ type: "modify", path: "file", content: "head\n" }], 1);
    const conflictResult = await f.apply(
      [{ type: "modify", path: "file", content: "submitter\n" }],
      1,
    );
    const conflictId = (conflictResult.response as { conflict_id: string }).conflict_id;
    const resolution = f.request([{ type: "modify", path: "file", content: "retry\n" }], 2);
    const resolutionRequest = {
      ...resolution,
      params: { ...resolution.params, source: "RESOLUTION" as const, conflict_id: conflictId },
    };
    await expect(f.dispatchAs(outsider)(resolutionRequest)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await f.rowsFor("changesets")).toHaveLength(3);
    expect(await f.rowsFor("conflicts")).toMatchObject([{ id: conflictId, attempts: 0 }]);
  });

  it("lets only the submitter manually escalate and notifies the lead exactly once", async () => {
    const f = await fixture();
    const lead = newId("part");
    const outsider = newId("part");
    await f.addParticipant(lead);
    await f.addParticipant(outsider);
    await db.pool.query("UPDATE rooms SET lead_participant_id = $2 WHERE id = $1", [f.room, lead]);
    const { conflict_id: conflictId } = await seedConflict(f);
    const command = () => ({
      id: newId("cmd"),
      idempotency_key: newId("cmd"),
      method: "conflicts.escalate",
      params: { conflict_id: conflictId },
    });

    await expect(f.dispatchAs(outsider)(command())).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await f.rowsFor("conflicts"))[0]?.status).toBe("OPEN");
    const escalated = await f.dispatchAs(f.actor)(command());
    expect(escalated).toMatchObject({
      response: { conflict_id: conflictId, status: "ESCALATED" },
      events: [
        {
          type: "workspace.conflict.escalated",
          payload: {
            conflict_id: conflictId,
            escalated_to: lead,
            trigger: "manual",
          },
        },
        {
          type: "inbox.delivered",
          actor_id: "system",
          payload: {
            recipient_id: lead,
            item_id: expect.stringMatching(/^inbox_/),
            kind: "ESCALATION",
          },
        },
      ],
    });
    expect(Object.keys(escalated.events[0]!.payload).sort()).toEqual([
      "changeset_id",
      "conflict_id",
      "escalated_to",
      "submitter_id",
      "trigger",
    ]);
    expect((await f.rowsFor("conflicts"))[0]?.escalated_at).toBeInstanceOf(Date);
    await expect(f.dispatchAs(f.actor)(command())).resolves.toMatchObject({ events: [] });
    const { rows: inbox } = await db.pool.query(
      "SELECT participant_id, kind, ref FROM inbox_items WHERE room_id = $1",
      [f.room],
    );
    expect(inbox).toEqual([
      { participant_id: lead, kind: "ESCALATION", ref: { kind: "conflict", id: conflictId } },
    ]);
  });

  // Measured (T1529): idle 1968 ms, 3x load 2086 ms; budget 7x.
  it("sends escalation to the owner when the lead submitted the conflict", async () => {
    const f = await fixture();
    const owner = newId("part");
    await f.addParticipant(owner);
    await db.pool.query("UPDATE participants SET authority = 'OWNER' WHERE id = $1", [owner]);
    await db.pool.query("UPDATE rooms SET owner_id = $2, lead_participant_id = $3 WHERE id = $1", [
      f.room,
      owner,
      f.actor,
    ]);
    const { conflict_id: conflictId } = await seedConflict(f);
    const result = await f.dispatchAs(
      f.actor,
      "LEAD",
    )({
      id: newId("cmd"),
      idempotency_key: newId("cmd"),
      method: "conflicts.escalate",
      params: { conflict_id: conflictId },
    });
    expect(result.events[0]?.payload).toMatchObject({ escalated_to: owner, trigger: "manual" });
    const { rows } = await db.pool.query(
      "SELECT participant_id FROM inbox_items WHERE room_id = $1",
      [f.room],
    );
    expect(rows).toEqual([{ participant_id: owner }]);
  }, 15_000);

  // Measured (T1529): idle 2087 ms, 3x load 5112 ms; budget 7x.
  it("automatically escalates after the second failed resolution attempt", async () => {
    const f = await fixture();
    const lead = newId("part");
    await f.addParticipant(lead);
    await db.pool.query("UPDATE rooms SET lead_participant_id = $2 WHERE id = $1", [f.room, lead]);
    const { conflict_id: conflictId } = await seedConflict(f);
    const resolveAndFail = (base: number, content: string) => {
      const request = f.request([{ type: "modify", path: "escalate.txt", content }], base);
      return f.dispatch({
        ...request,
        params: { ...request.params, source: "RESOLUTION", conflict_id: conflictId },
      });
    };
    await f.apply([{ type: "modify", path: "escalate.txt", content: "head 3\n" }], 2);
    expect((await resolveAndFail(2, "resolution one\n")).response).toMatchObject({
      status: "CONFLICT",
    });
    await f.apply([{ type: "modify", path: "escalate.txt", content: "head 4\n" }], 3);
    const second = await resolveAndFail(3, "resolution two\n");
    expect(second.response).toMatchObject({ status: "CONFLICT" });
    expect(second.events).toMatchObject([
      {
        type: "workspace.conflict.escalated",
        payload: { conflict_id: conflictId, escalated_to: lead, trigger: "attempts" },
      },
      {
        type: "inbox.delivered",
        actor_id: "system",
        payload: {
          recipient_id: lead,
          item_id: expect.stringMatching(/^inbox_/),
          kind: "ESCALATION",
        },
      },
    ]);
    expect((await f.rowsFor("conflicts"))[0]).toMatchObject({ status: "ESCALATED", attempts: 2 });
    const { rows } = await db.pool.query(
      "SELECT participant_id FROM inbox_items WHERE room_id = $1",
      [f.room],
    );
    expect(rows).toEqual([{ participant_id: lead }]);
  }, 40_000);

  // Measured (T1529): idle 1624 ms, 3x load 2319 ms; budget 7x.
  it("sweeps agent conflicts at the 10-minute boundary using its injected clock", async () => {
    const f = await fixture();
    const agent = newId("part");
    const lead = newId("part");
    await f.addParticipant(agent, "AGENT");
    await f.addParticipant(lead);
    await db.pool.query("UPDATE rooms SET lead_participant_id = $2 WHERE id = $1", [f.room, lead]);
    const { conflict_id: conflictId } = await seedConflict(f, agent, "AGENT");
    await db.pool.query("UPDATE participants SET status = 'PAUSED' WHERE id = $1", [agent]);
    await db.pool.query(
      "UPDATE conflicts SET created_at = clock_timestamp() - interval '11 minutes' WHERE id = $1",
      [conflictId],
    );
    const created = (
      await db.pool.query<{ created_at: Date }>("SELECT created_at FROM conflicts WHERE id = $1", [
        conflictId,
      ])
    ).rows[0]!.created_at;
    let now = new Date(created.getTime() + 10 * 60 * 1000 - 1);
    const sweeper = new ConflictEscalationSweeper({
      pool: db.pool,
      dispatcher: f.dispatcher,
      now: () => now,
      rooms: [f.room],
      onError: (error) => {
        throw error;
      },
    });
    expect(await sweeper.tick()).toBe(0);
    expect((await f.rowsFor("conflicts"))[0]?.status).toBe("OPEN");

    now = new Date(created.getTime() + 10 * 60 * 1000 + 1);
    expect(await sweeper.tick()).toBe(1);
    expect((await f.rowsFor("conflicts"))[0]?.status).toBe("ESCALATED");
    const events = await f.rowsFor("events");
    expect(events.slice(-2)).toMatchObject([
      {
        type: "workspace.conflict.escalated",
        actor_id: "system",
        payload: { conflict_id: conflictId, escalated_to: lead, trigger: "timeout" },
      },
      {
        type: "inbox.delivered",
        actor_id: "system",
        payload: { recipient_id: lead, kind: "ESCALATION" },
      },
    ]);
    const { rows } = await db.pool.query(
      "SELECT participant_id FROM inbox_items WHERE room_id = $1",
      [f.room],
    );
    expect(rows).toEqual([{ participant_id: lead }]);
  }, 20_000);

  // Measured (T1529): idle 1600 ms, 3x load 2435 ms; budget 7x.
  it("does not sweep conflicts in rooms this node does not hold", async () => {
    const f = await fixture();
    const agent = newId("part");
    await f.addParticipant(agent, "AGENT");
    const { conflict_id: conflictId } = await seedConflict(f, agent, "AGENT");
    await db.pool.query(
      "UPDATE conflicts SET created_at = clock_timestamp() - interval '11 minutes' WHERE id = $1",
      [conflictId],
    );
    const sweeper = new ConflictEscalationSweeper({
      pool: db.pool,
      dispatcher: f.dispatcher,
      rooms: [newId("room")],
      onError: (error) => {
        throw error;
      },
    });

    expect(await sweeper.tick()).toBe(0);
    expect((await f.rowsFor("conflicts"))[0]?.status).toBe("OPEN");
  }, 20_000);

  // Measured (T1529): idle 3231 ms, 3x load 5163 ms; budget 7x.
  it("lets the submitter, lead, or owner abandon and rejects the original ChangeSet", async () => {
    for (const resolver of ["submitter", "lead", "owner"] as const) {
      const f = await fixture();
      const submitter = newId("part");
      await f.addParticipant(submitter);
      const lead = newId("part");
      if (resolver === "lead") {
        await f.addParticipant(lead);
        await db.pool.query("UPDATE rooms SET lead_participant_id = $2 WHERE id = $1", [
          f.room,
          lead,
        ]);
      }
      await f.apply([{ type: "create", path: "file", content: "base\n" }]);
      await f.apply([{ type: "modify", path: "file", content: "head\n" }], 1);
      const submitted = f.request([{ type: "modify", path: "file", content: "candidate\n" }], 1);
      const conflictResult = await f.dispatchAs(submitter)(submitted);
      const conflictId = (conflictResult.response as { conflict_id: string }).conflict_id;
      const originalId = (conflictResult.response as { changeset_id: string }).changeset_id;
      if (resolver === "lead")
        await db.pool.query("UPDATE conflicts SET status = 'ESCALATED' WHERE id = $1", [
          conflictId,
        ]);
      const who = resolver === "submitter" ? submitter : resolver === "lead" ? lead : f.actor;
      const role = resolver === "lead" ? "LEAD" : "DEVELOPER";
      const abandonRequest = {
        id: newId("cmd"),
        idempotency_key: newId("cmd"),
        method: "conflicts.abandon",
        params: { conflict_id: conflictId },
      };
      const abandon = await f.dispatchAs(who, role)(abandonRequest);
      expect(abandon.response).toEqual({
        conflict_id: conflictId,
        changeset_id: originalId,
        status: "ABANDONED",
      });
      expect(abandon.events).toMatchObject([
        {
          type: "workspace.conflict.abandoned",
          payload: {
            conflict_id: conflictId,
            changeset_id: originalId,
            submitter_id: submitter,
            abandoned_by: who,
          },
        },
      ]);
      expect((await f.rowsFor("conflicts"))[0]).toMatchObject({
        id: conflictId,
        status: "ABANDONED",
      });
      expect((await f.rowsFor("changesets")).find((row) => row.id === originalId)).toMatchObject({
        status: "REJECTED",
        rejection_reason: "ABANDONED",
      });
      const eventCount = (await f.rowsFor("events")).length;
      expect(await f.dispatchAs(who, role)({ ...abandonRequest, id: newId("cmd") })).toEqual({
        ...abandon,
        replayed: true,
      });
      expect((await f.rowsFor("events")).length).toBe(eventCount);
    }
  }, 40_000);

  // Measured (T1529): idle 4554 ms, 3x load 4201 ms; budget 7x.
  it("rejects abandoning missing, foreign-room, and terminal conflicts", async () => {
    const f = await fixture();
    const other = await fixture();
    const outsider = newId("part");
    await f.addParticipant(outsider);
    const abandon = (
      who: ReturnType<typeof f.dispatchAs>,
      conflictId: string,
      key = newId("cmd"),
    ) =>
      who({
        id: newId("cmd"),
        idempotency_key: key,
        method: "conflicts.abandon",
        params: { conflict_id: conflictId },
      });
    await expect(abandon(f.dispatch, "conf_missing")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await f.apply([{ type: "create", path: "file", content: "base\n" }]);
    await f.apply([{ type: "modify", path: "file", content: "head\n" }], 1);
    const conflictResult = await f.apply(
      [{ type: "modify", path: "file", content: "candidate\n" }],
      1,
    );
    const conflictId = (conflictResult.response as { conflict_id: string }).conflict_id;
    await expect(abandon(other.dispatch, conflictId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const eventsBefore = await f.rowsFor("events");
    await expect(abandon(f.dispatchAs(outsider), conflictId)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect((await f.rowsFor("conflicts"))[0]).toMatchObject({
      id: conflictId,
      status: "OPEN",
    });
    expect(await f.rowsFor("events")).toEqual(eventsBefore);
    await db.pool.query("UPDATE conflicts SET status = 'RESOLVED' WHERE id = $1", [conflictId]);
    const changesetsBefore = await other.rowsFor("changesets");
    await expect(abandon(f.dispatch, conflictId)).rejects.toMatchObject({
      code: "CONFLICT_VERSION",
      details: { status: "RESOLVED" },
    });
    expect(await f.rowsFor("changesets")).toHaveLength(3);
    expect(await f.rowsFor("events")).toEqual(eventsBefore);
    expect(await other.rowsFor("changesets")).toEqual(changesetsBefore);
  }, 30_000);

  // Measured (T1529): idle 3058 ms, 3x load 5124 ms; budget 7x.
  it("allows the original submitter and room owner to resolve", async () => {
    for (const resolver of ["submitter", "owner"] as const) {
      const f = await fixture();
      const submitter = newId("part");
      await f.addParticipant(submitter);
      await f.apply([{ type: "create", path: "file", content: "base\n" }]);
      await f.apply([{ type: "modify", path: "file", content: "head\n" }], 1);
      const submitted = f.request([{ type: "modify", path: "file", content: "candidate\n" }], 1);
      const conflictResult = await f.dispatchAs(submitter)(submitted);
      const conflictId = (conflictResult.response as { conflict_id: string }).conflict_id;
      const who = resolver === "submitter" ? submitter : f.actor;
      const resolution = f.request([{ type: "modify", path: "file", content: "resolved\n" }], 2);
      const result = await f.dispatchAs(who)({
        ...resolution,
        params: {
          ...resolution.params,
          source: "RESOLUTION" as const,
          conflict_id: conflictId,
        } as typeof resolution.params & { conflict_id: string },
      });
      expect(result.response).toMatchObject({ status: "APPLIED" });
      expect((await f.rowsFor("conflicts"))[0]).toMatchObject({
        id: conflictId,
        status: "RESOLVED",
        resolver_id: who,
      });
    }
  }, 40_000);

  // Measured (T1529): idle 2380 ms, 3x load 3297 ms; budget 7x.
  it("returns NOT_FOUND for unknown and cross-room conflict IDs", async () => {
    const f = await fixture();
    const otherRoom = await fixture();
    const unknown = f.request([{ type: "create", path: "file", content: "x" }]);
    await expect(
      f.dispatch({
        ...unknown,
        params: {
          ...unknown.params,
          source: "RESOLUTION",
          conflict_id: "conf_unknown",
        } as typeof unknown.params & { conflict_id: string },
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await f.apply([{ type: "create", path: "file", content: "base\n" }]);
    await f.apply([{ type: "modify", path: "file", content: "head\n" }], 1);
    const conflictResult = await f.apply(
      [{ type: "modify", path: "file", content: "candidate\n" }],
      1,
    );
    const crossRoom = otherRoom.request([{ type: "create", path: "file", content: "x" }]);
    await expect(
      otherRoom.dispatch({
        ...crossRoom,
        params: {
          ...crossRoom.params,
          source: "RESOLUTION",
          conflict_id: (conflictResult.response as { conflict_id: string }).conflict_id,
        } as typeof crossRoom.params & { conflict_id: string },
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await otherRoom.rowsFor("changesets")).toEqual([]);
  }, 25_000);

  it("commits revision, file history and event together, then replays the original result", async () => {
    const f = await fixture();
    const input = f.request([{ type: "create", path: "file", content: "one" }]);
    const result = await f.dispatch(input);
    expect(result.response).toMatchObject({ status: "APPLIED", applied_revision: 1 });
    expect(result.events).toMatchObject([
      { type: "workspace.changeset.applied", payload: { applied_revision: 1 } },
    ]);
    expect((await f.rowsFor("changesets"))[0]).toMatchObject({
      status: "APPLIED",
      actor_id: f.actor,
      idempotency_key: input.idempotency_key,
      applied_revision: "1",
    });
    const revisions = await f.rowsFor("workspace_revisions");
    expect(revisions).toHaveLength(2);
    expect(await f.head()).toBe(revisions.find((r) => r.revision === "1")!.commit_sha);
    expect(await f.rowsFor("file_revisions")).toMatchObject([
      { path: "file", revision: "1", workspace_revision: "1", actor_id: f.actor },
    ]);
    expect(await f.dispatch({ ...input, id: newId("cmd") })).toEqual({ ...result, replayed: true });
    expect(await f.rowsFor("changesets")).toHaveLength(1);
    expect(await f.rowsFor("events")).toHaveLength(1);
  });

  it("records structured_merges in an applied ChangeSet payload", async () => {
    const f = await fixture(allowAll, {
      merge: (repo, base, head, candidate) =>
        merge(repo, base, head, candidate, {
          drivers: [
            {
              name: "test",
              matches: (path) => path === "file.txt",
              merge: async () => ({ ok: true, content: "merged\n" }),
            },
          ],
        }),
    });
    await f.apply([{ type: "create", path: "file.txt", content: "base\n" }]);
    await f.apply([{ type: "modify", path: "file.txt", content: "head\n" }], 1);
    const result = await f.apply([{ type: "modify", path: "file.txt", content: "candidate\n" }], 1);
    expect(result.response).toMatchObject({ status: "APPLIED", applied_revision: 3 });
    expect(result.events).toMatchObject([
      { type: "workspace.changeset.applied", payload: { applied_revision: 3 } },
    ]);
    expect(objectKeys(result.response).sort()).toEqual([
      "applied_revision",
      "changeset_id",
      "status",
    ]);
    expect(
      result.events.every((event) => !Object.keys(event.payload).includes("structured_merges")),
    ).toBe(true);
    const payload = (await f.rowsFor("changesets")).find(
      (row) => row.applied_revision === "3",
    )?.payload;
    expect(payload?.structured_merges).toEqual([{ path: "file.txt", driver: "test" }]);
  });

  it("keeps classified conflicts unchanged and records structured_merge_refusals", async () => {
    const setup = async (withDriver: boolean) => {
      const f = await fixture(
        allowAll,
        withDriver
          ? {
              merge: (repo, base, head, candidate) =>
                merge(repo, base, head, candidate, {
                  drivers: [
                    {
                      name: "test",
                      matches: (path) => path === "file.txt",
                      merge: async () => ({ ok: false, reason: "unsupported" }),
                    },
                  ],
                }),
            }
          : {},
      );
      await f.apply([{ type: "create", path: "file.txt", content: "base\n" }]);
      await f.apply([{ type: "modify", path: "file.txt", content: "head\n" }], 1);
      const response = await f.apply(
        [{ type: "modify", path: "file.txt", content: "candidate\n" }],
        1,
      );
      const payload = (await f.rowsFor("changesets")).find(
        (row) => row.status === "CONFLICT",
      )?.payload;
      return { response, payload };
    };
    const baseline = await setup(false);
    const refused = await setup(true);
    expect(refused.response.response).toMatchObject({ status: "CONFLICT" });
    const stableResult = (result: typeof baseline.response) => {
      const response = result.response as Extract<ApplyResponse, { status: "CONFLICT" }>;
      return {
        response: {
          ...response,
          changeset_id: "<generated>",
          conflict_id: "<generated>",
          counterparty_changesets: response.counterparty_changesets.map(() => "<generated>"),
        },
        events: result.events.map((event) => ({
          type: event.type,
          sequence: event.sequence,
          schema_version: event.schema_version,
          payload: {
            ...event.payload,
            conflict_id: "<generated>",
            changeset_id: "<generated>",
            submitter_id: "<generated>",
          },
        })),
      };
    };
    expect(stableResult(refused.response)).toEqual(stableResult(baseline.response));
    expect(refused.payload?.conflicts).toEqual(baseline.payload?.conflicts);
    expect(refused.payload?.structured_merge_refusals).toEqual([
      { path: "file.txt", driver: "test", reason: "unsupported" },
    ]);
    expect(baseline.payload?.structured_merge_refusals).toBeUndefined();
  });

  // Measured (T1529): idle 1770 ms, 3x load 3781 ms; budget 7x.
  it("persists conflict data and its event while applying none of the operations", async () => {
    const f = await fixture();
    await f.apply([{ type: "create", path: "file", content: "old\n" }]);
    const headApply = await f.apply([{ type: "modify", path: "file", content: "head\n" }], 1);
    const headChangesetId = (headApply.response as { changeset_id: string }).changeset_id;
    const head = await f.head();
    const input = f.request(
      [
        { type: "modify", path: "file", content: "candidate\n" },
        { type: "create", path: "otherwise-clean", content: "x" },
      ],
      1,
    );
    const result = await f.dispatch(input);
    expect(result.response).toMatchObject({
      status: "CONFLICT",
      conflict_id: expect.stringMatching(/^conf_/),
      conflicts: [{ path: "file", kind: "CONTENT" }],
      counterparty_changesets: [headChangesetId],
    });
    expect(result.events).toMatchObject([
      {
        type: "workspace.conflict.created",
        payload: {
          conflict_id: (result.response as { conflict_id: string }).conflict_id,
          changeset_id: (result.response as { changeset_id: string }).changeset_id,
          submitter_id: f.actor,
          file_count: 1,
          kinds: ["CONTENT"],
          counterparty_count: 1,
        },
      },
    ]);
    const conflictPayload = (await f.rowsFor("changesets")).find(
      (row) => row.status === "CONFLICT",
    )?.payload;
    expect(conflictPayload?.conflicts).toMatchObject([{ path: "file", kind: "CONTENT" }]);
    expect(conflictPayload?.counterparty_changesets).toEqual([headChangesetId]);
    expect(await f.rowsFor("conflicts")).toMatchObject([
      {
        id: (result.response as { conflict_id: string }).conflict_id,
        changeset_id: (result.response as { changeset_id: string }).changeset_id,
        status: "OPEN",
        base_revision: "1",
        head_revision_at_detection: "2",
        files: [{ path: "file", kind: "CONTENT" }],
        counterparty_changesets: [headChangesetId],
      },
    ]);
    expect(await f.rowsFor("workspace_revisions")).toHaveLength(3);
    expect((await f.rowsFor("file_revisions")).some((row) => row.path === "otherwise-clean")).toBe(
      false,
    );
    expect(await f.head()).toBe(head);
    expect(await f.dispatch({ ...input, id: newId("cmd") })).toEqual({ ...result, replayed: true });
    expect(await f.rowsFor("events")).toHaveLength(3);
  }, 30_000);

  // Measured (T1529): idle 1533 ms, 3x load 5024 ms; budget 7x.
  it("records only applied changesets between base and head that touched conflict paths", async () => {
    const f = await fixture();
    await f.apply([{ type: "create", path: "file", content: "base\n" }]);
    const unrelated = await f.apply([{ type: "create", path: "other", content: "unrelated" }], 1);
    const counterparty = await f.apply([{ type: "modify", path: "file", content: "head\n" }], 2);
    const unrelatedId = (unrelated.response as { changeset_id: string }).changeset_id;
    const counterpartyId = (counterparty.response as { changeset_id: string }).changeset_id;
    const result = await f.apply([{ type: "modify", path: "file", content: "candidate\n" }], 1);
    expect(result.response).toMatchObject({
      status: "CONFLICT",
      counterparty_changesets: [counterpartyId],
    });
    const row = (await f.rowsFor("conflicts"))[0];
    expect(row).toMatchObject({
      counterparty_changesets: [counterpartyId],
      head_revision_at_detection: "3",
    });
    expect(row.counterparty_changesets).not.toContain(unrelatedId);
  }, 40_000);

  // Measured (T1529): idle 1356 ms, 3x load 5055 ms; budget 7x.
  it("records rename/deletion history and per-path revisions", async () => {
    const f = await fixture();
    await f.apply([{ type: "create", path: "old", content: "one" }]);
    await f.apply([{ type: "modify", path: "old", content: "two" }], 1);
    await f.apply([{ type: "rename", from: "old", to: "new" }], 2);
    const rows = await f.rowsFor("file_revisions");
    expect(
      rows
        .filter((row) => row.path === "old")
        .map((row) => row.revision)
        .sort(),
    ).toEqual(["1", "2", "3"]);
    expect(rows.find((row) => row.path === "old" && row.revision === "3")?.blob_sha).toBeNull();
    expect(rows.find((row) => row.path === "new")).toMatchObject({
      revision: "1",
      workspace_revision: "3",
    });
  }, 40_000);

  // Measured (T1529): idle 711 ms, 3x load 2363 ms; budget 7x.
  it("authorizes both normalized rename paths and rolls back a denial", async () => {
    const paths: string[] = [];
    const f = await fixture(async (_principal, _action, resource) => {
      if (resource.path) paths.push(resource.path as string);
      if (resource.path === "denied") throw new CrossoverError("FORBIDDEN", "Denied path");
    });
    await f.apply([{ type: "create", path: "old", content: "x" }]);
    const head = await f.head();
    await expect(
      f.apply([{ type: "rename", from: "./old", to: "./denied" }], 1),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(paths).toEqual(["old", "old", "denied"]);
    expect(await f.rowsFor("changesets")).toHaveLength(1);
    // The first apply's event, plus the denial (T215), but nothing from the denied apply.
    expect((await f.rowsFor("events")).map((e) => e.type)).toEqual([
      "workspace.changeset.applied",
      "capability.denied",
    ]);
    expect(await f.head()).toBe(head);
  }, 20_000);

  it("rolls back pending payload on validation failure", async () => {
    const f = await fixture();
    const head = await f.head();
    await expect(f.apply([{ type: "delete", path: "missing" }])).rejects.toMatchObject({
      code: "VALIDATION",
    });
    expect(await f.rowsFor("changesets")).toEqual([]);
    expect(await f.rowsFor("file_revisions")).toEqual([]);
    expect(await f.rowsFor("events")).toEqual([]);
    expect(await f.head()).toBe(head);
  });

  it("returns VALIDATION for either ChangeSet limit before persisting state or events", async () => {
    const f = await fixture();
    const head = await f.head();
    for (const operations of [
      Array.from({ length: 501 }, (_, index) => ({
        type: "create" as const,
        path: `file${index}`,
        content: "x",
      })),
      [{ type: "create" as const, path: "large", content: "x".repeat(25 * 1024 * 1024 + 1) }],
    ])
      await expect(f.apply(operations)).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await f.rowsFor("changesets")).toEqual([]);
    expect(await f.rowsFor("file_revisions")).toEqual([]);
    expect(await f.rowsFor("events")).toEqual([]);
    expect(await f.rowsFor("workspace_revisions")).toHaveLength(1);
    expect(await f.head()).toBe(head);
  });

  // Measured (T1529): idle 1535 ms, 3x load 4509 ms; budget 7x.
  it("authorizes an implicit destination when Git carries a stale edit through a head rename", async () => {
    let deny = false;
    const f = await fixture(async (_principal, _action, resource) => {
      if (deny && resource.path === "denied")
        throw new CrossoverError("FORBIDDEN", "Denied destination");
    });
    await f.apply([{ type: "create", path: "old", content: "one\ntwo\nthree\n" }]);
    await f.apply([{ type: "rename", from: "old", to: "denied" }], 1);
    const head = await f.head();
    deny = true;
    await expect(
      f.apply([{ type: "modify", path: "old", content: "one\nEDIT\nthree\n" }], 1),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await f.rowsFor("changesets")).toHaveLength(2);
    expect(await f.head()).toBe(head);
  }, 35_000);

  // Measured (T1529): idle 1120 ms, 3x load 2340 ms; budget 7x.
  it("serializes racing applications from the same base and preserves both edits", async () => {
    const f = await fixture();
    const results = await Promise.all(
      ["one", "two"].map((path) => f.apply([{ type: "create", path, content: path }])),
    );
    expect(
      results.map((r) => (r.response as { applied_revision: number }).applied_revision),
    ).toEqual([1, 2]);
    const head = await f.head();
    for (const path of ["one", "two"])
      expect((await git(["show", `${head}:${path}`], f.options)).stdout).toBe(path);
    expect(await f.rowsFor("workspace_revisions")).toHaveLength(3);
    expect(await f.rowsFor("events")).toHaveLength(2);
  }, 20_000);

  it("keeps canonical unchanged when event append fails after writing Git objects and state", async () => {
    const f = await fixture();
    const head = await f.head();
    await db.pool.query(
      "ALTER TABLE events ADD CONSTRAINT reject_apply CHECK (type <> 'workspace.changeset.applied') NOT VALID",
    );
    try {
      await expect(f.apply([{ type: "create", path: "file", content: "x" }])).rejects.toThrow();
      expect(await f.rowsFor("changesets")).toEqual([]);
      expect(await f.rowsFor("workspace_revisions")).toHaveLength(1);
      expect(await f.rowsFor("file_revisions")).toEqual([]);
      expect(await f.rowsFor("events")).toEqual([]);
      expect(await f.head()).toBe(head);
    } finally {
      await db.pool.query("ALTER TABLE events DROP CONSTRAINT reject_apply");
    }
  });
});

describe("workspace.apply_changeset — secret scanning (T901)", () => {
  // A realistic AWS key that is NOT a documented example (the docs key
  // AKIAIOSFODNN7EXAMPLE is allowlisted and must not match).
  const AWS_KEY = "AKIA1234567890ABCDEF";
  const HIGH_ENTROPY = "aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW";
  const GITHUB_TOKEN = `ghp_${"x".repeat(36)}`;

  it("blocks a high-confidence secret with VALIDATION naming file and line", async () => {
    const f = await fixture();
    await expect(
      f.apply([{ type: "create", path: "config.env", content: `AWS_KEY=${AWS_KEY}\n` }]),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      details: {
        reason: "secret_detected",
        findings: [
          expect.objectContaining({
            rule: "aws_access_key_id",
            path: "config.env",
            line: 1,
          }),
        ],
      },
    });
    // Nothing persisted: no ChangeSet, no new revision, no file.
    expect(await f.rowsFor("changesets")).toEqual([]);
    expect(await f.rowsFor("workspace_revisions")).toHaveLength(1);
    expect(await f.rowsFor("file_revisions")).toEqual([]);
  });

  it("applies a low-confidence secret and flags the author and owner via inbox", async () => {
    const f = await fixture();
    const owner = newId("part");
    await f.addParticipant(owner);
    await db.pool.query("UPDATE participants SET authority = 'OWNER' WHERE id = $1", [owner]);
    await db.pool.query("UPDATE rooms SET owner_id = $2 WHERE id = $1", [f.room, owner]);

    const response = await f.apply([
      { type: "create", path: "config.ts", content: `api_key = "${HIGH_ENTROPY}"\n` },
    ]);
    expect(response.response).toMatchObject({ status: "APPLIED" });

    const { rows: inbox } = await db.pool.query(
      "SELECT participant_id, kind, ref, summary, author_id FROM inbox_items WHERE room_id = $1",
      [f.room],
    );
    // Flagged to both the author and the owner.
    expect(inbox.map((r) => r.participant_id).sort()).toEqual([f.actor, owner].sort());
    for (const item of inbox) {
      expect(item.kind).toBe("SECRET_SCAN");
      expect(item.ref).toEqual({ kind: "changeset", id: expect.any(String) });
      expect(item.author_id).toBe("system");
      // The summary names the file and line, never the value.
      expect(item.summary).toContain("config.ts:1");
      expect(item.summary).not.toContain(HIGH_ENTROPY);
    }
    const notifications = response.events.filter((event) => event.type === "inbox.delivered");
    expect(notifications.map((event) => event.payload["recipient_id"]).sort()).toEqual(
      [f.actor, owner].sort(),
    );
    expect(notifications.every((event) => event.payload["kind"] === "SECRET_SCAN")).toBe(true);
  });

  it("sends a single inbox item when the author is the room owner", async () => {
    const f = await fixture(); // in the fixture the room owner IS the actor
    await f.apply([{ type: "create", path: "config.ts", content: `token: ${HIGH_ENTROPY}\n` }]);
    const { rows: inbox } = await db.pool.query(
      "SELECT participant_id, kind FROM inbox_items WHERE room_id = $1",
      [f.room],
    );
    expect(inbox).toEqual([{ participant_id: f.actor, kind: "SECRET_SCAN" }]);
  });

  it("does not flag a clean ChangeSet", async () => {
    const f = await fixture();
    await f.apply([{ type: "create", path: "readme.md", content: "# Hello\n" }]);
    const { rows: inbox } = await db.pool.query("SELECT * FROM inbox_items WHERE room_id = $1", [
      f.room,
    ]);
    expect(inbox).toEqual([]);
  });

  it("scans base64 content and a real unified-diff patch", async () => {
    const f = await fixture();
    // base64-encoded content containing an AWS key
    const b64 = Buffer.from(`AWS_KEY=${AWS_KEY}\n`).toString("base64");
    await expect(
      f.apply([{ type: "create", path: "bin.dat", content: b64, encoding: "base64" }]),
    ).rejects.toMatchObject({ code: "VALIDATION" });

    // a real unified diff that adds a GitHub token on new-file line 2
    await f.apply([{ type: "create", path: "a.txt", content: "start\n" }]);
    const patch = [
      `--- a/a.txt`,
      `+++ b/a.txt`,
      `@@ -1 +1,2 @@`,
      ` start`,
      `+${GITHUB_TOKEN}`,
      "",
    ].join("\n");
    await expect(f.apply([{ type: "modify", path: "a.txt", patch }], 1)).rejects.toMatchObject({
      code: "VALIDATION",
      details: { findings: [expect.objectContaining({ rule: "github_token", line: 2 })] },
    });
  });

  it("does not block a patch that removes a secret", async () => {
    const f = await fixture();
    // Set up a file that already contains a secret via an upstream pull (which
    // the scanner flags but never blocks).
    await f.applyDirect(
      [{ type: "create", path: "leak.txt", content: `aws = ${AWS_KEY}\nother = line\n` }],
      0,
      { actorId: UPSTREAM_ACTOR },
    );
    // A patch that deletes the secret line: no `+` lines, so nothing is flagged.
    const patch = [
      "--- a/leak.txt",
      "+++ b/leak.txt",
      "@@ -1,2 +1,1 @@",
      `-aws = ${AWS_KEY}`,
      " other = line",
      "",
    ].join("\n");
    const response = await f.apply([{ type: "modify", path: "leak.txt", patch }], 1);
    expect(response.response).toMatchObject({ status: "APPLIED" });
  });

  it("does not block an edit that leaves a pre-existing secret untouched", async () => {
    const f = await fixture();
    // Set up a file with a pre-existing secret (line 1) via an upstream pull.
    await f.applyDirect(
      [{ type: "create", path: "legacy.txt", content: `old = ${AWS_KEY}\nline2 = x\nline3 = y\n` }],
      0,
      { actorId: UPSTREAM_ACTOR },
    );
    // A full-content modify that changes only line 3; the secret (line 1) is
    // unchanged, so it is not in the added lines and does not wedge the edit.
    const response = await f.apply(
      [
        {
          type: "modify",
          path: "legacy.txt",
          content: `old = ${AWS_KEY}\nline2 = x\nline3 = changed\n`,
        },
      ],
      1,
    );
    expect(response.response).toMatchObject({ status: "APPLIED" });
  });

  // Measured (T1529): idle 1314 ms, 3x load 2876 ms; budget 7x.
  it("does not block an edit to a non-ASCII (café.ts) file that leaves a pre-existing secret untouched", async () => {
    // Sabotage for the ls-tree regression: an intermediate `git ls-tree` C-quotes
    // non-ASCII paths ("src/caf\303\251.ts"), so the base lookup misses, every
    // line counts as added, and a pre-existing secret gets rejected as
    // secret_detected. Feeding `<commit>:<path>` straight to `cat-file --batch`
    // avoids the C-quoting, so the base is read and the edit applies.
    const f = await fixture();
    await f.applyDirect(
      [
        {
          type: "create",
          path: "src/café.ts",
          content: `old = ${AWS_KEY}\nline2 = x\nline3 = y\n`,
        },
      ],
      0,
      { actorId: UPSTREAM_ACTOR },
    );
    const response = await f.apply(
      [
        {
          type: "modify",
          path: "src/café.ts",
          content: `old = ${AWS_KEY}\nline2 = x\nline3 = changed\n`,
        },
      ],
      1,
    );
    expect(response.response).toMatchObject({ status: "APPLIED" });
  }, 25_000);

  // Measured (T1529): idle 912 ms, 3x load 2303 ms; budget 7x.
  it("rejects a ChangeSet whose newline path desyncs the base batch (scanner bypass)", async () => {
    // A path may contain a newline (normalizePath rejects only NUL). cat-file
    // --batch reads one ref per line, so a newline path splits into two refs
    // and shifts every later file's base. Repro: target.txt is diffed against
    // vendor.txt's content, so an added AWS key counts as unchanged and the
    // ChangeSet is (wrongly) APPLIED. The fix leaves newline paths out of the
    // batch (base "", scanned whole), so target.txt keeps its real base and the
    // key is an added line → REJECTED.
    const f = await fixture();
    // 1. Upstream brings in vendor.txt (with the key) and target.txt (without).
    await f.applyDirect(
      [
        { type: "create", path: "vendor.txt", content: `k = ${AWS_KEY}\n` },
        { type: "create", path: "target.txt", content: "a\n" },
      ],
      0,
      { actorId: UPSTREAM_ACTOR },
    );
    // The rev-1 SHA is visible to any reader through workspace.history.
    const revs = await f.rowsFor("workspace_revisions");
    const rev1 = revs.find((r) => Number(r.revision) === 1)!.commit_sha as string;
    // 2. Upstream brings in a file whose name contains a newline; the second
    //    half is "<rev-1 sha>:vendor.txt", a valid ref to vendor.txt's content.
    const newlinePath = `x\n${rev1}:vendor.txt`;
    await f.applyDirect([{ type: "create", path: newlinePath, content: "n\n" }], 1, {
      actorId: UPSTREAM_ACTOR,
    });
    // 3. One ChangeSet modifies the newline file and adds the key to target.txt.
    await expect(
      f.apply(
        [
          { type: "modify", path: newlinePath, content: "n2\n" },
          { type: "modify", path: "target.txt", content: `k = ${AWS_KEY}\n` },
        ],
        2,
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      details: { reason: "secret_detected" },
    });
  }, 20_000);

  it("flags an upstream pull's secrets without blocking or crashing", async () => {
    const f = await fixture();
    const owner = newId("part");
    await f.addParticipant(owner);
    await db.pool.query("UPDATE participants SET authority = 'OWNER' WHERE id = $1", [owner]);
    await db.pool.query("UPDATE rooms SET owner_id = $2 WHERE id = $1", [f.room, owner]);

    // A high-confidence secret in an upstream pull: never blocked (the room
    // doesn't control upstream content), and flagged to the owner and the caller
    // — never to system:upstream, which is not a participant (the old code's FK crash).
    const response = await f.applyDirect(
      [{ type: "create", path: "upstream.txt", content: `key = ${AWS_KEY}\n` }],
      0,
      { actorId: UPSTREAM_ACTOR },
    );
    expect(response.response).toMatchObject({ status: "APPLIED" });

    const { rows: inbox } = await db.pool.query(
      "SELECT participant_id, kind, summary FROM inbox_items WHERE room_id = $1",
      [f.room],
    );
    expect(inbox.map((r) => r.participant_id).sort()).toEqual([f.actor, owner].sort());
    for (const item of inbox) {
      expect(item.kind).toBe("SECRET_SCAN");
      expect(item.summary).toContain("upstream.txt:1");
      expect(item.summary).not.toContain(AWS_KEY);
    }
  });

  it("never leaks the matched value in a VALIDATION error", async () => {
    const f = await fixture();
    const secret = AWS_KEY;
    try {
      await f.apply([{ type: "create", path: "c.env", content: `K=${secret}\n` }]);
      throw new Error("expected VALIDATION");
    } catch (e) {
      expect(e).toBeInstanceOf(CrossoverError);
      expect((e as CrossoverError).code).toBe("VALIDATION");
      expect(JSON.stringify((e as CrossoverError).details ?? {})).not.toContain(secret);
    }
  });

  it("never leaks the matched value in emitted events", async () => {
    const f = await fixture();
    const owner = newId("part");
    await f.addParticipant(owner);
    await db.pool.query("UPDATE participants SET authority = 'OWNER' WHERE id = $1", [owner]);
    await db.pool.query("UPDATE rooms SET owner_id = $2 WHERE id = $1", [f.room, owner]);
    const secret = HIGH_ENTROPY;
    await f.apply([{ type: "create", path: "c.ts", content: `api_key = "${secret}"\n` }]);
    const { rows: events } = await db.pool.query(
      "SELECT actor_id, type, payload FROM events WHERE room_id = $1",
      [f.room],
    );
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(
        JSON.stringify({ actor_id: event.actor_id, type: event.type, payload: event.payload }),
      ).not.toContain(secret);
    }
  });

  it("scans an added line that starts with ++ (not mistaken for a file header)", async () => {
    const f = await fixture();
    // Set up a file via an upstream pull so the initial content isn't blocked.
    await f.applyDirect([{ type: "create", path: "inc.txt", content: "line1\n" }], 0, {
      actorId: UPSTREAM_ACTOR,
    });
    const { rows: revRows } = await db.pool.query(
      "SELECT MAX(revision)::int AS rev FROM workspace_revisions WHERE room_id = $1",
      [f.room],
    );
    const rev = revRows[0].rev;
    // A patch whose added line's content itself starts with `++`. Before the
    // hunk-state fix, `+++…` was skipped as a file header and the secret
    // escaped the scan.
    const patch = [
      "--- a/inc.txt",
      "+++ b/inc.txt",
      "@@ -1 +1,2 @@",
      " line1",
      `+++${AWS_KEY}`,
      "",
    ].join("\n");
    await expect(
      f.applyDirect([{ type: "modify", path: "inc.txt", patch }], rev, {}),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      details: {
        findings: [expect.objectContaining({ path: "inc.txt" })],
      },
    });
  });

  it("surfaces scan_skipped in the inbox for a file too large to scan", async () => {
    const f = await fixture();
    const big = "x".repeat(5 * 1024 * 1024 + 1);
    await f.applyDirect([{ type: "create", path: "big.txt", content: big }], 0, {});
    const { rows } = await db.pool.query(
      "SELECT summary FROM inbox_items WHERE room_id = $1 AND kind = 'SECRET_SCAN'",
      [f.room],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].summary).toContain("too large to scan");
  });

  // Measured (T1529): idle 3684 ms, 3x load 5857 ms; budget 7x.
  it("bounds the total bytes scanned at 8 MiB across a ChangeSet", async () => {
    const f = await fixture();
    // Five files just under the 2 MiB per-file bound; together they exceed the
    // 8 MiB total budget, so the fifth is scan_skipped rather than scanned.
    const size = 2 * 1024 * 1024 - 1;
    const ops = Array.from({ length: 5 }, (_, i) => ({
      type: "create" as const,
      path: `f${i}.txt`,
      content: "x".repeat(size),
    }));
    const start = Date.now();
    await f.applyDirect(ops, 0, {});
    const ms = Date.now() - start;
    expect(ms).toBeLessThan(5000);
    const { rows } = await db.pool.query(
      "SELECT summary FROM inbox_items WHERE room_id = $1 AND kind = 'SECRET_SCAN'",
      [f.room],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].summary).toContain("too large to scan");
  }, 45_000);
});

describe("circuit breakers", () => {
  const addLead = async (f: Awaited<ReturnType<typeof fixture>>) => {
    const leadId = newId("part");
    await f.addParticipant(leadId);
    await db.pool.query("UPDATE participants SET role = 'LEAD' WHERE id = $1 AND room_id = $2", [
      leadId,
      f.room,
    ]);
    await db.pool.query("UPDATE rooms SET lead_participant_id = $2 WHERE id = $1", [
      f.room,
      leadId,
    ]);
    return { id: leadId, dispatch: f.dispatchAs(leadId, "LEAD") };
  };

  const decide = (
    dispatch: (input: Parameters<Dispatcher["dispatch"]>[1]) => ReturnType<Dispatcher["dispatch"]>,
    changesetId: string,
    decision: "APPROVE" | "REJECT",
  ) =>
    dispatch({
      id: newId("cmd"),
      method: "workspace.changeset.decide_hold",
      idempotency_key: newId("cmd"),
      params: { changeset_id: changesetId, decision },
    });

  const heldId = async (
    dispatch: (input: Parameters<Dispatcher["dispatch"]>[1]) => ReturnType<Dispatcher["dispatch"]>,
    input: ReturnType<Awaited<ReturnType<typeof fixture>>["request"]>,
    reason: string,
  ) => {
    const error = await dispatch(input).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CrossoverError);
    expect((error as CrossoverError).code).toBe("CIRCUIT_BREAKER");
    expect((error as CrossoverError).details?.reasons).toContain(reason);
    return String((error as CrossoverError).details?.changeset_id);
  };

  it("holds more than 50 deleted files and commits the hold, inbox, and event with an idempotent error", async () => {
    const f = await fixture();
    const lead = await addLead(f);
    const files = Array.from({ length: 51 }, (_, i) => ({
      type: "create" as const,
      path: `delete/file-${i}.txt`,
      content: "line\n",
    }));
    await f.apply(files);
    const agentId = newId("part");
    await f.addParticipant(agentId, "AGENT");
    const dispatchAgent = f.dispatchAs(agentId, "DEVELOPER", "AGENT");
    const input = f.request(
      files.map(({ path }) => ({ type: "delete" as const, path })),
      1,
    );

    const id = await heldId(dispatchAgent, input, "mass_delete");
    const replay = await dispatchAgent(input).catch((error: unknown) => error);
    expect(replay).toBeInstanceOf(CrossoverError);
    expect((replay as CrossoverError).code).toBe("CIRCUIT_BREAKER");
    expect((replay as CrossoverError).details?.changeset_id).toBe(id);
    expect((replay as CrossoverError).details?.reasons).not.toContain("lines_removed");
    expect((await f.rowsFor("changesets")).find((row) => row.id === id)?.status).toBe("HELD");
    expect((await f.rowsFor("workspace_revisions")).length).toBe(2);
    const inbox = await db.pool.query(
      "SELECT participant_id FROM inbox_items WHERE room_id = $1 AND ref->>'id' = $2",
      [f.room, id],
    );
    expect(inbox.rows.map((row) => row.participant_id).sort()).toEqual([f.actor, lead.id].sort());
    const events = await f.rowsFor("events");
    expect(events.map((row) => row.type)).toContain("workspace.changeset.held");
  });

  it("holds removal of more than 30% of at least 200 base text lines", async () => {
    const f = await fixture();
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i}`);
    const content = lines.join("\n") + "\n";
    await f.apply([
      { type: "create", path: "src/large.txt", content },
      {
        type: "create",
        path: "src/binary.bin",
        content: Buffer.alloc(10_000).toString("base64"),
        encoding: "base64",
      },
    ]);
    const error = await f
      .dispatch(
        f.request(
          [{ type: "modify", path: "src/large.txt", content: lines.slice(100).join("\n") + "\n" }],
          1,
        ),
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CrossoverError);
    expect((error as CrossoverError).details?.reasons).toContain("lines_removed");
  });

  it("holds protected paths and returns only readable protected paths", async () => {
    const f = await fixture();
    const agentId = newId("part");
    await f.addParticipant(agentId, "AGENT");
    const dispatchAgent = f.dispatchAs(agentId, "DEVELOPER", "AGENT");
    const input = f.request(
      [{ type: "create", path: ".github/workflows/release.yml", content: "name: release\n" }],
      0,
    );
    const id = await heldId(dispatchAgent, input, "protected_path");
    const error = await dispatchAgent(input).catch((caught: unknown) => caught);
    expect((error as CrossoverError).details?.paths).toEqual([".github/workflows/release.yml"]);
    expect((await f.rowsFor("changesets")).find((row) => row.id === id)?.status).toBe("HELD");
  });

  it("omits a protected path from the error when the submitter cannot read it", async () => {
    let submitterId = "";
    const authorizer: Authorizer = async (principal, action, resource, context) => {
      if (principal.participant_id === submitterId && action === "workspace.read" && resource.path)
        throw new CrossoverError("FORBIDDEN", "Path is private");
      return allowAll(principal, action, resource, context);
    };
    const f = await fixture(authorizer);
    submitterId = newId("part");
    await f.addParticipant(submitterId, "AGENT");
    const input = f.request(
      [{ type: "create", path: ".github/workflows/private.yml", content: "name: private\n" }],
      0,
    );
    const dispatchAgent = f.dispatchAs(submitterId, "DEVELOPER", "AGENT");
    await heldId(dispatchAgent, input, "protected_path");
    const error = await dispatchAgent(input).catch((caught: unknown) => caught);
    expect((error as CrossoverError).details?.paths).toBeUndefined();
  });

  it("applies an approved hold as the original submitter, then rejects a duplicate decision", async () => {
    const f = await fixture();
    const lead = await addLead(f);
    const agentId = newId("part");
    await f.addParticipant(agentId, "AGENT");
    const dispatchAgent = f.dispatchAs(agentId, "DEVELOPER", "AGENT");
    const input = f.request(
      [{ type: "create", path: ".github/workflows/release.yml", content: "name: release\n" }],
      0,
    );
    const id = await heldId(dispatchAgent, input, "protected_path");

    const approved = await decide(lead.dispatch, id, "APPROVE");
    expect(approved.response).toMatchObject({ status: "APPLIED", changeset_id: id });
    expect((await f.rowsFor("changesets")).find((row) => row.id === id)?.status).toBe("APPLIED");
    expect((await f.rowsFor("events")).map((row) => row.type)).toContain(
      "workspace.changeset.hold_decided",
    );
    const replay = await dispatchAgent(input).catch((error: unknown) => error);
    expect(replay).toBeInstanceOf(CrossoverError);
    expect((replay as CrossoverError).code).toBe("CIRCUIT_BREAKER");
    expect((replay as CrossoverError).details?.changeset_id).toBe(id);
    await expect(decide(lead.dispatch, id, "REJECT")).rejects.toMatchObject({
      code: "CONFLICT_VERSION",
    });
  });

  it("sends an approved stale hold through merge and assigns its conflict to the submitter", async () => {
    const f = await fixture();
    const lead = await addLead(f);
    const agentId = newId("part");
    await f.addParticipant(agentId, "AGENT");
    await db.pool.query("UPDATE rooms SET settings = $2::jsonb WHERE id = $1", [
      f.room,
      JSON.stringify({ protected_paths: [] }),
    ]);
    await f.apply([
      { type: "create", path: ".github/workflows/release.yml", content: "name: base\n" },
    ]);
    await db.pool.query("UPDATE rooms SET settings = $2::jsonb WHERE id = $1", [
      f.room,
      JSON.stringify({ protected_paths: [".github/workflows/**"] }),
    ]);
    const dispatchAgent = f.dispatchAs(agentId, "DEVELOPER", "AGENT");
    const input = f.request(
      [{ type: "modify", path: ".github/workflows/release.yml", content: "name: agent\n" }],
      1,
    );
    const id = await heldId(dispatchAgent, input, "protected_path");
    await db.pool.query("UPDATE rooms SET settings = $2::jsonb WHERE id = $1", [
      f.room,
      JSON.stringify({ protected_paths: [] }),
    ]);
    await f.apply(
      [{ type: "modify", path: ".github/workflows/release.yml", content: "name: head\n" }],
      1,
    );

    const approved = await decide(lead.dispatch, id, "APPROVE");
    expect(approved.response).toMatchObject({ status: "CONFLICT", changeset_id: id });
    const conflict = await db.pool.query(
      "SELECT submitter_id FROM conflicts WHERE room_id = $1 AND changeset_id = $2",
      [f.room, id],
    );
    expect(conflict.rows[0]?.submitter_id).toBe(agentId);
  });

  it("rechecks the original submitter's current path grant when approving", async () => {
    let revoked = false;
    let submitterId = "";
    const authorizer: Authorizer = async (principal, action, resource, context) => {
      if (revoked && principal.participant_id === submitterId && action === "workspace.write")
        throw new CrossoverError("FORBIDDEN", "Path grant was revoked");
      return allowAll(principal, action, resource, context);
    };
    const f = await fixture(authorizer);
    const lead = await addLead(f);
    submitterId = newId("part");
    await f.addParticipant(submitterId, "AGENT");
    const dispatchAgent = f.dispatchAs(submitterId, "DEVELOPER", "AGENT");
    const input = f.request(
      [{ type: "create", path: ".github/workflows/release.yml", content: "name: release\n" }],
      0,
    );
    const id = await heldId(dispatchAgent, input, "protected_path");
    revoked = true;

    await expect(decide(lead.dispatch, id, "APPROVE")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await f.rowsFor("changesets")).find((row) => row.id === id)?.status).toBe("HELD");
  });

  it("counts recent hold rejections toward the agent streak", async () => {
    const f = await fixture();
    const lead = await addLead(f);
    const agentId = newId("part");
    await f.addParticipant(agentId, "AGENT");
    const dispatchAgent = f.dispatchAs(agentId, "DEVELOPER", "AGENT");
    for (let index = 0; index < 6; index += 1) {
      const input = f.request(
        [
          {
            type: "create",
            path: `.github/workflows/rejected-${index}.yml`,
            content: "name: held\n",
          },
        ],
        0,
      );
      const id = await heldId(dispatchAgent, input, "protected_path");
      await decide(lead.dispatch, id, "REJECT");
    }
    const seventh = f.request(
      [{ type: "create", path: "docs/after-streak.txt", content: "still held\n" }],
      0,
    );
    await heldId(dispatchAgent, seventh, "rejection_streak");
  });

  it("refuses hold decisions from non-leads", async () => {
    const f = await fixture();
    const input = f.request(
      [{ type: "create", path: ".github/workflows/release.yml", content: "name: release\n" }],
      0,
    );
    const id = await heldId(f.dispatch, input, "protected_path");
    await expect(decide(f.dispatch, id, "APPROVE")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await f.rowsFor("changesets")).find((row) => row.id === id)?.status).toBe("HELD");
  });
});
