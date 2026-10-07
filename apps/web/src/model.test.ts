import type { SdkEvent } from "@crossover/sdk";
import { describe, expect, it } from "vitest";
import { affectsState, describeEvent } from "./model.js";

const event = (over: Partial<SdkEvent>): SdkEvent => ({
  room_id: "rom_1",
  sequence: 1,
  actor_id: "part_a",
  type: "message.sent",
  timestamp: "2026-01-01T00:00:00Z",
  causation_id: null,
  schema_version: 1,
  payload: {},
  payload_hash: "sha256:x",
  redacted: false,
  ...over,
});
const who = (id: string) => ({ part_a: "AgentB", part_p: "Peter" })[id] ?? id;

describe("describeEvent", () => {
  it("says only what the server sent about a denial: the capability for a viewer who may see it, nothing more for one who may not", () => {
    const full = event({
      type: "capability.denied",
      payload: {
        action: "events.redact",
        missing_capability: "events.redact",
        resource: { x: "y" },
      },
    });
    expect(describeEvent(full, who)).toBe("AgentB was denied events.redact");
    const hidden = event({
      type: "capability.denied",
      redacted: true,
      payload: { missing_capability: "events.redact" }, // an event marked redacted is described by nothing in it
    });
    expect(describeEvent(hidden, who)).toBe("AgentB was denied an action (details hidden)");
    expect(describeEvent(hidden, who)).not.toContain("events.redact");
  });

  it("describes the common events and falls back to the type", () => {
    expect(describeEvent(event({ payload: { body: "secret" } }), who)).toBe(
      "AgentB sent a message",
    );
    expect(
      describeEvent(event({ type: "task.created", payload: { task: { title: "Docs" } } }), who),
    ).toBe("AgentB created task “Docs”");
    expect(
      describeEvent(
        event({ type: "participant.paused", payload: { participant_id: "part_p" } }),
        who,
      ),
    ).toBe("AgentB paused Peter");
    expect(describeEvent(event({ type: "workspace.health" }), who)).toBe(
      "AgentB · workspace.health",
    );
  });
});

describe("affectsState", () => {
  it("refreshes for participants, tasks, the room and grants, not for chatter", () => {
    for (const t of [
      "participant.joined",
      "task.created",
      "room.paused",
      "lead.changed",
      "capability.granted",
    ])
      expect(affectsState(t), t).toBe(true);
    for (const t of ["message.sent", "capability.denied", "workspace.health"])
      expect(affectsState(t), t).toBe(false);
  });
});
