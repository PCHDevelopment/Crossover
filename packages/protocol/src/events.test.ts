import { describe, expect, it } from "vitest";
import { EVENT_TYPES, eventTypeSchema, roomEventSchema, type EventType } from "./events.js";

// Copied from docs/ARCHITECTURE.md §19.5. Update both together.
const CATALOG = `
room.created / room.paused / room.resumed / room.archived / room.unarchived / room.exported
room.retention_changed
room.egress_allowlist_changed
room.protected_paths_changed
room.health_settings_changed
room.budgets_changed
lead.changed / lead.transfer_offered

participant.invited / participant.joined / participant.left
participant.role_changed / participant.manifest_changed / participant.paused / participant.resumed / participant.removed

capability.granted / capability.revoked / capability.denied
approval.requested / approval.decided
inbox.delivered

message.sent / message.edited

task.created / task.updated / task.claimed / task.assigned / task.released
task.started / task.blocked / task.unblocked / task.submitted
task.reviewed / task.reopened / task.cancelled / task.lease_expired

decision.proposed / decision.position_added / decision.decided
decision.withdrawn / decision.vetoed / decision.superseded

memory.updated / memory.deleted

workspace.changeset.applied / workspace.changeset.rejected
workspace.changeset.held / workspace.changeset.hold_decided
workspace.conflict.created / workspace.conflict.escalated
workspace.conflict.resolved / workspace.conflict.abandoned
workspace.health
workspace.upstream_synced

checkpoint.created / checkpoint.exported

sandbox.created / sandbox.behind / sandbox.hibernated / sandbox.synced
sandbox.exec.started / sandbox.exec.finished

tool.invoked / tool.completed / tool.failed

integration.connected / integration.disconnected

budget.exceeded / circuit_breaker.tripped / loop.detected
event.redacted
`;

const catalogTypes = CATALOG.split(/[\s/]+/).filter(Boolean);

const valid = {
  sequence: 9182,
  room_id: "room_123",
  actor_id: "agent_4",
  type: "workspace.changeset.applied",
  schema_version: 1,
  timestamp: "2026-10-03T21:04:11.482Z",
  causation_id: "cmd_01J",
  payload: {},
  payload_hash: `sha256:${"a".repeat(64)}`,
  redacted: false,
};

describe("EVENT_TYPES", () => {
  it("contains every type in the §19.5 catalog, and nothing else", () => {
    expect(catalogTypes).toHaveLength(77);
    expect([...EVENT_TYPES].sort()).toEqual([...catalogTypes].sort());
  });

  it("has no duplicates", () => {
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length);
  });

  it("derives the EventType union", () => {
    const t: EventType = "task.created";
    expect(EVENT_TYPES).toContain(t);
  });
});

describe("eventTypeSchema", () => {
  it("accepts every catalog type", () => {
    for (const type of catalogTypes) expect(eventTypeSchema.safeParse(type).success).toBe(true);
  });

  it("rejects unknown event types", () => {
    for (const bad of ["task.exploded", "room", "", "TASK.CREATED", "task.created "]) {
      expect(eventTypeSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("roomEventSchema", () => {
  it("accepts the §19.1 example", () => {
    expect(roomEventSchema.parse(valid)).toEqual(valid);
  });

  it("accepts a null causation_id and a redacted event", () => {
    expect(
      roomEventSchema.safeParse({ ...valid, causation_id: null, redacted: true }).success,
    ).toBe(true);
  });

  it("rejects unknown event types", () => {
    expect(roomEventSchema.safeParse({ ...valid, type: "task.exploded" }).success).toBe(false);
  });

  it("rejects malformed fields", () => {
    const bad: Record<string, unknown>[] = [
      { sequence: 0 },
      { sequence: 1.5 },
      { sequence: "1" },
      { room_id: "" },
      { actor_id: "" },
      { schema_version: 0 },
      { timestamp: "yesterday" },
      { causation_id: "" },
      { payload: [] },
      { payload: "x" },
      { payload_hash: "sha256:abc" },
      { payload_hash: "a".repeat(64) },
      { payload_hash: `sha256:${"A".repeat(64)}` },
      { redacted: "no" },
    ];
    for (const patch of bad) {
      expect(roomEventSchema.safeParse({ ...valid, ...patch }).success, JSON.stringify(patch)).toBe(
        false,
      );
    }
  });

  it("rejects missing fields", () => {
    for (const key of Object.keys(valid)) {
      const rest: Record<string, unknown> = { ...valid };
      delete rest[key];
      expect(roomEventSchema.safeParse(rest).success, key).toBe(false);
    }
  });
});
