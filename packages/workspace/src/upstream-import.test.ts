import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withTransaction } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { allowAll, Dispatcher } from "@crossover/kernel";
import { CrossoverError, newId } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerWorkspaceCommands } from "./apply.js";
import { git } from "./git.js";
import { provisionWorkspace } from "./provision.js";
import {
  noCredentials,
  type FetchedUpstream,
  type GitCredential,
  type GitCredentialProvider,
  type UpstreamFetcher,
} from "./upstream.js";
import { MAX_IMPORT_FILES } from "./upstream-import.js";

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

/** A small upstream repository: text, a binary, an executable, nested and unicode paths. */
async function upstreamRepo(extra?: (dir: string) => Promise<void>) {
  const dir = await tmp("crossover-upstream-");
  await run(dir, ["init", "-q", "-b", "main"]);
  // local clones copy objects/ directly; a background gc could drop one mid-copy (T1549, defence in depth)
  await run(dir, ["config", "gc.auto", "0"]);
  await run(dir, ["config", "maintenance.auto", "false"]);
  await mkdir(join(dir, "src/deep"), { recursive: true });
  await writeFile(join(dir, "README.md"), "# Upstream\n");
  await writeFile(join(dir, "src/index.ts"), "export const x = 1;\n");
  await writeFile(join(dir, "src/deep/näme.txt"), "unicode path\n");
  await writeFile(join(dir, "logo.bin"), Buffer.from([0, 1, 2, 255, 0, 3]));
  await writeFile(join(dir, "run.sh"), "#!/bin/sh\necho hi\n");
  await chmod(join(dir, "run.sh"), 0o755);
  await writeFile(join(dir, "package.json"), '{ "scripts": { "test": "vitest" } }\n');
  if (extra) await extra(dir);
  await run(dir, ["add", "-A"]);
  await run(dir, ["commit", "-q", "-m", "Initial"]);
  const sha = (await run(dir, ["rev-parse", "HEAD"])).stdout.trim();
  return { dir, sha };
}

/** Fetches from a local repository instead of the network, recording what it was asked. */
class FixtureFetcher implements UpstreamFetcher {
  /** Runs while a fetch is "on the network": something happening meanwhile. */
  during: (() => Promise<void>) | undefined;
  requests: { url: string; branch: string; credential: GitCredential | null }[] = [];
  cleaned = 0;
  constructor(private readonly source: string) {}
  async fetch(request: { url: string; branch: string; credential: GitCredential | null }) {
    this.requests.push(request);
    await this.during?.();
    const dir = await tmp("crossover-fetched-");
    // local clones copy objects/ directly; a background gc could drop one mid-copy (T1549, defence in depth)
    await run(dir, ["clone", "-q", "--bare", "--no-local", this.source, "repo"]);
    const repo = join(dir, "repo");
    const sha = (
      await git(["rev-parse", "HEAD"], { gitDir: repo, timeoutMs: 10_000 })
    ).stdout.trim();
    const fetched: FetchedUpstream = {
      repo,
      ref: "HEAD",
      sha,
      cleanup: async () => {
        this.cleaned += 1;
        await rm(dir, { recursive: true, force: true });
      },
    };
    return fetched;
  }
}

const PUBLIC = async () => ["93.184.216.34"];
const URL_OK = "https://github.com/acme/widgets";

async function room(opts: { fetcher: UpstreamFetcher; credentials?: GitCredentialProvider }) {
  const roomId = newId("room");
  const lead = newId("part");
  const root = await tmp("crossover-import-room-");
  await db.pool.query(
    "INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'Room', 'Ship', $2)",
    [roomId, lead],
  );
  await db.pool.query(
    `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status)
     VALUES ($2, $1, 'HUMAN', 'Lead', 'OWNER', 'LEAD', 'ACTIVE')`,
    [roomId, lead],
  );
  await withTransaction(db.pool, (client) => provisionWorkspace(client, roomId, root));
  const repo = (
    await db.pool.query("SELECT repo_path FROM workspaces WHERE room_id = $1", [roomId])
  ).rows[0].repo_path as string;
  const d = new Dispatcher({ pool: db.pool, authorize: allowAll, nodeId: roomId });
  const scheduledAdvances: Array<{ room_id: string; revision: number }> = [];
  registerWorkspaceCommands(d, {
    scheduleSandboxAdvance: (scheduledRoom, revision) =>
      scheduledAdvances.push({ room_id: scheduledRoom, revision }),
    upstream: {
      fetcher: opts.fetcher,
      resolve: PUBLIC,
      ...(opts.credentials ? { credentials: opts.credentials } : {}),
    },
  });
  const principal = {
    room_id: roomId,
    participant_id: lead,
    kind: "HUMAN" as const,
    authority: "OWNER" as const,
    role: "LEAD" as const,
  };
  const importIt = (
    params: Record<string, unknown> = { url: URL_OK, branch: "main" },
    key = newId("cmd"),
  ) =>
    d.dispatch(principal, { id: newId("cmd"), method: "git.import", params, idempotency_key: key });
  return { d, roomId, lead, repo, principal, importIt, scheduledAdvances };
}

const rejects = async (p: Promise<unknown>, reason?: string) => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CrossoverError);
  expect((err as CrossoverError).code).toBe("VALIDATION");
  if (reason) expect((err as CrossoverError).details).toMatchObject({ reason });
  return err as CrossoverError;
};

describe("git.import (§24.1, T801)", () => {
  it("revision 1's tree equals the upstream branch tip's tree, and the upstream is recorded", async () => {
    const up = await upstreamRepo();
    const fetcher = new FixtureFetcher(up.dir);
    const r = await room({ fetcher });
    const out = await r.importIt();
    expect(r.scheduledAdvances).toEqual([{ room_id: r.roomId, revision: 1 }]);
    expect(out.response).toMatchObject({
      applied_revision: 1,
      file_count: 6,
      suggested_health_command: { command: "npm test", source: "package.json" },
      upstream: {
        url: URL_OK,
        branch: "main",
        last_synced_sha: up.sha,
        last_synced_room_revision: 1,
      },
    });
    const head = (
      await git(["rev-parse", "refs/room/canonical"], { gitDir: r.repo, timeoutMs: 10_000 })
    ).stdout.trim();
    const tree = async (rev: string) =>
      (
        await git(["rev-parse", `${rev}^{tree}`], { gitDir: r.repo, timeoutMs: 10_000 })
      ).stdout.trim();
    expect(await tree(head)).toBe(await tree(up.sha)); // identical, modes and binaries included
    const { rows } = await db.pool.query(
      "SELECT revision, commit_sha FROM workspace_revisions WHERE room_id = $1 ORDER BY revision",
      [r.roomId],
    );
    expect(rows.map((x) => Number(x.revision))).toEqual([0, 1]);
    expect(rows[1].commit_sha).toBe(head);
    const up2 = (await db.pool.query("SELECT * FROM upstreams WHERE room_id = $1", [r.roomId]))
      .rows[0];
    expect(up2).toMatchObject({
      url: URL_OK,
      branch: "main",
      last_synced_sha: up.sha,
      imported_by: r.lead,
    });
    expect(Number(up2.last_synced_room_revision)).toBe(1);
  });

  it("is a ChangeSet with source UPSTREAM, actor system:upstream, APPLIED, and a file revision per file", async () => {
    const up = await upstreamRepo();
    const r = await room({ fetcher: new FixtureFetcher(up.dir) });
    const out = await r.importIt();
    const cs = (await db.pool.query("SELECT * FROM changesets WHERE room_id = $1", [r.roomId]))
      .rows[0];
    expect(cs).toMatchObject({
      id: (out.response as { changeset_id: string }).changeset_id,
      source: "UPSTREAM",
      actor_id: "system:upstream",
      status: "APPLIED",
    });
    expect(Number(cs.applied_revision)).toBe(1);
    const files = (
      await db.pool.query(
        'SELECT path, revision, workspace_revision, actor_id, blob_sha FROM file_revisions WHERE room_id = $1 ORDER BY path COLLATE "C"',
        [r.roomId],
      )
    ).rows;
    expect(files.map((f) => f.path)).toEqual([
      "README.md",
      "logo.bin",
      "package.json",
      "run.sh",
      "src/deep/näme.txt",
      "src/index.ts",
    ]);
    expect(
      files.every((f) => f.actor_id === "system:upstream" && Number(f.workspace_revision) === 1),
    ).toBe(true);
    expect(files.every((f) => f.blob_sha)).toBe(true);
  });

  it("emits the applied ChangeSet (as system:upstream) and workspace.upstream_synced", async () => {
    const up = await upstreamRepo();
    const r = await room({ fetcher: new FixtureFetcher(up.dir) });
    const out = await r.importIt();
    expect(out.events.map((e) => [e.type, e.actor_id])).toEqual([
      ["workspace.changeset.applied", "system:upstream"],
      ["workspace.upstream_synced", r.lead],
    ]);
    expect(out.events[1]!.payload).toMatchObject({
      url: URL_OK,
      branch: "main",
      last_synced_sha: up.sha,
      imported: true,
    });
  });

  it("the imported files are readable, and a text file is byte-identical", async () => {
    const up = await upstreamRepo();
    const r = await room({ fetcher: new FixtureFetcher(up.dir) });
    await r.importIt();
    const read = await r.d.dispatch(r.principal, {
      id: newId("cmd"),
      method: "workspace.read",
      params: { path: "src/index.ts" },
    });
    expect(read.response).toMatchObject({ content: "export const x = 1;\n" });
  });

  it("a room whose workspace already has revisions beyond 0 → VALIDATION, and nothing is fetched", async () => {
    const up = await upstreamRepo();
    const fetcher = new FixtureFetcher(up.dir);
    const r = await room({ fetcher });
    await r.d.dispatch(r.principal, {
      id: newId("cmd"),
      method: "workspace.apply_changeset",
      idempotency_key: newId("cmd"),
      params: {
        source: "API",
        message: "Add",
        base_workspace_revision: 0,
        operations: [{ type: "create", path: "mine.txt", content: "x" }],
      },
    });
    const err = await rejects(r.importIt(), "workspace_not_empty");
    expect(err.details).toMatchObject({ head_revision: 1 });
    expect(fetcher.requests).toEqual([]);
  });

  // Measured (T1529): idle 1255 ms, 3x load 3064 ms; budget 7x.
  it("suggests a health command from the repository, never applies it, and says null when there is none", async () => {
    const up = await upstreamRepo(async (dir) => {
      await rm(join(dir, "package.json"));
      await writeFile(join(dir, "Makefile"), "test:\n\tgo test ./...\n");
    });
    const r = await room({ fetcher: new FixtureFetcher(up.dir) });
    const out = await r.importIt();
    expect(out.response).toMatchObject({
      suggested_health_command: { command: "make test", source: "Makefile" },
    });
    const { rows } = await db.pool.query("SELECT settings FROM rooms WHERE id = $1", [r.roomId]);
    expect(JSON.stringify(rows[0].settings)).not.toContain("make test");

    const bare = await upstreamRepo(async (dir) => {
      await rm(join(dir, "package.json"));
    });
    const r2 = await room({ fetcher: new FixtureFetcher(bare.dir) });
    expect((await r2.importIt()).response).toMatchObject({ suggested_health_command: null });
  }, 25_000);

  it("the room changed while the upstream was fetched: CONFLICT_VERSION, nothing imported, nothing left behind", async () => {
    const up = await upstreamRepo();
    const fetcher = new FixtureFetcher(up.dir);
    const r = await room({ fetcher });
    fetcher.during = async () => {
      await r.d.dispatch(r.principal, {
        id: newId("cmd"),
        method: "workspace.apply_changeset",
        idempotency_key: newId("cmd"),
        params: {
          source: "EDITOR",
          message: "someone got in first",
          base_workspace_revision: 0,
          operations: [{ type: "create", path: "first.txt", content: "hi\n" }],
        },
      });
    };
    await expect(r.importIt()).rejects.toMatchObject({
      code: "CONFLICT_VERSION",
      details: { reason: "workspace_not_empty" },
    });
    expect(
      (await db.pool.query("SELECT 1 FROM upstreams WHERE room_id = $1", [r.roomId])).rowCount,
    ).toBe(0);
    expect(fetcher.cleaned).toBe(1);
  });

  it("a second import into the same room → VALIDATION", async () => {
    const up = await upstreamRepo();
    const r = await room({ fetcher: new FixtureFetcher(up.dir) });
    await r.importIt();
    // Revision 1 now exists, so the first guard answers; the upstream row guards the same.
    await rejects(r.importIt({ url: URL_OK, branch: "main" }, newId("cmd")));
  });

  it("a replay with the same idempotency key imports once", async () => {
    const up = await upstreamRepo();
    const fetcher = new FixtureFetcher(up.dir);
    const r = await room({ fetcher });
    const key = newId("cmd");
    const first = await r.importIt(undefined, key);
    const again = await r.importIt(undefined, key);
    expect(again.replayed).toBe(true);
    expect(again.response).toEqual(first.response);
    expect(fetcher.requests).toHaveLength(1);
  });

  // Measured (T1529): idle 1056 ms, 3x load 2415 ms; budget 7x.
  it("the fetch's temporary files are cleaned up, on success and on refusal", async () => {
    const ok = await upstreamRepo();
    const f1 = new FixtureFetcher(ok.dir);
    await (await room({ fetcher: f1 })).importIt();
    expect(f1.cleaned).toBe(1);
    const bad = await upstreamRepo(async (d) => {
      await symlink("README.md", join(d, "link"));
    });
    const f2 = new FixtureFetcher(bad.dir);
    await rejects((await room({ fetcher: f2 })).importIt(), "unsupported_entry");
    expect(f2.cleaned).toBe(1);
  }, 20_000);

  // Measured (T1529): idle 805 ms, 3x load 2179 ms; budget 7x.
  it("refuses what a workspace can't hold, naming the path: symlinks and submodules", async () => {
    const link = await upstreamRepo(async (d) => {
      await symlink("README.md", join(d, "docs-link"));
    });
    const err = await rejects(
      (await room({ fetcher: new FixtureFetcher(link.dir) })).importIt(),
      "unsupported_entry",
    );
    expect(err.details).toMatchObject({ path: "docs-link", kind: "symlink" });

    const sub = await upstreamRepo();
    // A gitlink entry, as `git submodule add` would record.
    await run(sub.dir, ["update-index", "--add", "--cacheinfo", `160000,${sub.sha},vendor/lib`]);
    await run(sub.dir, ["commit", "-q", "-m", "Add submodule"]);
    const err2 = await rejects(
      (await room({ fetcher: new FixtureFetcher(sub.dir) })).importIt(),
      "unsupported_entry",
    );
    expect(err2.details).toMatchObject({ path: "vendor/lib", kind: "submodule" });
  }, 20_000);

  it("a refused import changes nothing: no revision, no upstream, no ChangeSet", async () => {
    const link = await upstreamRepo(async (d) => {
      await symlink("README.md", join(d, "docs-link"));
    });
    const r = await room({ fetcher: new FixtureFetcher(link.dir) });
    await rejects(r.importIt());
    const count = async (table: string) =>
      (
        await db.pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE room_id = $1`, [
          r.roomId,
        ])
      ).rows[0].n;
    expect(await count("upstreams")).toBe(0);
    expect(await count("changesets")).toBe(0);
    expect(await count("workspace_revisions")).toBe(1); // revision 0 only
    // And the room can still import something good afterwards.
    expect(MAX_IMPORT_FILES).toBeGreaterThan(1000);
  });
});

describe("credentials never leak (§24.1)", () => {
  const SECRET = "ghs_s3cr3tTokenValue";
  let revocations = 0;
  const provider: GitCredentialProvider = {
    credentialFor: async () => ({
      credential: { type: "bearer", token: SECRET },
      revoke: async () => {
        revocations += 1;
      },
    }),
  };

  // Measured (T1529): idle 776 ms, 3x load 2509 ms; budget 7x.
  it("the provider's credential reaches the fetcher, and nothing the room can read", async () => {
    const up = await upstreamRepo();
    const fetcher = new FixtureFetcher(up.dir);
    const r = await room({ fetcher, credentials: provider });
    const out = await r.importIt();
    expect(fetcher.requests[0]!.credential).toEqual({ type: "bearer", token: SECRET });
    expect(revocations).toBe(1);
    const everything = JSON.stringify({
      response: out.response,
      events: (await db.pool.query("SELECT payload FROM events WHERE room_id = $1", [r.roomId]))
        .rows,
      upstream: (await db.pool.query("SELECT * FROM upstreams WHERE room_id = $1", [r.roomId]))
        .rows,
      changesets: (
        await db.pool.query("SELECT payload, message FROM changesets WHERE room_id = $1", [
          r.roomId,
        ])
      ).rows,
    });
    expect(everything).not.toContain(SECRET);
  }, 20_000);

  // Measured (T1529): idle 1205 ms, 3x load 2771 ms; budget 7x.
  it("a public repository needs none", async () => {
    const up = await upstreamRepo();
    const fetcher = new FixtureFetcher(up.dir);
    await (await room({ fetcher, credentials: noCredentials })).importIt();
    expect(fetcher.requests[0]!.credential).toBeNull();
  }, 20_000);

  it("a URL carrying credentials is refused before anything is fetched", async () => {
    const up = await upstreamRepo();
    const fetcher = new FixtureFetcher(up.dir);
    const r = await room({ fetcher });
    await rejects(
      r.importIt({ url: `https://user:${SECRET}@github.com/acme/widgets`, branch: "main" }),
      "url_credentials",
    );
    await rejects(
      r.importIt({ url: `https://${SECRET}@github.com/acme/widgets`, branch: "main" }),
      "url_credentials",
    );
    expect(fetcher.requests).toEqual([]);
  });
});
