import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { newId } from "@crossover/protocol";
import { git } from "./git.js";
import {
  ExecutionService,
  type ExecutionDriver,
  type SandboxExecOutcome,
  type SandboxExecProcess,
  type SandboxExecTermination,
  type SandboxLimits,
  type SandboxResources,
} from "./execution.js";

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db?.drop();
});

class FakeExecutionDriver implements ExecutionDriver {
  readonly created: string[] = [];
  readonly createCalls: string[] = [];
  readonly started: string[] = [];
  readonly stopped: string[] = [];
  readonly destroyCalls: string[] = [];
  readonly destroyed: SandboxResources[] = [];
  readonly limits: SandboxLimits[] = [];
  readonly provisioned = new Map<string, SandboxResources>();
  readonly running = new Set<string>();
  readonly statusCalls: string[] = [];
  snapshotEntries: { path: string; mode: string; sha: string | null; size: number }[] = [];
  readonly snapshotUpdates: Array<{
    files: readonly { path: string; mode: string; content: Buffer }[];
    delete_paths: readonly string[];
  }> = [];
  private snapshotObjectFormat: "sha1" | "sha256" = "sha1";
  readonly execCancellations: SandboxExecTermination[] = [];
  readonly execStarted: string[] = [];
  changes = {
    modified: [] as string[],
    added: [] as string[],
    deleted: [] as string[],
    truncated: false,
  };
  failCreateAfterProvision = false;
  failDestroyOnce = false;
  stopGate: { entered: Deferred; release: Deferred } | undefined;

  async create(input: { sandbox_id: string; limits: SandboxLimits }): Promise<SandboxResources> {
    this.createCalls.push(input.sandbox_id);
    let resources = this.provisioned.get(input.sandbox_id);
    if (!resources) {
      resources = {
        volume_ref: `volume:${input.sandbox_id}`,
        container_ref: `container:${input.sandbox_id}`,
      };
      this.provisioned.set(input.sandbox_id, resources);
      this.created.push(input.sandbox_id);
      this.limits.push(input.limits);
    }
    if (this.failCreateAfterProvision) {
      this.failCreateAfterProvision = false;
      throw new Error("injected Docker create failure after provisioning");
    }
    return resources;
  }

  async start(input: { sandbox_id: string; resources: SandboxResources }): Promise<void> {
    this.started.push(input.sandbox_id);
    this.running.add(input.sandbox_id);
  }

  async cpuUsage(): Promise<{ usage_usec: bigint; generation: string }> {
    return { usage_usec: 0n, generation: "fake-container-start" };
  }

  async stop(input: { sandbox_id: string; resources: SandboxResources }): Promise<void> {
    this.stopped.push(input.sandbox_id);
    if (this.stopGate) {
      this.stopGate.entered.resolve();
      await this.stopGate.release.promise;
    }
    this.running.delete(input.sandbox_id);
  }

  async restart(input: { sandbox_id: string; resources: SandboxResources }): Promise<void> {
    this.stopped.push(input.sandbox_id);
  }

  async destroy(input: { sandbox_id: string; resources?: SandboxResources }): Promise<void> {
    this.destroyCalls.push(input.sandbox_id);
    const resources = this.provisioned.get(input.sandbox_id);
    if (resources) this.destroyed.push(resources);
    this.provisioned.delete(input.sandbox_id);
    this.running.delete(input.sandbox_id);
    if (this.failDestroyOnce) {
      this.failDestroyOnce = false;
      throw new Error("injected Docker destroy failure after removal");
    }
  }

  async status(input: { sandbox_id: string; resources: SandboxResources }) {
    this.statusCalls.push(input.sandbox_id);
    return this.changes;
  }

  async snapshotInventory(input: Parameters<NonNullable<ExecutionDriver["snapshotInventory"]>>[0]) {
    this.snapshotObjectFormat = input.object_format;
    return this.snapshotEntries;
  }

  async updateSnapshot(input: Parameters<NonNullable<ExecutionDriver["updateSnapshot"]>>[0]) {
    this.snapshotUpdates.push(input);
    const removed = new Set(input.delete_paths);
    const entries = this.snapshotEntries.filter(({ path }) => !removed.has(path));
    for (const file of input.files) {
      const sha = createHash(this.snapshotObjectFormat)
        .update(`blob ${file.content.length}\0`)
        .update(file.content)
        .digest("hex");
      const entry = {
        path: file.path,
        mode: file.mode,
        sha,
        size: file.content.length,
      };
      const index = entries.findIndex(({ path }) => path === file.path);
      if (index === -1) entries.push(entry);
      else entries[index] = entry;
    }
    this.snapshotEntries = entries;
  }

  async exec(input: { exec_id: string }): Promise<SandboxExecProcess> {
    this.execStarted.push(input.exec_id);
    let finish!: (outcome: SandboxExecOutcome) => void;
    const finished = new Promise<SandboxExecOutcome>((resolve) => (finish = resolve));
    return {
      finished,
      cancel: async (reason) => {
        this.execCancellations.push(reason);
        finish({ exit_code: null, duration_ms: 1, reason });
      },
    };
  }
}

class MaterializingExecutionDriver extends FakeExecutionDriver {
  readonly materialized: Array<{
    sandbox_id: string;
    room_id: string;
    participant_id: string;
    workspace: { repo_path: string; revision: number };
  }> = [];
  readonly order: string[] = [];

  async materialize(input: {
    sandbox_id: string;
    room_id: string;
    participant_id: string;
    workspace: { repo_path: string; revision: number };
  }): Promise<void> {
    this.order.push("materialize");
    this.materialized.push(input);
  }

  override async start(input: { sandbox_id: string; resources: SandboxResources }): Promise<void> {
    this.order.push("start");
    await super.start(input);
  }
}

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

function failOneTransactionQuery(pool: Pool, sqlFragment: string): Pool {
  let shouldFail = true;
  return new Proxy(pool, {
    get(target, property, receiver) {
      if (property === "query") return target.query.bind(target);
      if (property === "connect")
        return async () => {
          const client = await target.connect();
          const originalQuery = client.query.bind(client);
          return new Proxy(client, {
            get(clientTarget, clientProperty, clientReceiver) {
              if (clientProperty === "query")
                return async (...args: unknown[]) => {
                  const sql = args[0];
                  if (shouldFail && typeof sql === "string" && sql.includes(sqlFragment)) {
                    shouldFail = false;
                    throw new Error("injected database write failure");
                  }
                  return Reflect.apply(originalQuery, clientTarget, args);
                };
              const value = Reflect.get(clientTarget, clientProperty, clientReceiver);
              return typeof value === "function" ? value.bind(clientTarget) : value;
            },
          });
        };
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Pool;
}

async function makeParticipants(count = 1, kind: "HUMAN" | "AGENT" = "AGENT") {
  const roomId = newId("room");
  await db.pool.query(
    "INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'Sandbox test', 'Test', 'owner')",
    [roomId],
  );
  const participantIds = Array.from({ length: count }, () => newId("part"));
  for (const participantId of participantIds)
    await db.pool.query(
      `INSERT INTO participants (id, room_id, kind, display_name, role, status)
       VALUES ($1, $2, $3, 'Sandbox tester', 'DEVELOPER', 'ACTIVE')`,
      [participantId, roomId, kind],
    );
  return { roomId, participantIds };
}

describe("ExecutionService", () => {
  it("cancels a pending reservation without launching its driver process", async () => {
    const { roomId, participantIds } = await makeParticipants(1, "AGENT");
    const participantId = participantIds[0]!;
    const driver = new FakeExecutionDriver();
    const execution = new ExecutionService(db.pool, driver);
    const execId = newId("exec");
    const cancelledBy = newId("part");
    await execution.reserveExec(roomId, participantId, execId);

    expect(
      await execution.cancelExec(roomId, participantId, execId, "cancelled", cancelledBy),
    ).toBe(true);
    const process = await execution.startExec({
      room_id: roomId,
      participant_id: participantId,
      exec_id: execId,
      command: "sleep 5",
      cwd: "/workspace",
      timeoutMs: 60_000,
      onOutput: async () => {},
    });

    expect(driver.execStarted).toEqual([]);
    expect(process.cancelled_by).toBe(cancelledBy);
    await expect(process.finished).resolves.toMatchObject({
      exit_code: null,
      reason: "cancelled",
    });
  });

  it("materializes the canonical revision before starting and records the numeric base", async () => {
    const { roomId, participantIds } = await makeParticipants();
    const workspaceId = newId("ws");
    const repoPath = `/workspace/${roomId}.git`;
    await db.pool.query("INSERT INTO workspaces (id, room_id, repo_path) VALUES ($1, $2, $3)", [
      workspaceId,
      roomId,
      repoPath,
    ]);
    await db.pool.query(
      `INSERT INTO workspace_revisions (workspace_id, room_id, revision, commit_sha)
       VALUES ($1, $2, 7, $3)`,
      [workspaceId, roomId, "a".repeat(40)],
    );
    const driver = new MaterializingExecutionDriver();
    const execution = new ExecutionService(db.pool, driver);

    const sandbox = await execution.ensure(roomId, participantIds[0]!);
    await execution.ensure(roomId, participantIds[0]!);

    expect(sandbox.base_revision).toBe(7);
    expect(driver.materialized).toEqual([
      {
        sandbox_id: sandbox.id,
        room_id: roomId,
        participant_id: participantIds[0],
        resources: {
          volume_ref: `volume:${sandbox.id}`,
          container_ref: `container:${sandbox.id}`,
        },
        workspace: { repo_path: repoPath, revision: 7 },
      },
    ]);
    expect(driver.order[0]).toBe("materialize");
    expect(driver.order[1]).toBe("start");
  });

  it("reports the canonical base and head with local working-copy changes", async () => {
    const { roomId, participantIds } = await makeParticipants();
    const root = await mkdtemp(join(tmpdir(), "crossover-execution-status-"));
    try {
      const checkoutPath = join(root, "checkout");
      await mkdir(checkoutPath);
      await git(["init", "--quiet", checkoutPath], { timeoutMs: 10_000 });
      const repoPath = join(checkoutPath, ".git");
      await mkdir(join(checkoutPath, "src"));
      await writeFile(join(checkoutPath, "src/changed.ts"), "base\n");
      await writeFile(join(checkoutPath, "old.txt"), "old\n");
      await writeFile(join(checkoutPath, "secret.txt"), "hidden\n");
      const commit = async (message: string) => {
        await git(["add", "-A"], { cwd: checkoutPath, timeoutMs: 10_000 });
        await git(
          [
            "-c",
            "user.name=Sandbox Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "--quiet",
            "-m",
            message,
          ],
          { cwd: checkoutPath, timeoutMs: 10_000 },
        );
        return (
          await git(["rev-parse", "HEAD"], { gitDir: repoPath, timeoutMs: 10_000 })
        ).stdout.trim();
      };
      const baseCommit = await commit("base");
      const baseBlob = (
        await git(["rev-parse", `${baseCommit}:src/changed.ts`], {
          gitDir: repoPath,
          timeoutMs: 10_000,
        })
      ).stdout.trim();
      const localBlob = (
        await git(["hash-object", "--stdin"], {
          cwd: checkoutPath,
          timeoutMs: 10_000,
          input: "local\n",
        })
      ).stdout.trim();
      expect(localBlob).not.toBe(baseBlob);
      await writeFile(join(checkoutPath, "src/changed.ts"), "canonical\n");
      await rm(join(checkoutPath, "old.txt"));
      await writeFile(join(checkoutPath, "new.txt"), "new\n");
      const headCommit = await commit("head");
      const canonicalBlob = (
        await git(["rev-parse", `${headCommit}:src/changed.ts`], {
          gitDir: repoPath,
          timeoutMs: 10_000,
        })
      ).stdout.trim();
      const newBlob = (
        await git(["rev-parse", `${headCommit}:new.txt`], { gitDir: repoPath, timeoutMs: 10_000 })
      ).stdout.trim();
      const workspaceId = newId("ws");
      await db.pool.query("INSERT INTO workspaces (id, room_id, repo_path) VALUES ($1, $2, $3)", [
        workspaceId,
        roomId,
        repoPath,
      ]);
      await db.pool.query(
        `INSERT INTO workspace_revisions (workspace_id, room_id, revision, commit_sha)
       VALUES ($1, $2, 7, $3)`,
        [workspaceId, roomId, baseCommit],
      );
      const driver = new MaterializingExecutionDriver();
      driver.snapshotEntries = [
        { path: "src/changed.ts", mode: "100644", sha: localBlob, size: 6 },
        { path: "notes/new.md", mode: "100644", sha: null, size: 3 },
      ];
      const execution = new ExecutionService(db.pool, driver, {
        readablePaths: async (_roomId, _participantId, paths) =>
          paths.filter((path) => path !== "secret.txt"),
      });
      const sandbox = await execution.ensure(roomId, participantIds[0]!);
      await db.pool.query(
        `INSERT INTO workspace_revisions (workspace_id, room_id, revision, commit_sha)
       VALUES ($1, $2, 10, $3)`,
        [workspaceId, roomId, headCommit],
      );

      await expect(execution.status(roomId, participantIds[0]!)).resolves.toEqual({
        base_revision: 7,
        head_revision: 10,
        behind_by: 3,
        modified: ["src/changed.ts"],
        added: ["notes/new.md"],
        deleted: ["old.txt"],
        truncated: false,
      });

      // Once submit or sync advances the base, files now canonical are clean by that database
      // revision even if the sandbox's own Git index still describes its original materialization.
      await db.pool.query("UPDATE sandboxes SET base_revision = 10 WHERE id = $1", [sandbox.id]);
      driver.snapshotEntries = [
        { path: "src/changed.ts", mode: "100644", sha: canonicalBlob, size: 10 },
        { path: "new.txt", mode: "100644", sha: newBlob, size: 4 },
      ];
      await expect(execution.status(roomId, participantIds[0]!)).resolves.toMatchObject({
        base_revision: 10,
        head_revision: 10,
        behind_by: 0,
        modified: [],
        added: [],
        deleted: [],
        truncated: false,
      });
      expect(driver.statusCalls).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("coalesces canonical advances and never reports or installs unreadable paths", async () => {
    const { roomId, participantIds } = await makeParticipants();
    const root = await mkdtemp(join(tmpdir(), "crossover-execution-advance-"));
    try {
      const checkoutPath = join(root, "checkout");
      await mkdir(checkoutPath);
      await git(["init", "--quiet", checkoutPath], { timeoutMs: 10_000 });
      const repoPath = join(checkoutPath, ".git");
      await writeFile(join(checkoutPath, "public.txt"), "base public\n");
      await writeFile(join(checkoutPath, "secret.txt"), "base secret\n");
      const commit = async (message: string) => {
        await git(["add", "-A"], { cwd: checkoutPath, timeoutMs: 10_000 });
        await git(
          [
            "-c",
            "user.name=Sandbox Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "--quiet",
            "-m",
            message,
          ],
          { cwd: checkoutPath, timeoutMs: 10_000 },
        );
        return (
          await git(["rev-parse", "HEAD"], { gitDir: repoPath, timeoutMs: 10_000 })
        ).stdout.trim();
      };
      const baseCommit = await commit("base");
      const workspaceId = newId("ws");
      await db.pool.query("INSERT INTO workspaces (id, room_id, repo_path) VALUES ($1, $2, $3)", [
        workspaceId,
        roomId,
        repoPath,
      ]);
      await db.pool.query(
        `INSERT INTO workspace_revisions (workspace_id, room_id, revision, commit_sha)
         VALUES ($1, $2, 0, $3)`,
        [workspaceId, roomId, baseCommit],
      );
      const driver = new MaterializingExecutionDriver();
      const visible = async (_room: string, _participant: string, paths: readonly string[]) =>
        paths.filter((path) => path !== "secret.txt");
      const execution = new ExecutionService(db.pool, driver, { readablePaths: visible });
      const sandbox = await execution.ensure(roomId, participantIds[0]!);
      const basePublic = (
        await git(["rev-parse", `${baseCommit}:public.txt`], {
          gitDir: repoPath,
          timeoutMs: 10_000,
        })
      ).stdout.trim();
      driver.snapshotEntries = [
        { path: "public.txt", mode: "100644", sha: basePublic, size: 12 },
        { path: "secret.txt", mode: "100644", sha: "f".repeat(40), size: 17 },
      ];
      const execId = newId("exec");
      await execution.reserveExec(roomId, participantIds[0]!, execId);
      await execution.startExec({
        room_id: roomId,
        participant_id: participantIds[0]!,
        exec_id: execId,
        command: "long-running command",
        cwd: "/workspace",
        timeoutMs: 60_000,
        onOutput: async () => {},
      });

      await writeFile(join(checkoutPath, "secret.txt"), "hidden canonical change\n");
      const hiddenCommit = await commit("hidden change");
      await writeFile(join(checkoutPath, "public.txt"), "visible canonical change\n");
      const headCommit = await commit("visible change");
      await db.pool.query(
        `INSERT INTO workspace_revisions (workspace_id, room_id, revision, commit_sha)
         VALUES ($1, $2, 1, $3), ($1, $2, 2, $4)`,
        [workspaceId, roomId, hiddenCommit, headCommit],
      );
      const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
      execution.setSandboxEventSink(async (_roomId, emitted) => {
        events.push(...emitted.map(({ type, payload }) => ({ type, payload })));
      });
      // A submit-specific skip for revision 1 must not suppress the coalesced revision 2.
      execution.scheduleCanonicalAdvance(roomId, 1, participantIds[0]!);
      execution.scheduleCanonicalAdvance(roomId, 2);

      await vi.waitFor(() => {
        expect(
          events.some(
            ({ type, payload }) =>
              type === "sandbox.behind" && payload.reason === "process_running",
          ),
        ).toBe(true);
      });
      expect(driver.snapshotUpdates).toHaveLength(0);
      expect(await execution.get(roomId, participantIds[0]!)).toMatchObject({ base_revision: 0 });

      await execution.cancelExec(roomId, participantIds[0]!, execId);
      await vi.waitFor(async () => {
        expect((await execution.get(roomId, participantIds[0]!))?.base_revision).toBe(2);
      });
      await vi.waitFor(() => {
        expect(events.some(({ type }) => type === "sandbox.synced")).toBe(true);
      });
      expect(driver.snapshotUpdates).toHaveLength(1);
      expect(driver.snapshotUpdates[0]!.files.map(({ path }) => path)).toEqual(["public.txt"]);
      expect(events.find(({ type }) => type === "sandbox.behind")?.payload).toMatchObject({
        changed_paths: ["public.txt"],
        overlaps_local_changes: false,
      });
      expect(JSON.stringify(events)).not.toContain("secret.txt");
      expect(await execution.get(roomId, participantIds[0]!)).toMatchObject({
        id: sandbox.id,
        base_revision: 2,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("bounds raw snapshot status at the shared entry limit", async () => {
    const { roomId, participantIds } = await makeParticipants();
    const root = await mkdtemp(join(tmpdir(), "crossover-execution-status-cap-"));
    try {
      const checkoutPath = join(root, "checkout");
      await mkdir(checkoutPath);
      await git(["init", "--quiet", checkoutPath], { timeoutMs: 10_000 });
      const repoPath = join(checkoutPath, ".git");
      await writeFile(join(checkoutPath, "base.txt"), "base\n");
      await git(["add", "."], { cwd: checkoutPath, timeoutMs: 10_000 });
      await git(
        [
          "-c",
          "user.name=Sandbox Test",
          "-c",
          "user.email=test@example.invalid",
          "commit",
          "--quiet",
          "-m",
          "base",
        ],
        { cwd: checkoutPath, timeoutMs: 10_000 },
      );
      const baseCommit = (
        await git(["rev-parse", "HEAD"], { gitDir: repoPath, timeoutMs: 10_000 })
      ).stdout.trim();
      const baseBlob = (
        await git(["rev-parse", `${baseCommit}:base.txt`], {
          gitDir: repoPath,
          timeoutMs: 10_000,
        })
      ).stdout.trim();
      const workspaceId = newId("ws");
      await db.pool.query("INSERT INTO workspaces (id, room_id, repo_path) VALUES ($1, $2, $3)", [
        workspaceId,
        roomId,
        repoPath,
      ]);
      await db.pool.query(
        `INSERT INTO workspace_revisions (workspace_id, room_id, revision, commit_sha)
         VALUES ($1, $2, 1, $3)`,
        [workspaceId, roomId, baseCommit],
      );
      const driver = new MaterializingExecutionDriver();
      driver.snapshotEntries = [
        { path: "base.txt", mode: "100644", sha: baseBlob, size: 5 },
        ...Array.from({ length: 10_001 }, (_, index) => ({
          path: `new/file-${index}.txt`,
          mode: "100644",
          sha: null,
          size: 1,
        })),
      ];
      const execution = new ExecutionService(db.pool, driver);
      await execution.ensure(roomId, participantIds[0]!);

      const status = await execution.status(roomId, participantIds[0]!);
      expect(status.added).toContain("new/file-0.txt");
      expect(status.added).toHaveLength(10_000);
      expect(status.added).not.toContain("new/file-10000.txt");
      expect(status.truncated).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("creates one sandbox per room participant and records the selected disk policy", async () => {
    const { roomId, participantIds } = await makeParticipants(2);
    const driver = new FakeExecutionDriver();
    const execution = new ExecutionService(db.pool, driver, { diskEnforcement: "hard" });
    const [first, concurrent] = await Promise.all([
      execution.ensure(roomId, participantIds[0]!),
      execution.ensure(roomId, participantIds[0]!),
    ]);
    const second = await execution.ensure(roomId, participantIds[1]!);

    expect(first.id).toBe(concurrent.id);
    expect(first.id).not.toBe(second.id);
    expect(first.volume_ref).not.toBe(second.volume_ref);
    expect(first.limits).toEqual({ disk_enforcement: "hard" });
    expect(driver.limits).toEqual([{ disk_enforcement: "hard" }, { disk_enforcement: "hard" }]);
    expect(driver.created).toHaveLength(2);
    expect(driver.started).toContain(first.id);
    expect(await execution.get(roomId, participantIds[0]!)).toMatchObject({ id: first.id });
    expect(await execution.get(roomId, newId("part"))).toBeNull();
  });

  it("retries a failed create by adopting the stable CREATING row and its resources", async () => {
    const { roomId, participantIds } = await makeParticipants();
    const driver = new FakeExecutionDriver();
    driver.failCreateAfterProvision = true;
    const execution = new ExecutionService(db.pool, driver);

    await expect(execution.ensure(roomId, participantIds[0]!)).rejects.toThrow(
      "injected Docker create failure",
    );
    const creating = await execution.get(roomId, participantIds[0]!);
    expect(creating).toMatchObject({ status: "CREATING" });

    const resumed = await execution.ensure(roomId, participantIds[0]!);
    expect(resumed).toMatchObject({ id: creating!.id, status: "RUNNING" });
    expect(driver.createCalls).toEqual([creating!.id, creating!.id]);
    expect(driver.created).toEqual([creating!.id]);
    expect(driver.started).toEqual([creating!.id]);
  });

  it("destroys resources when participant cleanup wins after driver creation", async () => {
    const { roomId, participantIds } = await makeParticipants();
    const driver = new FakeExecutionDriver();
    const gate = { entered: deferred(), release: deferred() };
    const execution = new ExecutionService(db.pool, driver, {
      afterDriverCreate: async () => {
        gate.entered.resolve();
        await gate.release.promise;
      },
    });

    const ensuring = execution.ensure(roomId, participantIds[0]!);
    await gate.entered.promise;
    const creating = await execution.get(roomId, participantIds[0]!);
    expect(creating).toMatchObject({ status: "CREATING" });

    await execution.destroyParticipant(roomId, participantIds[0]!);
    expect(await execution.get(roomId, participantIds[0]!)).toMatchObject({ status: "DESTROYED" });

    gate.release.resolve();
    await expect(ensuring).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(driver.destroyCalls).toEqual([creating!.id, creating!.id]);
    expect(driver.provisioned.has(creating!.id)).toBe(false);
    expect(driver.running.has(creating!.id)).toBe(false);
  });

  it("recovers resources when a failure occurs after create but before refs are recorded", async () => {
    const { roomId, participantIds } = await makeParticipants();
    const driver = new FakeExecutionDriver();
    let failOnce = true;
    const execution = new ExecutionService(db.pool, driver, {
      afterDriverCreate: async () => {
        if (failOnce) {
          failOnce = false;
          throw new Error("injected failure before recording resources");
        }
      },
    });

    await expect(execution.ensure(roomId, participantIds[0]!)).rejects.toThrow(
      "injected failure before recording resources",
    );
    const creating = await execution.get(roomId, participantIds[0]!);
    expect(creating).toMatchObject({ status: "CREATING", volume_ref: null, container_ref: null });

    const retried = await execution.ensure(roomId, participantIds[0]!);
    expect(retried).toMatchObject({ id: creating!.id, status: "RUNNING" });
    expect(driver.createCalls).toEqual([creating!.id, creating!.id]);
    expect(driver.created).toEqual([creating!.id]);
  });

  it("hibernates after 30 minutes, retains the volume, and resumes the same sandbox", async () => {
    const { roomId, participantIds } = await makeParticipants();
    const driver = new FakeExecutionDriver();
    const execution = new ExecutionService(db.pool, driver);
    const created = await execution.ensure(roomId, participantIds[0]!);
    await db.pool.query(
      "UPDATE sandboxes SET last_active_at = clock_timestamp() - interval '31 minutes' WHERE id = $1",
      [created.id],
    );

    expect(await execution.sweepIdle()).toBe(1);
    expect(await execution.get(roomId, participantIds[0]!)).toMatchObject({
      id: created.id,
      status: "HIBERNATED",
      volume_ref: created.volume_ref,
    });
    const resumed = await execution.ensure(roomId, participantIds[0]!);
    expect(resumed).toMatchObject({
      id: created.id,
      status: "RUNNING",
      volume_ref: created.volume_ref,
    });
    expect(driver.stopped).toEqual([created.id]);
    expect(driver.started).toEqual([created.id, created.id]);
  });

  it("cancels a running agent exec before hibernating its sandbox", async () => {
    const { roomId, participantIds } = await makeParticipants(1, "AGENT");
    const driver = new FakeExecutionDriver();
    const execution = new ExecutionService(db.pool, driver);
    const participantId = participantIds[0]!;
    await execution.ensure(roomId, participantId);
    await execution.cancelParticipantExecs(roomId, participantId, "revoked");
    expect(driver.stopped).toHaveLength(1);
    const execId = newId("exec");
    await execution.reserveExec(roomId, participantId, execId);
    await execution.startExec({
      room_id: roomId,
      participant_id: participantId,
      exec_id: execId,
      command: "long-running agent task",
      cwd: "/workspace",
      timeoutMs: 60_000,
      onOutput: async () => {},
    });
    await execution.hibernateRoom(roomId, true);
    expect(driver.execCancellations).toEqual(["sandbox_stopped"]);
    expect(await execution.get(roomId, participantId)).toMatchObject({ status: "HIBERNATED" });
  });

  it("restores a stopped container when hibernation's database write fails", async () => {
    const { roomId, participantIds } = await makeParticipants();
    const driver = new FakeExecutionDriver();
    const flakyPool = failOneTransactionQuery(db.pool, "SET status = 'HIBERNATED'");
    const execution = new ExecutionService(flakyPool, driver);
    const created = await execution.ensure(roomId, participantIds[0]!);
    await db.pool.query(
      "UPDATE sandboxes SET last_active_at = clock_timestamp() - interval '31 minutes' WHERE id = $1",
      [created.id],
    );

    await expect(execution.sweepIdle()).rejects.toThrow("injected database write failure");
    expect(await execution.get(roomId, participantIds[0]!)).toMatchObject({ status: "RUNNING" });
    const healed = await execution.ensure(roomId, participantIds[0]!);
    expect(healed.status).toBe("RUNNING");
    expect(driver.started).toEqual([created.id, created.id]);
  });

  it("keeps an active ensure from being hibernated by a concurrent idle sweep", async () => {
    const { roomId, participantIds } = await makeParticipants();
    const driver = new FakeExecutionDriver();
    const execution = new ExecutionService(db.pool, driver);
    const created = await execution.ensure(roomId, participantIds[0]!);
    await db.pool.query(
      "UPDATE sandboxes SET last_active_at = clock_timestamp() - interval '31 minutes' WHERE id = $1",
      [created.id],
    );
    const gate = { entered: deferred(), release: deferred() };
    driver.stopGate = gate;

    const sweep = execution.sweepIdle();
    await gate.entered.promise;
    const ensure = execution.ensure(roomId, participantIds[0]!);
    gate.release.resolve();
    expect(await sweep).toBe(1);
    const active = await ensure;
    expect(active.status).toBe("RUNNING");
    expect(driver.running.has(active.id)).toBe(true);
  });

  it("makes participant and room cleanup safe to retry after Docker has removed resources", async () => {
    const { roomId, participantIds } = await makeParticipants(2);
    const driver = new FakeExecutionDriver();
    const flakyPool = failOneTransactionQuery(db.pool, "SET status = 'DESTROYED'");
    const execution = new ExecutionService(flakyPool, driver);
    const [first, second] = await Promise.all(
      participantIds.map((participantId) => execution.ensure(roomId, participantId)),
    );

    await expect(execution.destroyParticipant(roomId, participantIds[0]!)).rejects.toThrow(
      "injected database write failure",
    );
    expect(await execution.get(roomId, participantIds[0]!)).toMatchObject({ status: "DESTROYING" });
    await execution.destroyParticipant(roomId, participantIds[0]!);
    expect(await execution.get(roomId, participantIds[0]!)).toMatchObject({ status: "DESTROYED" });
    await execution.destroyRoom(roomId);
    expect(await execution.get(roomId, participantIds[1]!)).toMatchObject({ status: "DESTROYED" });
    expect(driver.destroyCalls.filter((id) => id === first!.id)).toHaveLength(2);
    expect(driver.destroyed.map(({ container_ref }) => container_ref).sort()).toEqual(
      [first!.container_ref, second!.container_ref].sort(),
    );
  });

  it("sweeps stale destroys, removed participants, and archived rooms", async () => {
    const driver = new FakeExecutionDriver();
    const execution = new ExecutionService(db.pool, driver);
    const logFailure = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const stale = await makeParticipants();
      const staleSandbox = await execution.ensure(stale.roomId, stale.participantIds[0]!);
      driver.failDestroyOnce = true;
      await expect(
        execution.destroyParticipant(stale.roomId, stale.participantIds[0]!),
      ).rejects.toThrow("injected Docker destroy failure after removal");
      await db.pool.query(
        "UPDATE sandboxes SET updated_at = clock_timestamp() - interval '2 minutes' WHERE id = $1",
        [staleSandbox.id],
      );
      expect(await execution.sweepCleanup()).toBe(1);
      expect(await execution.get(stale.roomId, stale.participantIds[0]!)).toMatchObject({
        status: "DESTROYED",
      });

      const removed = await makeParticipants();
      const removedSandbox = await execution.ensure(removed.roomId, removed.participantIds[0]!);
      await db.pool.query("UPDATE participants SET status = 'REMOVED' WHERE id = $1", [
        removed.participantIds[0],
      ]);
      driver.failDestroyOnce = true;
      expect(await execution.sweepCleanup()).toBe(0);
      expect(await execution.get(removed.roomId, removed.participantIds[0]!)).toMatchObject({
        status: "DESTROYING",
      });
      expect(await execution.sweepCleanup()).toBe(1);
      expect(await execution.get(removed.roomId, removed.participantIds[0]!)).toMatchObject({
        status: "DESTROYED",
      });

      const archived = await makeParticipants();
      const archivedSandbox = await execution.ensure(archived.roomId, archived.participantIds[0]!);
      await db.pool.query("UPDATE rooms SET status = 'ARCHIVED' WHERE id = $1", [archived.roomId]);
      expect(await execution.sweepCleanup()).toBe(1);
      expect(await execution.get(archived.roomId, archived.participantIds[0]!)).toMatchObject({
        status: "DESTROYED",
      });
      expect(driver.destroyCalls).toEqual([
        staleSandbox.id,
        staleSandbox.id,
        removedSandbox.id,
        removedSandbox.id,
        archivedSandbox.id,
      ]);
    } finally {
      logFailure.mockRestore();
    }
  });

  it("does not create sandboxes for removed or paused participants or paused rooms", async () => {
    const { roomId, participantIds } = await makeParticipants();
    const driver = new FakeExecutionDriver();
    const execution = new ExecutionService(db.pool, driver);
    await db.pool.query("UPDATE participants SET status = 'REMOVED' WHERE id = $1", [
      participantIds[0],
    ]);
    await expect(execution.ensure(roomId, participantIds[0]!)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    const paused = await makeParticipants();
    await db.pool.query("UPDATE participants SET status = 'PAUSED' WHERE id = $1", [
      paused.participantIds[0],
    ]);
    await expect(execution.ensure(paused.roomId, paused.participantIds[0]!)).rejects.toMatchObject({
      code: "PARTICIPANT_PAUSED",
    });

    const frozen = await makeParticipants();
    await db.pool.query("UPDATE rooms SET status = 'PAUSED' WHERE id = $1", [frozen.roomId]);
    await expect(execution.ensure(frozen.roomId, frozen.participantIds[0]!)).rejects.toMatchObject({
      code: "ROOM_PAUSED",
    });
    expect(driver.created).toEqual([]);
  });
});
