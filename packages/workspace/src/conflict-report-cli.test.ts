import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { main } from "./conflict-report-cli.js";

let db: TestDatabase;
const original = process.env["DATABASE_URL"];

beforeAll(async () => {
  db = await createTestDatabase();
  const url = new URL(original ?? "postgres://crossover:crossover@localhost:5434/crossover");
  url.pathname = `/${db.name}`;
  process.env["DATABASE_URL"] = url.href;
});
afterAll(async () => {
  if (original === undefined) delete process.env["DATABASE_URL"];
  else process.env["DATABASE_URL"] = original;
  await db.drop();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("conflict-report CLI", () => {
  it("rejects an invalid --since", async () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await main(["--since", "not-a-date"])).toBe(1);
    expect(err.mock.calls.join("")).toContain("conflict-report:");
    expect(await main(["--format", "xml"])).toBe(1);
  });

  it("prints markdown tables for a seeded room", async () => {
    const roomId = "room_cli_seed";
    const human = "part_cli_h";
    await db.pool.query(
      "INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'R', 'o', $2)",
      [roomId, human],
    );
    await db.pool.query(
      `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status)
       VALUES ($2, $1, 'HUMAN', 'H', 'MEMBER', 'DEVELOPER', 'ACTIVE')`,
      [roomId, human],
    );
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    expect(await main(["--room", roomId])).toBe(0);
    const text = out.join("");
    expect(text).toContain("## By participant kind");
    expect(text).toContain("| HUMAN | 0 | 0 | 0 | - |");
    expect(text).toContain("## By file extension");
    expect(text).toContain("Conflicted ChangeSets by submitter -> counterparty");
    expect(text).toContain("Structured-merge candidates");

    out.length = 0;
    expect(await main(["--room", roomId, "--format", "json"])).toBe(0);
    expect(JSON.parse(out.join(""))).toMatchObject({ report_version: 1, rooms: 1 });
  });
});
