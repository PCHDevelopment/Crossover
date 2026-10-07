import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withTransaction } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { allowAll, Dispatcher, type Authorizer } from "@crossover/kernel";
import { CrossoverError, newId } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { git } from "./git.js";
import { registerWorkspaceCommands, type WorkspaceCommandDeps } from "./apply.js";
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
  registerWorkspaceCommands(dispatcher, deps);
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
    rowsFor,
    dispatcher,
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
  });

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
  });

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
    ]);
    expect((await f.rowsFor("conflicts"))[0]).toMatchObject({ status: "ESCALATED", attempts: 2 });
    const { rows } = await db.pool.query(
      "SELECT participant_id FROM inbox_items WHERE room_id = $1",
      [f.room],
    );
    expect(rows).toEqual([{ participant_id: lead }]);
  });

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
    expect((await f.rowsFor("events")).at(-1)).toMatchObject({
      type: "workspace.conflict.escalated",
      actor_id: "system",
      payload: { conflict_id: conflictId, escalated_to: lead, trigger: "timeout" },
    });
    const { rows } = await db.pool.query(
      "SELECT participant_id FROM inbox_items WHERE room_id = $1",
      [f.room],
    );
    expect(rows).toEqual([{ participant_id: lead }]);
  });

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
  });

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
  });

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
  });

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
  });

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
  });

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
  });

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
  });

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
  });

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
  });

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
  });

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
  });

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
