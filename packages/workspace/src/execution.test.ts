import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { newId } from "@crossover/protocol";
import { ExecutionService, type ExecutionDriver, type SandboxResources } from "./execution.js";

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db?.drop();
});

class FakeExecutionDriver implements ExecutionDriver {
  readonly created: string[] = [];
  readonly started: SandboxResources[] = [];
  readonly stopped: SandboxResources[] = [];
  readonly destroyed: SandboxResources[] = [];

  async create(input: { sandbox_id: string }): Promise<SandboxResources> {
    await new Promise((resolve) => setTimeout(resolve, 10));
    this.created.push(input.sandbox_id);
    return {
      volume_ref: `volume:${input.sandbox_id}`,
      container_ref: `container:${input.sandbox_id}`,
    };
  }
  async start(resources: SandboxResources): Promise<void> {
    this.started.push(resources);
  }
  async stop(resources: SandboxResources): Promise<void> {
    this.stopped.push(resources);
  }
  async destroy(resources: SandboxResources): Promise<void> {
    this.destroyed.push(resources);
  }
}

async function makeParticipants(count = 1, kind: "HUMAN" | "AGENT" = "AGENT") {
  const roomId = newId("room");
  await db.pool.query(
    "INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'Sandbox test', 'Test', 'owner')",
    [roomId],
  );
  const participantIds = Array.from({ length: count }, () => newId("part"));
  for (const participantId of participantIds)
    await db.pool.query(
      `INSERT INTO participants (id, room_id, kind, display_name, role, status)
       VALUES ($1, $2, $3, 'Sandbox tester', 'DEVELOPER', 'ACTIVE')`,
      [participantId, roomId, kind],
    );
  return { roomId, participantIds };
}

describe("ExecutionService", () => {
  it("creates one sandbox per room participant and does not expose another participant's sandbox", async () => {
    const { roomId, participantIds } = await makeParticipants(2);
    const driver = new FakeExecutionDriver();
    const execution = new ExecutionService(db.pool, driver);
    const [first, concurrent] = await Promise.all([
      execution.ensure(roomId, participantIds[0]!),
      execution.ensure(roomId, participantIds[0]!),
    ]);
    const second = await execution.ensure(roomId, participantIds[1]!);

    expect(first.id).toBe(concurrent.id);
    expect(first.id).not.toBe(second.id);
    expect(first.volume_ref).not.toBe(second.volume_ref);
    expect(driver.created).toHaveLength(2);
    expect(await execution.get(roomId, participantIds[0]!)).toMatchObject({ id: first.id });
    expect(await execution.get(roomId, newId("part"))).toBeNull();
  });

  it("hibernates after 30 minutes, keeps the volume, and resumes the same sandbox", async () => {
    const { roomId, participantIds } = await makeParticipants();
    const driver = new FakeExecutionDriver();
    const execution = new ExecutionService(db.pool, driver);
    const created = await execution.ensure(roomId, participantIds[0]!);
    await db.pool.query(
      "UPDATE sandboxes SET last_active_at = clock_timestamp() - interval '31 minutes' WHERE id = $1",
      [created.id],
    );

    expect(await execution.sweepIdle()).toBe(1);
    expect(await execution.get(roomId, participantIds[0]!)).toMatchObject({
      id: created.id,
      status: "HIBERNATED",
      volume_ref: created.volume_ref,
    });
    const resumed = await execution.ensure(roomId, participantIds[0]!);
    expect(resumed).toMatchObject({
      id: created.id,
      status: "RUNNING",
      volume_ref: created.volume_ref,
    });
    expect(driver.stopped).toHaveLength(1);
    expect(driver.started).toEqual([
      { volume_ref: created.volume_ref, container_ref: created.container_ref },
    ]);
  });

  it("destroys a participant sandbox and every remaining sandbox when a room is archived", async () => {
    const { roomId, participantIds } = await makeParticipants(2);
    const driver = new FakeExecutionDriver();
    const execution = new ExecutionService(db.pool, driver);
    const [first, second] = await Promise.all(
      participantIds.map((participantId) => execution.ensure(roomId, participantId)),
    );

    await execution.destroyParticipant(roomId, participantIds[0]!);
    expect(await execution.get(roomId, participantIds[0]!)).toMatchObject({ status: "DESTROYED" });
    await execution.destroyRoom(roomId);
    expect(await execution.get(roomId, participantIds[1]!)).toMatchObject({ status: "DESTROYED" });
    expect(driver.destroyed.map(({ container_ref }) => container_ref).sort()).toEqual(
      [first!.container_ref, second!.container_ref].sort(),
    );
  });

  it("rejects sandbox creation for a removed participant", async () => {
    const { roomId, participantIds } = await makeParticipants();
    await db.pool.query("UPDATE participants SET status = 'REMOVED' WHERE id = $1", [
      participantIds[0],
    ]);
    const driver = new FakeExecutionDriver();
    const execution = new ExecutionService(db.pool, driver);

    await expect(execution.ensure(roomId, participantIds[0]!)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(driver.created).toEqual([]);
  });
});
