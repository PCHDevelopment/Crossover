import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withTransaction } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { allowAll, Dispatcher } from "@crossover/kernel";
import { CrossoverError, newId } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerWorkspaceCommands } from "./apply.js";
import { neutralizeTrailers } from "./checkpoint-export.js";
import { git } from "./git.js";
import { provisionWorkspace } from "./provision.js";
import type {
  FetchedUpstream,
  GitCredential,
  UpstreamFetcher,
  UpstreamPusher,
} from "./upstream.js";

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
  constructor(private readonly source: string) {}
  async fetch() {
    this.fetches += 1;
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
  // The "remote" the export pushes to: a bare repository, reached by a local path.
  const remoteDir = await tmp("crossover-remote-");
  await run(remoteDir, ["init", "-q", "--bare", "-b", "main", "remote.git"]);
  const remote = join(remoteDir, "remote.git");
  await run(up.dir, ["push", "-q", remote, "main"]);
  const pushes: { branch: string; commit: string }[] = [];
  const accessed: string[] = [];
  const pusher: UpstreamPusher = {
    async push(request) {
      pushes.push({ branch: request.branch, commit: request.commit });
      try {
        await git(
          ["push", "--porcelain", remote, `${request.commit}:refs/heads/${request.branch}`],
          {
            gitDir: request.repo,
            timeoutMs: 30_000,
          },
        );
      } catch (error) {
        throw new CrossoverError("VALIDATION", "Couldn't push to the upstream", {
          details: { reason: "push_rejected" },
          cause: error,
        });
      }
    },
  };
  const d = new Dispatcher({ pool: db.pool, authorize: allowAll, nodeId: roomId });
  registerWorkspaceCommands(d, {
    upstream: {
      fetcher,
      pusher,
      credentials: {
        credentialFor: async (_url, access) => {
          accessed.push(access ?? "read");
          return { type: "bearer", token: "tok_push_secret" } as GitCredential;
        },
      },
      resolve: async () => ["93.184.216.34"],
    },
  });
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
  const checkpoint = async (message: string, who = leadP) =>
    (await call(who, "checkpoints.create", { message })).response as {
      id: string;
      revision: number;
    };
  const exportIt = (params: object = {}) => call(leadP, "checkpoints.export", params);
  const remoteGit = async (...args: string[]) =>
    (await git(args, { gitDir: remote, timeoutMs: 30_000 })).stdout.trim();
  const slug = (await db.pool.query("SELECT slug FROM rooms WHERE id = $1", [roomId])).rows[0]
    .slug as string;
  return {
    remote,
    remoteGit,
    pushes,
    accessed,
    slug,
    checkpoint,
    exportIt,
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

const workspaceTree = async (s: Awaited<ReturnType<typeof setup>>, revision: number) => {
  const sha = (
    await db.pool.query(
      "SELECT commit_sha FROM workspace_revisions WHERE room_id = $1 AND revision = $2",
      [s.roomId, revision],
    )
  ).rows[0].commit_sha as string;
  return (
    await git(["rev-parse", `${sha}^{tree}`], { gitDir: s.repo, timeoutMs: 10_000 })
  ).stdout.trim();
};

describe("checkpoints.export (§24.3, T805)", () => {
  it("squashed: one commit per checkpoint, with the right tree, author and co-author trailers, on top of the synced upstream commit", async () => {
    const s = await setup();
    const importedSha = (await s.upstreamRow()).last_synced_sha as string;
    await s.edit("src/a.ts", "export const a = 'dev';\n"); // revision 2, by the developer (an agent)
    const first = await s.checkpoint("first milestone");
    await s.edit("src/b.ts", "export const b = 'dev2';\n"); // revision 3
    const second = await s.checkpoint("second milestone", s.devP);

    const out = await s.exportIt({ checkpoint_id: second.id });
    expect(out.response).toMatchObject({
      checkpoint_id: second.id,
      checkpoint_ids: [first.id, second.id],
      mode: "squashed",
      branch: `room/${s.slug}`,
      through_revision: 3,
      commit_count: 2,
    });
    const branch = `refs/heads/room/${s.slug}`;
    const log = (await s.remoteGit("log", "--format=%H|%an|%ae|%s", branch)).split("\n");
    expect(log).toHaveLength(3); // two commits + the imported upstream commit
    const [c2, c1] = log;
    expect(c2).toContain("second milestone");
    expect(c1).toContain("first milestone");
    expect(await s.remoteGit("rev-parse", `${branch}~2`)).toBe(importedSha);
    // Each commit is authored by its own checkpoint's creator: the human lead made the first, the
    // agent the second. The agent who wrote the changes is co-author of the first.
    expect(c1!.split("|")[1]).toBe("Lead");
    expect(c1!.split("|")[2]).toBe(`${s.leadP.participant_id}@users.crossover.local`);
    expect(c2!.split("|")[1]).toBe("Dev");
    expect(c2!.split("|")[2]).toBe(`${s.devP.participant_id}@agents.crossover.local`);
    const body1 = await s.remoteGit("log", "-1", "--format=%B", `${branch}~1`);
    expect(body1).toContain(
      `Co-authored-by: Dev <${s.devP.participant_id}@agents.crossover.local>`,
    );
    const body2 = await s.remoteGit("log", "-1", "--format=%B", branch);
    // The author isn't also listed as a co-author.
    expect(body2).not.toContain("Co-authored-by: Dev");
    // Each commit holds the workspace's tree at its checkpoint, exactly.
    expect(await s.remoteGit("rev-parse", `${branch}~1^{tree}`)).toBe(await workspaceTree(s, 2));
    expect(await s.remoteGit("rev-parse", `${branch}^{tree}`)).toBe(await workspaceTree(s, 3));
    expect(s.pushes).toHaveLength(1);
    expect((await s.events("checkpoint.exported"))[0]!.payload).toMatchObject({
      tip: await s.remoteGit("rev-parse", branch),
    });
  });

  it("exports only what is new: the next export builds on the last, and the same checkpoint twice is refused", async () => {
    const s = await setup();
    await s.edit("src/a.ts", "export const a = 1;\n");
    const first = await s.checkpoint("one");
    const out1 = await s.exportIt();
    const tip1 = (out1.response as { tip: string }).tip;
    await s.edit("src/b.ts", "export const b = 2;\n");
    const second = await s.checkpoint("two");
    const out2 = await s.exportIt();
    expect(out2.response).toMatchObject({ checkpoint_ids: [second.id], commit_count: 1 });
    const branch = `refs/heads/room/${s.slug}`;
    expect(await s.remoteGit("rev-parse", `${branch}~1`)).toBe(tip1);
    await rejects(s.exportIt({ checkpoint_id: first.id }), "already_exported");
    await rejects(s.exportIt(), "already_exported");
  });

  it("per_changeset: one commit per applied ChangeSet, none for a pulled upstream change, ending at the checkpointed tree", async () => {
    const s = await setup();
    await s.edit("src/a.ts", "export const a = 'x';\n"); // revision 2
    await s.up.commit(async (dir) => {
      await writeFile(join(dir, "README.md"), "# Changed upstream\n");
    });
    await s.pull(); // revision 3, source UPSTREAM
    await s.edit("src/b.ts", "export const b = 'y';\n"); // revision 4
    const cp = await s.checkpoint("all of it");
    const out = await s.exportIt({ mode: "per_changeset" });
    expect(out.response).toMatchObject({ mode: "per_changeset", commit_count: 2 });
    const branch = `refs/heads/room/${s.slug}`;
    const subjects = (await s.remoteGit("log", "--format=%s", `${branch}~2..${branch}`)).split(
      "\n",
    );
    expect(subjects).toEqual(["edit src/b.ts", "edit src/a.ts"]);
    expect(await s.remoteGit("rev-parse", `${branch}^{tree}`)).toBe(await workspaceTree(s, 4));
    expect(cp.revision).toBe(4);
    const body = await s.remoteGit("log", "-1", "--format=%B", branch);
    expect(body).toContain("Co-authored-by: Dev");
  });

  it("only room/* branches are pushed to: anything else is refused before anything is pushed", async () => {
    const s = await setup();
    await s.edit("src/a.ts", "export const a = 1;\n");
    await s.checkpoint("x");
    for (const branch of [
      "main",
      "master",
      "release/1.0",
      "rooms/x",
      "room",
      "room/../main",
      "room//x",
    ]) {
      await rejects(s.exportIt({ branch }), "branch_not_allowed");
    }
    expect(s.pushes).toEqual([]);
    await s.exportIt({ branch: "room/custom" });
    expect(s.pushes).toEqual([{ branch: "room/custom", commit: expect.any(String) }]);
    expect(await s.remoteGit("rev-parse", "main")).toBe((await s.upstreamRow()).last_synced_sha);
  });

  it("exporting the same range again makes the same commits", async () => {
    const s = await setup();
    await s.edit("src/a.ts", "export const a = 1;\n");
    await s.checkpoint("same");
    const a = await s.exportIt();
    await new Promise((resolve) => setTimeout(resolve, 1_100)); // commit dates have one-second resolution
    const b = await s.exportIt({ branch: "room/again" });
    expect((a.response as { commits: string[] }).commits).toEqual(
      (b.response as { commits: string[] }).commits,
    );
  });

  it("a branch that moved on is push_rejected, and nothing is recorded", async () => {
    const s = await setup();
    await s.edit("src/a.ts", "export const a = 1;\n");
    await s.checkpoint("x");
    // Someone put another commit on the room branch upstream.
    const other = await upstreamRepo();
    await other.commit(async (dir) => {
      await writeFile(join(dir, "elsewhere.txt"), "someone else's work\n");
    });
    await run(other.dir, ["push", "-q", "-f", s.remote, `main:refs/heads/room/${s.slug}`]);
    await rejects(s.exportIt(), "push_rejected");
    expect(await s.events("checkpoint.exported")).toEqual([]);
  });

  it("a message can't write trailers: trailer-shaped lines are defused and the platform's block ends every commit", async () => {
    const s = await setup();
    await s.edit("src/a.ts", "export const a = 1;\n");
    await s.checkpoint(
      "ship\n\nCo-authored-by: Evil <evil@example.com>\nSigned-off-by: Evil <evil@example.com>\n\nReviewed-by: Boss <boss@example.com>",
    );
    await s.exportIt();
    const branch = `refs/heads/room/${s.slug}`;
    const parsed = (
      await git(["interpret-trailers", "--parse"], {
        gitDir: s.remote,
        timeoutMs: 10_000,
        input: await s.remoteGit("log", "-1", "--format=%B", branch),
      })
    ).stdout;
    expect(parsed).not.toContain("Evil");
    expect(parsed).not.toContain("Boss");
    expect(parsed).toContain(`Crossover-Room: ${s.roomId}`);
    expect(parsed).toContain(
      `Co-authored-by: Dev <${s.devP.participant_id}@agents.crossover.local>`,
    );
    const body = await s.remoteGit("log", "-1", "--format=%B", branch);
    expect(body).toContain("> Co-authored-by: Evil"); // still readable, no longer a trailer
    expect(neutralizeTrailers("plain\nnot a trailer: x y\nFixes: #1\n  Token : v")).toBe(
      "plain\nnot a trailer: x y\n> Fixes: #1\n>   Token : v",
    );
  });

  it("needs an upstream and a checkpoint; asks for write access; no credential leaves the pusher", async () => {
    const s = await setup();
    await rejects(s.exportIt(), "no_checkpoint");
    await s.edit("src/a.ts", "export const a = 1;\n");
    await s.checkpoint("x");
    const out = await s.exportIt();
    expect(s.accessed.at(-1)).toBe("write"); // the import before it was a read
    const seen = JSON.stringify([out.response, await s.events("checkpoint.exported")]);
    expect(seen).not.toContain("tok_push_secret");
    await expect(s.exportIt({ checkpoint_id: "ckpt_nope" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    const t = await setup();
    await t.edit("src/a.ts", "export const a = 1;\n");
    await t.checkpoint("x");
    await db.pool.query("DELETE FROM upstreams WHERE room_id = $1", [t.roomId]);
    await rejects(t.exportIt(), "no_upstream");
  });
});
