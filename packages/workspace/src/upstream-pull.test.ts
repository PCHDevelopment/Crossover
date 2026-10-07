import { chmod, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withTransaction } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { allowAll, Dispatcher, registerMessageCommands } from "@crossover/kernel";
import { CrossoverError, newId } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerWorkspaceCommands } from "./apply.js";
import { git } from "./git.js";
import { provisionWorkspace } from "./provision.js";
import type { FetchedUpstream, UpstreamFetcher } from "./upstream.js";

let db: TestDatabase;
const dirs: string[] = [];

beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

const tmp = async (prefix: string) => {
  const d = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
const identity = {
  GIT_AUTHOR_NAME: "T",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "T",
  GIT_COMMITTER_EMAIL: "t@example.com",
};
const run = (cwd: string, args: string[]) => git(args, { cwd, timeoutMs: 30_000, env: identity });

/** A local upstream repository that can move on between pulls. */
async function upstreamRepo() {
  const dir = await tmp("crossover-upstream-");
  await run(dir, ["init", "-q", "-b", "main"]);
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "README.md"), "# Upstream\n");
  await writeFile(join(dir, "src/a.ts"), "export const a = 1;\nexport const keep = 0;\n");
  await writeFile(join(dir, "src/b.ts"), "export const b = 1;\n");
  await writeFile(join(dir, "old.txt"), "to be removed\n");
  await writeFile(join(dir, "run.sh"), "#!/bin/sh\n");
  await run(dir, ["add", "-A"]);
  await run(dir, ["commit", "-q", "-m", "Initial"]);
  return {
    dir,
    async commit(change: (dir: string) => Promise<void>, message = "Next") {
      await change(dir);
      await run(dir, ["add", "-A"]);
      await run(dir, ["commit", "-q", "--allow-empty", "-m", message]);
      return (await run(dir, ["rev-parse", "HEAD"])).stdout.trim();
    },
    tree: async () => (await run(dir, ["rev-parse", "HEAD^{tree}"])).stdout.trim(),
  };
}

class FixtureFetcher implements UpstreamFetcher {
  fetches = 0;
  /** Runs while a fetch is "on the network": a slow upstream, or something happening meanwhile. */
  during: (() => Promise<void>) | undefined;
  constructor(private readonly source: string) {}
  async fetch() {
    this.fetches += 1;
    await this.during?.();
    const dir = await tmp("crossover-fetched-");
    await run(dir, ["clone", "-q", "--bare", this.source, "repo"]);
    const repo = join(dir, "repo");
    const sha = (
      await git(["rev-parse", "HEAD"], { gitDir: repo, timeoutMs: 10_000 })
    ).stdout.trim();
    const fetched: FetchedUpstream = {
      repo,
      ref: "HEAD",
      sha,
      cleanup: async () => {
        await rm(dir, { recursive: true, force: true });
      },
    };
    return fetched;
  }
}

const URL_OK = "https://github.com/acme/widgets";

async function setup() {
  const up = await upstreamRepo();
  const roomId = newId("room");
  const lead = newId("part");
  const dev = newId("part");
  const root = await tmp("crossover-pull-room-");
  await db.pool.query(
    "INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'Room', 'Ship', $2)",
    [roomId, lead],
  );
  await db.pool.query(
    `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status)
     VALUES ($2, $1, 'HUMAN', 'Lead', 'OWNER', 'LEAD', 'ACTIVE'),
            ($3, $1, 'AGENT', 'Dev', 'MEMBER', 'DEVELOPER', 'ACTIVE')`,
    [roomId, lead, dev],
  );
  await withTransaction(db.pool, (client) => provisionWorkspace(client, roomId, root));
  const repo = (
    await db.pool.query("SELECT repo_path FROM workspaces WHERE room_id = $1", [roomId])
  ).rows[0].repo_path as string;
  const fetcher = new FixtureFetcher(up.dir);
  const d = new Dispatcher({ pool: db.pool, authorize: allowAll, nodeId: roomId });
  registerWorkspaceCommands(d, {
    upstream: { fetcher, resolve: async () => ["93.184.216.34"] },
  });
  registerMessageCommands(d);
  const as = (id: string, kind: "HUMAN" | "AGENT", role: "LEAD" | "DEVELOPER") => ({
    room_id: roomId,
    participant_id: id,
    kind,
    authority: kind === "HUMAN" ? ("OWNER" as const) : ("MEMBER" as const),
    role,
  });
  const leadP = as(lead, "HUMAN", "LEAD");
  const devP = as(dev, "AGENT", "DEVELOPER");
  const call = (principal: ReturnType<typeof as>, method: string, params: object) =>
    d.dispatch(principal, { id: newId("cmd"), method, params, idempotency_key: newId("cmd") });
  await call(leadP, "git.import", { url: URL_OK, branch: "main" });
  const head = async () =>
    (
      await db.pool.query(
        "SELECT revision, commit_sha FROM workspace_revisions WHERE room_id = $1 ORDER BY revision DESC LIMIT 1",
        [roomId],
      )
    ).rows[0] as { revision: string; commit_sha: string };
  const upstreamRow = async () => {
    const row = (await db.pool.query("SELECT * FROM upstreams WHERE room_id = $1", [roomId]))
      .rows[0];
    return { ...row, last_synced_room_revision: Number(row.last_synced_room_revision) };
  };
  const events = async (type: string) =>
    (
      await db.pool.query(
        "SELECT payload, actor_id FROM events WHERE room_id = $1 AND type = $2 ORDER BY sequence",
        [roomId, type],
      )
    ).rows;
  const pull = () => call(leadP, "git.pull_upstream", {});
  const edit = async (path: string, content: string) =>
    call(devP, "workspace.apply_changeset", {
      source: "EDITOR",
      message: `edit ${path}`,
      base_workspace_revision: Number((await head()).revision),
      operations: [{ type: "modify", path, content }],
    });
  const read = async (path: string) =>
    (
      await git(["show", `${(await head()).commit_sha}:${path}`], {
        gitDir: repo,
        timeoutMs: 10_000,
      })
    ).stdout;
  return {
    up,
    fetcher,
    call,
    leadP,
    devP,
    roomId,
    repo,
    head,
    upstreamRow,
    events,
    pull,
    edit,
    read,
    d,
  };
}

const rejects = async (p: Promise<unknown>, reason: string) => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CrossoverError);
  expect((err as CrossoverError).code).toBe("VALIDATION");
  expect((err as CrossoverError).details).toMatchObject({ reason });
};

describe("git.pull_upstream (§24.2, T803)", () => {
  it("brings an upstream change in as an UPSTREAM ChangeSet; the room tree equals the upstream tip's", async () => {
    const s = await setup();
    const sha = await s.up.commit(async (dir) => {
      await writeFile(join(dir, "src/a.ts"), "export const a = 2;\nexport const keep = 0;\n");
      await writeFile(join(dir, "src/new.bin"), Buffer.from([0, 1, 2, 255, 0, 3]));
      await unlink(join(dir, "old.txt"));
    });
    const out = await s.pull();
    expect(out.response).toMatchObject({
      status: "APPLIED",
      applied_revision: 2,
      upstream: { last_synced_sha: sha, last_synced_room_revision: 2 },
    });
    const room = (await s.head()).commit_sha;
    expect(
      (
        await git(["rev-parse", `${room}^{tree}`], { gitDir: s.repo, timeoutMs: 10_000 })
      ).stdout.trim(),
    ).toBe(await s.up.tree());
    const { rows } = await db.pool.query(
      "SELECT source, actor_id, status, base_workspace_revision::int AS base_workspace_revision FROM changesets WHERE room_id = $1 AND applied_revision = 2",
      [s.roomId],
    );
    expect(rows).toEqual([
      {
        source: "UPSTREAM",
        actor_id: "system:upstream",
        status: "APPLIED",
        base_workspace_revision: 1,
      },
    ]);
    const files = await db.pool.query(
      "SELECT DISTINCT actor_id FROM file_revisions WHERE room_id = $1 AND workspace_revision = 2",
      [s.roomId],
    );
    expect(files.rows).toEqual([{ actor_id: "system:upstream" }]);
    expect(await s.upstreamRow()).toMatchObject({
      last_synced_sha: sha,
      last_synced_room_revision: 2,
    });
    expect(await s.events("workspace.upstream_synced")).toHaveLength(2); // the import, then this
  });

  it("an upstream that hasn't moved is UP_TO_DATE: no revision, no event", async () => {
    const s = await setup();
    const out = await s.pull();
    expect(out.response).toMatchObject({ status: "UP_TO_DATE" });
    expect(Number((await s.head()).revision)).toBe(1);
    expect(await s.events("workspace.upstream_synced")).toHaveLength(1);
  });

  it("non-overlapping room and upstream edits merge; the room's edit is kept", async () => {
    const s = await setup();
    await s.edit("src/b.ts", "export const b = 'room';\n"); // revision 2, after the sync at 1
    await s.up.commit(async (dir) => {
      await writeFile(
        join(dir, "src/a.ts"),
        "export const a = 'upstream';\nexport const keep = 0;\n",
      );
    });
    const out = await s.pull();
    expect(out.response).toMatchObject({ status: "APPLIED", applied_revision: 3 });
    expect(await s.read("src/a.ts")).toContain("'upstream'");
    expect(await s.read("src/b.ts")).toContain("'room'");
  });

  it("overlapping edits conflict: the caller is the submitter of record, nothing advances, a second pull is refused, and resolving applies the pull", async () => {
    const s = await setup();
    const before = await s.upstreamRow();
    await s.edit("src/a.ts", "export const a = 'room';\nexport const keep = 0;\n");
    const sha = await s.up.commit(async (dir) => {
      await writeFile(
        join(dir, "src/a.ts"),
        "export const a = 'upstream';\nexport const keep = 0;\n",
      );
    });
    const out = await s.pull();
    expect(out.response).toMatchObject({ status: "CONFLICT" });
    const conflictId = (out.response as { conflict_id: string }).conflict_id;
    const { rows } = await db.pool.query(
      "SELECT submitter_id, status FROM conflicts WHERE id = $1",
      [conflictId],
    );
    expect(rows).toEqual([{ submitter_id: s.leadP.participant_id, status: "OPEN" }]);
    expect(await s.upstreamRow()).toMatchObject({
      last_synced_sha: before.last_synced_sha,
      last_synced_room_revision: 1,
    });
    await rejects(s.pull(), "upstream_conflict_open");

    const resolved = await s.call(s.leadP, "workspace.apply_changeset", {
      source: "RESOLUTION",
      conflict_id: conflictId,
      message: "both",
      base_workspace_revision: Number((await s.head()).revision),
      operations: [
        {
          type: "modify",
          path: "src/a.ts",
          content: "export const a = 'both';\nexport const keep = 0;\n",
        },
      ],
    });
    expect(resolved.response).toMatchObject({ status: "APPLIED" });
    const revision = (resolved.response as { applied_revision: number }).applied_revision;
    expect(await s.upstreamRow()).toMatchObject({
      last_synced_sha: sha,
      last_synced_room_revision: revision,
    });
    expect((await s.events("workspace.upstream_synced")).length).toBe(2);
    // …and the next pull sees nothing new.
    expect((await s.pull()).response).toMatchObject({ status: "UP_TO_DATE" });
  });

  it("a room that never imported has no upstream → VALIDATION", async () => {
    const s = await setup();
    await db.pool.query("DELETE FROM upstreams WHERE room_id = $1", [s.roomId]);
    await rejects(s.pull(), "no_upstream");
  });

  it("refuses what a workspace can't hold, and changes nothing", async () => {
    const s = await setup();
    const before = await s.upstreamRow();
    await s.up.commit(async (dir) => {
      await symlink("README.md", join(dir, "link"));
    });
    await rejects(s.pull(), "unsupported_entry");
    expect(Number((await s.head()).revision)).toBe(1);
    expect(await s.upstreamRow()).toMatchObject({ last_synced_sha: before.last_synced_sha });
  });

  it("a commit that changes no content (only a file mode) is noted as synced without a revision", async () => {
    const s = await setup();
    const sha = await s.up.commit(async (dir) => {
      await chmod(join(dir, "run.sh"), 0o644);
    });
    const out = await s.pull();
    expect(out.response).toMatchObject({ status: "UP_TO_DATE" });
    expect(Number((await s.head()).revision)).toBe(1);
    expect(await s.upstreamRow()).toMatchObject({
      last_synced_sha: sha,
      last_synced_room_revision: 1,
    });
  });

  it("a pull of more than 500 files is split into ordered ChangeSets and the sync advances at the end", async () => {
    const s = await setup();
    const sha = await s.up.commit(async (dir) => {
      await mkdir(join(dir, "many"), { recursive: true });
      for (let i = 0; i < 501; i++) await writeFile(join(dir, `many/f${i}.txt`), `${i}\n`);
    });
    const out = await s.pull();
    expect(out.response).toMatchObject({
      status: "APPLIED",
      applied_revision: 3,
      upstream: { last_synced_sha: sha, last_synced_room_revision: 3 },
    });
    const { rows } = await db.pool.query(
      `SELECT source, applied_revision, payload #>> '{upstream,part}' AS part,
              payload #>> '{upstream,parts}' AS parts, jsonb_array_length(payload -> 'operations') AS ops
       FROM changesets WHERE room_id = $1 AND source = 'UPSTREAM' AND applied_revision > 1
       ORDER BY applied_revision`,
      [s.roomId],
    );
    expect(rows).toEqual([
      { source: "UPSTREAM", applied_revision: "2", part: "1", parts: "2", ops: 500 },
      { source: "UPSTREAM", applied_revision: "3", part: "2", parts: "2", ops: 1 },
    ]);
    const room = (await s.head()).commit_sha;
    expect(
      (
        await git(["rev-parse", `${room}^{tree}`], { gitDir: s.repo, timeoutMs: 10_000 })
      ).stdout.trim(),
    ).toBe(await s.up.tree());
  }, 60_000);

  it("a conflict in the last part of a split pull: the first part is in, the position waits, resolving it advances", async () => {
    const s = await setup();
    await s.edit("src/b.ts", "export const b = 'room';\n");
    const sha = await s.up.commit(async (dir) => {
      await mkdir(join(dir, "many"), { recursive: true });
      for (let i = 0; i < 600; i++) await writeFile(join(dir, `many/f${i}.txt`), `${i}\n`);
      await writeFile(join(dir, "src/b.ts"), "export const b = 'upstream';\n"); // sorts after many/
    });
    const out = await s.pull();
    expect(out.response).toMatchObject({ status: "CONFLICT", parts: 2, applied_parts: 1 });
    expect((await s.upstreamRow()).last_synced_room_revision).toBe(1);
    const conflictId = (out.response as { conflict_id: string }).conflict_id;
    const resolved = await s.call(s.leadP, "workspace.apply_changeset", {
      source: "RESOLUTION",
      conflict_id: conflictId,
      message: "both",
      base_workspace_revision: Number((await s.head()).revision),
      operations: [{ type: "modify", path: "src/b.ts", content: "export const b = 'both';\n" }],
    });
    expect(resolved.response).toMatchObject({ status: "APPLIED" });
    expect(await s.upstreamRow()).toMatchObject({ last_synced_sha: sha });
  }, 60_000);

  it("a conflict in an early part: resolving it doesn't finish the pull, and pulling again carries on", async () => {
    const s = await setup();
    await s.edit("README.md", "# Room's readme\n");
    const sha = await s.up.commit(async (dir) => {
      await mkdir(join(dir, "many"), { recursive: true });
      for (let i = 0; i < 600; i++) await writeFile(join(dir, `many/f${i}.txt`), `${i}\n`);
      await writeFile(join(dir, "README.md"), "# Upstream's readme\n"); // sorts before many/
    });
    const out = await s.pull();
    expect(out.response).toMatchObject({ status: "CONFLICT", parts: 2, applied_parts: 0 });
    const conflictId = (out.response as { conflict_id: string }).conflict_id;
    await s.call(s.leadP, "workspace.apply_changeset", {
      source: "RESOLUTION",
      conflict_id: conflictId,
      message: "keep both",
      base_workspace_revision: Number((await s.head()).revision),
      operations: [{ type: "modify", path: "README.md", content: "# Both\n" }],
    });
    // Not finished: the position hasn't moved.
    expect((await s.upstreamRow()).last_synced_sha).not.toBe(sha);
    const again = await s.pull();
    expect(again.response).toMatchObject({ status: "APPLIED", upstream: { last_synced_sha: sha } });
    expect(await s.read("many/f599.txt")).toBe("599\n");
    expect(await s.read("README.md")).toBe("# Both\n"); // the resolution stands
  }, 60_000);

  it("the fetch doesn't hold the room: a message posts while a slow upstream is still being fetched", async () => {
    const s = await setup();
    await s.up.commit(async (dir) => {
      await writeFile(join(dir, "src/a.ts"), "export const a = 2;\nexport const keep = 0;\n");
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started!: () => void;
    const fetching = new Promise<void>((resolve) => (started = resolve));
    s.fetcher.during = async () => {
      started();
      await gate;
    };
    const pulling = s.pull();
    await fetching; // the fetch is on the network
    const posted = await Promise.race([
      s.call(s.leadP, "messages.send", { body: "still here" }).then(() => "posted"),
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 3_000)),
    ]);
    expect(posted).toBe("posted");
    release();
    expect((await pulling).response).toMatchObject({ status: "APPLIED" });
  }, 30_000);

  it("what the fetch assumed moved while it ran: refused with CONFLICT_VERSION, nothing changes", async () => {
    const s = await setup();
    await s.up.commit(async (dir) => {
      await writeFile(join(dir, "src/a.ts"), "export const a = 2;\nexport const keep = 0;\n");
    });
    s.fetcher.during = async () => {
      // Another pull got in first, in effect: the last synced commit is no longer what was read.
      await db.pool.query("UPDATE upstreams SET last_synced_sha = $2 WHERE room_id = $1", [
        s.roomId,
        "b".repeat(40),
      ]);
    };
    await expect(s.pull()).rejects.toMatchObject({
      code: "CONFLICT_VERSION",
      details: { reason: "upstream_moved" },
    });
    expect(Number((await s.head()).revision)).toBe(1);
  });
});
