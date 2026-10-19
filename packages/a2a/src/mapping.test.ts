import { describe, expect, it } from "vitest";
import {
  CROSSOVER_TASK_STATUSES,
  fromA2aStates,
  toA2aState,
  toA2aTask,
  type CrossoverTaskView,
} from "./mapping.js";
import { taskSchema } from "./spec.js";

const view = (over: Partial<CrossoverTaskView> = {}): CrossoverTaskView => ({
  id: "task_1",
  status: "OPEN",
  version: 3,
  owner_id: null,
  updated_at: "2026-10-19T10:00:00.000Z",
  blocked_reason: null,
  evidence: [],
  missing_evidence: [],
  ...over,
});

describe("A2A mapping (§15.5)", () => {
  it("maps every Crossover status to one A2A state and back", () => {
    expect(CROSSOVER_TASK_STATUSES.map(toA2aState)).toEqual([
      "TASK_STATE_SUBMITTED",
      "TASK_STATE_WORKING",
      "TASK_STATE_WORKING",
      "TASK_STATE_INPUT_REQUIRED",
      "TASK_STATE_WORKING",
      "TASK_STATE_COMPLETED",
      "TASK_STATE_CANCELED",
    ]);
    expect(fromA2aStates(["TASK_STATE_WORKING"])).toEqual(["CLAIMED", "IN_PROGRESS", "REVIEW"]);
    expect(fromA2aStates(["TASK_STATE_SUBMITTED", "TASK_STATE_COMPLETED"])).toEqual([
      "OPEN",
      "DONE",
    ]);
    expect(fromA2aStates(["TASK_STATE_FAILED", "TASK_STATE_REJECTED", "nonsense"])).toEqual([]);
  });

  it("builds a valid A2A Task, with evidence as one artifact and no message unless BLOCKED", () => {
    const task = toA2aTask(
      view({ status: "DONE", evidence: [{ requirement: 0 }], missing_evidence: [1] }),
      { contextId: "room_1", callerId: "part_1" },
    );
    expect(taskSchema.parse(task)).toMatchObject({
      id: "task_1",
      contextId: "room_1",
      status: { state: "TASK_STATE_COMPLETED", timestamp: "2026-10-19T10:00:00.000Z" },
      artifacts: [
        {
          artifactId: "task_1:evidence",
          name: "crossover.evidence",
          parts: [{ data: { evidence: [{ requirement: 0 }], missing_evidence: [1] } }],
        },
      ],
    });
    expect(task.status.message).toBeUndefined();
    expect(toA2aTask(view(), { contextId: "r", callerId: "p" }).artifacts).toBeUndefined();
    expect(
      toA2aTask(view({ status: "BLOCKED", blocked_reason: "Need a key" }), {
        contextId: "r",
        callerId: "p",
      }).status.message,
    ).toMatchObject({ role: "ROLE_AGENT", parts: [{ text: "Need a key" }] });
  });
});
