import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { authorize } from "@crossover/policy";
import { CrossoverError, newId } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Dispatcher, type Authorizer } from "../../dispatcher.js";
import type { Principal } from "../../principal.js";

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

async function reviewerWithGrant(capability: string): Promise<{ room: string; who: Principal }> {
  const room = newId("room");
  const id = newId("part");
  await pool.query(
    `INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'n', 'o', $2)`,
    [room, id],
  );
  await pool.query(
    `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status)
     VALUES ($1, $2, 'AGENT', 'r', 'MEMBER', 'REVIEWER', 'ACTIVE')`,
    [id, room],
  );
  await pool.query(
    `INSERT INTO capability_grants (id, room_id, participant_id, effect, capability, created_by, created_at)
     VALUES ($1, $2, $3, 'GRANT', $4, $3, clock_timestamp())`,
    [newId("grant"), room, id, capability],
  );
  return {
    room,
    who: {
      participant_id: id,
      room_id: room,
      kind: "AGENT",
      authority: "MEMBER",
      role: "REVIEWER",
    },
  };
}

/** A command that, like workspace.apply_changeset, authorizes every path it touches. */
function register(
  d: Dispatcher,
  method: "workspace.apply_changeset" | "workspace.search",
  flagged: boolean,
) {
  d.registerCommand({
    method,
    action: method === "workspace.search" ? "workspace.read" : "workspace.write",
    mutating: method === "workspace.apply_changeset",
    ...(method === "workspace.apply_changeset"
      ? {}
      : { view: "none" as const, view_reason: "test fixture" }),
    ...(flagged ? { perPathAuthorize: true } : {}),
    params: z.object({ paths: z.array(z.string()) }),
    execute: async (ctx, params) => {
      const action = method === "workspace.search" ? "workspace.read" : "workspace.write";
      for (const path of params.paths) await ctx.authorize(action, { path });
      return { response: { touched: params.paths } };
    },
  });
}

describe("perPathAuthorize (T218)", () => {
  it("lets a reviewer with workspace.write:docs/** apply a ChangeSet touching docs/ only", async () => {
    const { who } = await reviewerWithGrant("workspace.write:docs/**");
    const d = new Dispatcher({ pool, authorize, nodeId: `node-${++n}` });
    register(d, "workspace.apply_changeset", true);
    const ok = await d.dispatch(
      who,
      cmd("workspace.apply_changeset", { paths: ["docs/a.md", "docs/x/b.md"] }),
    );
    expect(ok.response).toEqual({ touched: ["docs/a.md", "docs/x/b.md"] });
    for (const paths of [["src/a.ts"], ["docs/a.md", "src/a.ts"], ["docs"], ["DOCS/a.md"]]) {
      const err = await d
        .dispatch(who, cmd("workspace.apply_changeset", { paths }))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CrossoverError);
      expect((err as CrossoverError).code).toBe("FORBIDDEN");
    }
  });

  it("an unflagged command is still refused at the gate", async () => {
    const { who } = await reviewerWithGrant("workspace.write:docs/**");
    const d = new Dispatcher({ pool, authorize, nodeId: `node-${++n}` });
    register(d, "workspace.apply_changeset", false);
    const err = await d
      .dispatch(who, cmd("workspace.apply_changeset", { paths: ["docs/a.md"] }))
      .catch((e: unknown) => e);
    expect((err as CrossoverError).code).toBe("FORBIDDEN");
    expect((err as CrossoverError).details).toMatchObject({
      missing_capability: "workspace.write",
    });
  });

  it("a scoped grant of another capability doesn't open the gate", async () => {
    const { who } = await reviewerWithGrant("workspace.read:docs/**");
    const d = new Dispatcher({ pool, authorize, nodeId: `node-${++n}` });
    register(d, "workspace.apply_changeset", true);
    const err = await d
      .dispatch(who, cmd("workspace.apply_changeset", { paths: ["docs/a.md"] }))
      .catch((e: unknown) => e);
    expect((err as CrossoverError).code).toBe("FORBIDDEN");
  });

  it("works for reads too (the gate is for mutating and read commands alike)", async () => {
    // A reviewer's bundle already reads everything; use a grant of write to show a read gate
    // is evaluated with the same flag.
    const { who } = await reviewerWithGrant("workspace.write:docs/**");
    const d = new Dispatcher({ pool, authorize, nodeId: `node-${++n}` });
    register(d, "workspace.search", true);
    const ok = await d.dispatch(who, cmd("workspace.search", { paths: ["src/a.ts"] }));
    expect(ok.response).toEqual({ touched: ["src/a.ts"] });
  });

  it("passes the flag to the gate only, not to the per-path checks", async () => {
    const seen: { action: string; path: unknown; perPath: boolean | undefined }[] = [];
    const spy: Authorizer = async (_p, action, resource, context) => {
      seen.push({ action, path: resource.path, perPath: context.perPath });
    };
    const d = new Dispatcher({ pool, authorize: spy, nodeId: `node-${++n}` });
    register(d, "workspace.apply_changeset", true);
    register(d, "workspace.search", false);
    const { who } = await reviewerWithGrant("workspace.write");
    await d.dispatch(who, cmd("workspace.apply_changeset", { paths: ["a"] }));
    await d.dispatch(who, cmd("workspace.search", { paths: ["b"] }));
    expect(seen).toEqual([
      { action: "workspace.write", path: undefined, perPath: true },
      { action: "workspace.write", path: "a", perPath: undefined },
      { action: "workspace.read", path: undefined, perPath: undefined },
      { action: "workspace.read", path: "b", perPath: undefined },
    ]);
    vi.restoreAllMocks();
  });
});
