import { randomBytes } from "node:crypto";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";

export interface ProxyTestFixture {
  db: TestDatabase;
  sandboxId: string;
  roomId: string;
  participantId: string;
}

export async function createProxyTestFixture(): Promise<ProxyTestFixture> {
  const db = await createTestDatabase();
  const roomId = `room_${randomBytes(12).toString("hex")}`;
  const participantId = `part_${randomBytes(12).toString("hex")}`;
  const sandboxId = `sandbox_${randomBytes(12).toString("hex")}`;
  await db.pool.query(
    `INSERT INTO rooms (id, slug, name, objective, owner_id, settings)
     VALUES ($1, $1, 'proxy test', 'egress policy tests', $2, $3)`,
    [
      roomId,
      participantId,
      JSON.stringify({ egress_allowlist: ["private.allowed.example", "mapped.allowed.example"] }),
    ],
  );
  await db.pool.query(
    `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status)
     VALUES ($1, $2, 'HUMAN', 'Owner', 'OWNER', 'LEAD', 'ACTIVE')`,
    [participantId, roomId],
  );
  await db.pool.query(
    `INSERT INTO sandboxes (id, room_id, participant_id, status, volume_ref, container_ref)
     VALUES ($1, $2, $3, 'RUNNING', 'proxy-test-volume', 'proxy-test-container')`,
    [sandboxId, roomId, participantId],
  );
  return { db, sandboxId, roomId, participantId };
}
