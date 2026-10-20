import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { main, markdown } from "./conflict-report-cli.js";

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

  it("accepts only a calendar date or a date-time with an offset", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    for (const since of ["2026-02-30", "2026-10-01T00:00:00", "10/01/2026", "2026-13-01"])
      expect(await main(["--since", since, "--room", "room_none"]), since).toBe(1);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(
      await main([
        "--since",
        "2026-10-01",
        "--until",
        "2026-10-02T00:00:00+02:00",
        "--room",
        "room_none",
      ]),
    ).toBe(0);
  });

  it("rejects a reversed or empty window", async () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(
      await main(["--since", "2026-10-02", "--until", "2026-10-01", "--room", "room_none"]),
    ).toBe(1);
    expect(
      await main(["--since", "2026-10-01", "--until", "2026-10-01", "--room", "room_none"]),
    ).toBe(1);
    expect(err.mock.calls.join("")).toContain("--since must be earlier than --until");
  });

  it("ranks the top 20 extensions before expanding their kinds", () => {
    const cell = () => ({
      contended_file_touches: 1,
      conflicted_files: 0,
      by_kind: { CONTENT: 0, MODIFY_DELETE: 0, RENAME: 0, ADD_ADD: 0, BINARY: 0, PARSE: 0 },
    });
    const by_extension: Record<
      string,
      Record<"HUMAN" | "AGENT" | "SYSTEM", ReturnType<typeof cell>>
    > = {};
    for (let i = 0; i < 25; i++)
      by_extension[`e${String(i).padStart(2, "0")}`] = {
        HUMAN: { ...cell(), conflicted_files: i + 1 },
        AGENT: { ...cell(), conflicted_files: 1 },
        SYSTEM: cell(),
      };
    const none = { submissions: 0, contended: 0, conflicted: 0, conflict_rate: null };
    const by_participant = { HUMAN: none, AGENT: none, SYSTEM: none };
    const by_pair = Object.fromEntries(
      ["HUMAN", "AGENT", "SYSTEM"].flatMap((a) =>
        ["HUMAN", "AGENT", "SYSTEM"].map((b) => [`${a}->${b}`, 0]),
      ),
    );
    const text = markdown({
      since: "s",
      until: "u",
      rooms: 1,
      by_participant,
      by_extension,
      by_pair,
      structured_candidates: { HUMAN: 0, AGENT: 0 },
      structured: {
        resolved_changesets: { HUMAN: 0, AGENT: 0, SYSTEM: 0 },
        refusals: { HUMAN: {}, AGENT: {}, SYSTEM: {} },
        saved_rate: { HUMAN: null, AGENT: null, SYSTEM: null },
      },
    } as unknown as Parameters<typeof markdown>[0]);
    const shown = new Set(
      text
        .split("\n")
        .filter((l) => /^\| e\d\d /.test(l))
        .map((l) => l.split(" ")[1]),
    );
    expect(shown.size).toBe(20);
    expect(shown.has("e24")).toBe(true);
    expect(shown.has("e04")).toBe(false);
  });

  it("prints the Structured merge and Top refusal reasons tables", () => {
    const none = { submissions: 0, contended: 0, conflicted: 0, conflict_rate: null };
    const text = markdown({
      since: "s",
      until: "u",
      rooms: 1,
      by_participant: { HUMAN: none, AGENT: { ...none, conflicted: 1 }, SYSTEM: none },
      by_extension: {},
      by_pair: {},
      structured_candidates: { HUMAN: 0, AGENT: 0 },
      structured: {
        resolved_changesets: { HUMAN: 0, AGENT: 2, SYSTEM: 0 },
        refusals: {
          HUMAN: {},
          AGENT: { same_key: 3, reorder: 1 },
          SYSTEM: { same_key: 3 },
        },
        saved_rate: { HUMAN: null, AGENT: 0.6667, SYSTEM: null },
      },
    } as unknown as Parameters<typeof markdown>[0]);
    expect(text).toContain("## Structured merge");
    expect(text).toContain("| AGENT | 2 | 1 | 66.7% |");
    expect(text).toContain("| HUMAN | 0 | 0 | - |");
    expect(text).toContain("## Top refusal reasons");
    const reasons = text
      .split("## Top refusal reasons")[1]!
      .split("\n")
      .filter((l) => /^\| (same_key|reorder) /.test(l));
    expect(reasons).toEqual([
      "| same_key | AGENT | 3 |",
      "| same_key | SYSTEM | 3 |",
      "| reorder | AGENT | 1 |",
    ]);
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
    expect(JSON.parse(out.join(""))).toMatchObject({ report_version: 2, rooms: 1 });
  });
});
