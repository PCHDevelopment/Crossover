import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./testing.js";

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase(); // applies every migration in packages/db/migrations
});

afterAll(async () => {
  await db.drop();
});

describe("0001_rooms", () => {
  it("is recorded as applied", async () => {
    const { rows } = await db.pool.query("SELECT name FROM schema_migrations WHERE version = 1");
    expect(rows).toEqual([{ name: "rooms" }]);
  });

  it("applies defaults for status, settings, last_sequence and created_at", async () => {
    const { rows } = await db.pool.query(
      `INSERT INTO rooms (id, slug, name, objective, owner_id)
       VALUES ('room_a', 'a', 'A', 'Ship it', 'part_1') RETURNING *`,
    );
    expect(rows[0]).toMatchObject({
      status: "ACTIVE",
      settings: {},
      last_sequence: "0", // bigint comes back as a string
      lead_participant_id: null,
      archived_at: null,
    });
    expect(rows[0].created_at).toBeInstanceOf(Date);
  });

  it.each(["ACTIVE", "PAUSED", "ARCHIVED", "DELETED"])("accepts status %s", async (status) => {
    await db.pool.query(
      `INSERT INTO rooms (id, slug, name, objective, owner_id, status)
       VALUES ($1, $1, 'n', 'o', 'part_1', $2)`,
      [`room_ok_${status}`, status],
    );
  });

  it("rejects an invalid status in the database", async () => {
    await expect(
      db.pool.query(
        `INSERT INTO rooms (id, slug, name, objective, owner_id, status)
         VALUES ('room_bad', 'bad', 'n', 'o', 'part_1', 'FROZEN')`,
      ),
    ).rejects.toMatchObject({ code: "23514" }); // check_violation
  });

  it("rejects a status in the wrong case", async () => {
    await expect(
      db.pool.query(
        `INSERT INTO rooms (id, slug, name, objective, owner_id, status)
         VALUES ('room_lc', 'lc', 'n', 'o', 'part_1', 'active')`,
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("enforces unique slugs and primary keys", async () => {
    await db.pool.query(
      `INSERT INTO rooms (id, slug, name, objective, owner_id)
       VALUES ('room_u1', 'unique-slug', 'n', 'o', 'part_1')`,
    );
    await expect(
      db.pool.query(
        `INSERT INTO rooms (id, slug, name, objective, owner_id)
         VALUES ('room_u2', 'unique-slug', 'n', 'o', 'part_1')`,
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      db.pool.query(
        `INSERT INTO rooms (id, slug, name, objective, owner_id)
         VALUES ('room_u1', 'other-slug', 'n', 'o', 'part_1')`,
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("requires slug, name, objective and owner_id", async () => {
    for (const col of ["slug", "name", "objective", "owner_id"]) {
      const cols = ["id", "slug", "name", "objective", "owner_id"].filter((c) => c !== col);
      const vals = cols.map((_, i) => `$${i + 1}`);
      await expect(
        db.pool.query(
          `INSERT INTO rooms (${cols.join(", ")}) VALUES (${vals.join(", ")})`,
          cols.map((c) => `${c}_x`),
        ),
      ).rejects.toMatchObject({ code: "23502" }); // not_null_violation
    }
  });
});
