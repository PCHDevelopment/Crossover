import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withTransaction } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { allowAll, Dispatcher, type Authorizer } from "@crossover/kernel";
import { CrossoverError, newId } from "@crossover/protocol";
import { afterAll, beforeAll, expect, it } from "vitest";
import { registerWorkspaceCommands, type WorkspaceCommandDeps } from "./apply.js";
import { provisionWorkspace } from "./provision.js";
import type { Operation } from "./operations.js";

let db: TestDatabase;
const dirs: string[] = [];
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
  const root = await mkdtemp(join(tmpdir(), "crossover-search-command-"));
  dirs.push(root);
  await db.pool.query(
    "INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1,$1,'Room','Ship',$2)",
    [room, actor],
  );
  await db.pool.query(
    `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status)
     VALUES ($1, $2, 'HUMAN', 'Actor', 'OWNER', 'LEAD', 'ACTIVE')`,
    [actor, room],
  );
  const workspace = await withTransaction(db.pool, (client) =>
    provisionWorkspace(client, room, root),
  );
  const repo = (await db.pool.query("SELECT repo_path FROM workspaces WHERE room_id = $1", [room]))
    .rows[0].repo_path as string;
  const options = { gitDir: repo, timeoutMs: 10_000 };
  const dispatcher = new Dispatcher({ pool: db.pool, authorize, nodeId: room });
  registerWorkspaceCommands(dispatcher, deps);
  const principal = {
    room_id: room,
    participant_id: actor,
    kind: "HUMAN" as const,
    authority: "OWNER" as const,
    role: "LEAD" as const,
  };
  const dispatch = (method: string, params: Record<string, unknown>, mutating = false) =>
    dispatcher.dispatch(principal, {
      id: newId("cmd"),
      method,
      params,
      ...(mutating ? { idempotency_key: newId("cmd") } : {}),
    });
  const apply = (operations: Operation[], base = 0) =>
    dispatch(
      "workspace.apply_changeset",
      {
        source: "API",
        message: "Edit",
        base_workspace_revision: base,
        operations,
      },
      true,
    );
  return { room, workspace, repo, options, dispatch, apply };
}

// Measured (T1529): idle 1890 ms, 3x load 4977 ms; budget 7x.
it("sees changes immediately, refreshes after commit, and repairs a lagging cache without trusting refs", async () => {
  const f = await fixture();
  await f.apply([{ type: "create", path: "file", content: "old needle\n" }]);
  expect(
    await (await import("node:fs/promises")).readFile(`${f.repo}.search/tree/file`, "utf8"),
  ).toBe("old needle\n");
  expect((await f.dispatch("workspace.search", { query: "needle" })).response).toEqual({
    workspace_revision: 1,
    matches: [{ path: "file", line: 1, text: "old needle" }],
    truncated: false,
  });
  await f.apply([{ type: "modify", path: "file", content: "new needle\n" }], 1);
  expect(
    (await f.dispatch("workspace.search", { query: "new needle", revision: 2 })).response,
  ).toMatchObject({ workspace_revision: 2, matches: [{ text: "new needle" }] });
  const lagging = await fixture(allowAll, {
    updateCanonicalRef: async () => {},
    refreshSearchTree: async () => {},
  });
  await lagging.apply([{ type: "create", path: "file", content: "fresh needle" }]);
  expect((await lagging.dispatch("workspace.search", { query: "needle" })).response).toMatchObject({
    workspace_revision: 1,
    matches: [{ text: "fresh needle" }],
  });
  await lagging.apply([{ type: "delete", path: "file" }], 1);
  expect((await lagging.dispatch("workspace.search", { query: "needle" })).response).toEqual({
    workspace_revision: 2,
    matches: [],
    truncated: false,
  });
}, 35_000);

it("authorizes distinct matched paths once and silently excludes forbidden paths", async () => {
  const paths: string[] = [];
  const f = await fixture(async (_principal, action, resource) => {
    if (action === "workspace.read" && resource?.path) {
      const path = resource.path as string;
      paths.push(path);
      if (path === "private") throw new CrossoverError("FORBIDDEN", "Denied");
    }
  });
  await f.apply([
    { type: "create", path: "private", content: "needle\nneedle\n" },
    { type: "create", path: ".public", content: "needle\nneedle\n" },
  ]);
  const result = await f.dispatch("workspace.search", { query: "needle" });
  expect(result.events).toEqual([]);
  expect(result.response).toEqual({
    workspace_revision: 1,
    matches: [
      { path: ".public", line: 1, text: "needle" },
      { path: ".public", line: 2, text: "needle" },
    ],
    truncated: false,
  });
  expect(paths.sort()).toEqual([".public", "private"]);
  const other = await fixture();
  expect((await other.dispatch("workspace.search", { query: "needle" })).response).toEqual({
    workspace_revision: 0,
    matches: [],
    truncated: false,
  });
});

it("supports literal defaults, regex, case sensitivity and globs; rejects non-head revisions and malformed inputs", async () => {
  const f = await fixture();
  await f.apply([
    { type: "create", path: "file.txt", content: "needle.*\nNEEDLE.*\nneedle other\n" },
    { type: "create", path: "other.js", content: "needle.*\n" },
  ]);
  expect(
    (await f.dispatch("workspace.search", { query: "needle.*", glob: "*.txt" })).response,
  ).toMatchObject({ matches: [{ line: 1, text: "needle.*" }] });
  expect(
    (
      await f.dispatch("workspace.search", {
        query: "^needle",
        regex: true,
        case_sensitive: false,
        glob: "*.txt",
      })
    ).response,
  ).toMatchObject({ matches: [{ line: 1 }, { line: 2 }, { line: 3 }] });
  await expect(
    f.dispatch("workspace.search", { query: "needle", revision: 0 }),
  ).rejects.toMatchObject({ code: "VALIDATION", details: { reason: "search_head_only" } });
  for (const params of [
    { query: "" },
    { query: "a\0" },
    { query: "needle", regex: "true" },
    { query: "[", regex: true },
    { query: "needle", glob: "[" },
  ])
    await expect(f.dispatch("workspace.search", params)).rejects.toMatchObject({
      code: "VALIDATION",
    });
});

// Measured (T1529): idle 2870 ms, 3x load 3407 ms; budget 7x.
it("caps match counts and Unicode line previews without splitting characters", async () => {
  const f = await fixture();
  await f.apply([{ type: "create", path: "file", content: "needle\n".repeat(201) }]);
  const result = (await f.dispatch("workspace.search", { query: "needle" })).response as {
    matches: { text: string; text_truncated?: true }[];
    truncated: boolean;
  };
  expect(result.matches).toHaveLength(200);
  expect(result.truncated).toBe(true);
  await f.apply([{ type: "create", path: "unicode", content: "unique" + "😀".repeat(1000) }], 1);
  const preview = (await f.dispatch("workspace.search", { query: "unique" }))
    .response as typeof result;
  expect(preview.matches[0]!.text).toBe("unique" + "😀".repeat(494));
  expect(preview.matches[0]!.text_truncated).toBe(true);
  expect(preview.truncated).toBe(false);
  await f.apply([{ type: "modify", path: "unicode", content: "unique" + "😀".repeat(494) }], 2);
  const exactPreview = (await f.dispatch("workspace.search", { query: "unique" }))
    .response as typeof result;
  expect(exactPreview.matches[0]).not.toHaveProperty("text_truncated");
  expect(exactPreview.truncated).toBe(false);
  await f.apply([{ type: "modify", path: "unicode", content: "unique\n".repeat(200) }], 3);
  const exactMatches = (await f.dispatch("workspace.search", { query: "unique" }))
    .response as typeof result;
  expect(exactMatches.matches).toHaveLength(200);
  expect(exactMatches.truncated).toBe(false);
}, 25_000);

it("caps the complete UTF-8 response at one MiB even with long paths and Unicode previews", async () => {
  const f = await fixture();
  const prefix = Array.from({ length: 18 }, (_, index) => `${index}`.padEnd(195, "x")).join("/");
  await f.apply(
    Array.from({ length: 195 }, (_, index) => ({
      type: "create" as const,
      path: `${prefix}/file${index}`,
      content: "needle" + "😀".repeat(494),
    })),
  );
  const response = (await f.dispatch("workspace.search", { query: "needle" })).response as {
    matches: unknown[];
    truncated: boolean;
  };
  expect(response.matches.length).toBeLessThan(195);
  expect(response.truncated).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(1024 * 1024);
}, 20_000);
