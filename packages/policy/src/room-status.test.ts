import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authorize } from "./authorize.js";

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

type Who = "owner" | "admin" | "member" | "agent";

async function room(status: string) {
  const id = `room_${++n}`;
  const owner = `part_${++n}`;
  await pool.query(
    `INSERT INTO rooms (id, slug, name, objective, owner_id, status) VALUES ($1, $1, 'n', 'o', $2, $3)`,
    [id, owner, status],
  );
  const insert = (pid: string, kind: string, authority: string) =>
    pool.query(
      `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status)
       VALUES ($1, $2, $3, $1, $4, 'LEAD', 'ACTIVE')`,
      [pid, id, kind, authority],
    );
  const ids = { owner, admin: `part_${++n}`, member: `part_${++n}`, agent: `part_${++n}` };
  await insert(ids.owner, "HUMAN", "OWNER");
  await insert(ids.admin, "HUMAN", "ADMIN");
  await insert(ids.member, "HUMAN", "MEMBER");
  await insert(ids.agent, "AGENT", "MEMBER");
  return { id, ids };
}

const outcome = async (
  status: string,
  who: Who,
  method: string,
  action: string,
): Promise<string> => {
  const r = await room(status);
  return authorize(
    { participant_id: r.ids[who], room_id: r.id },
    action,
    { room_id: r.id },
    { method, params: {}, client: pool },
  ).then(
    () => "allowed",
    (e: { code?: string; details?: { room_status?: string } }) =>
      e.code === "ROOM_PAUSED" ? `ROOM_PAUSED:${e.details?.room_status}` : (e.code ?? "error"),
  );
};

const MUTATION = ["tasks.create", "tasks.create"] as const; // method, action
const READ = ["tasks.list", "tasks.read"] as const;

describe("what each room state allows (§5)", () => {
  it("an ACTIVE room allows everything the capabilities allow", async () => {
    for (const who of ["owner", "admin", "member", "agent"] as const) {
      expect(await outcome("ACTIVE", who, ...MUTATION)).toBe("allowed");
      expect(await outcome("ACTIVE", who, ...READ)).toBe("allowed");
    }
  });

  it("a PAUSED room: mutations only from the owner; reads for everyone", async () => {
    expect(await outcome("PAUSED", "owner", ...MUTATION)).toBe("allowed");
    for (const who of ["admin", "member", "agent"] as const) {
      expect(await outcome("PAUSED", who, ...MUTATION)).toBe("ROOM_PAUSED:PAUSED");
    }
    for (const who of ["owner", "admin", "member", "agent"] as const) {
      expect(await outcome("PAUSED", who, ...READ)).toBe("allowed");
    }
  });

  it("an ARCHIVED room is read-only for everyone, the owner included", async () => {
    for (const who of ["owner", "admin", "member", "agent"] as const) {
      expect(await outcome("ARCHIVED", who, ...MUTATION)).toBe("ROOM_PAUSED:ARCHIVED");
      expect(await outcome("ARCHIVED", who, ...READ)).toBe("allowed");
    }
  });

  it("a DELETED room doesn't exist", async () => {
    for (const who of ["owner", "agent"] as const) {
      expect(await outcome("DELETED", who, ...MUTATION)).toBe("NOT_FOUND");
      expect(await outcome("DELETED", who, ...READ)).toBe("NOT_FOUND");
    }
  });

  it("decides mutating by the catalog for known methods, even if the action looks like a read", async () => {
    expect(await outcome("PAUSED", "agent", "tasks.create", "tasks.read")).toBe(
      "ROOM_PAUSED:PAUSED",
    );
    expect(await outcome("PAUSED", "agent", "tasks.list", "tasks.create")).toBe("allowed");
  });

  it("for an unknown method falls back to the capability, and treats unknown capabilities as mutations", async () => {
    expect(await outcome("PAUSED", "agent", "x.y", "tasks.read")).toBe("allowed");
    expect(await outcome("PAUSED", "agent", "x.y", "tasks.create")).toBe("ROOM_PAUSED:PAUSED");
    expect(await outcome("PAUSED", "agent", "x.y", "github.create_pull_request")).toBe(
      "ROOM_PAUSED:PAUSED",
    );
  });

  it("a paused participant is still told PARTICIPANT_PAUSED first", async () => {
    const r = await room("PAUSED");
    await pool.query("UPDATE participants SET status = 'PAUSED' WHERE id = $1", [r.ids.agent]);
    const err = await authorize(
      { participant_id: r.ids.agent, room_id: r.id },
      "tasks.read",
      { room_id: r.id },
      { method: "tasks.list", params: {}, client: pool },
    ).catch((e: { code: string }) => e);
    expect((err as { code: string }).code).toBe("PARTICIPANT_PAUSED");
  });
});
