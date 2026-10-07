import type { SdkEvent } from "@crossover/sdk";

export interface Participant {
  id: string;
  kind: "HUMAN" | "AGENT";
  display_name: string;
  authority: "OWNER" | "ADMIN" | "MEMBER";
  role: "LEAD" | "DEVELOPER" | "REVIEWER" | "OBSERVER";
  status: "INVITED" | "ACTIVE" | "PAUSED" | "REMOVED";
  last_seen_at: string | null;
}

export interface RoomInfo {
  id: string;
  slug: string;
  name: string;
  objective: string;
  status: string;
  owner_id: string;
  lead_participant_id: string | null;
}

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  owner_id: string | null;
  priority: number;
}

export const TASK_STATUSES = [
  "OPEN",
  "CLAIMED",
  "IN_PROGRESS",
  "BLOCKED",
  "REVIEW",
  "DONE",
  "CANCELLED",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface RoomState {
  last_sequence: number;
  sections: { room: RoomInfo; participants: Participant[] };
}

/** Events that change what the overview and the board show. */
export const affectsState = (type: string): boolean =>
  /^(participant|task|room|lead)\./.test(type) || /^capability\.(granted|revoked)$/.test(type);

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * One line for the Activity feed. Events arrive already redacted for the viewer (§34.5): a
 * `capability.denied` they may not see in full comes with `redacted` and little else, and that is
 * all this says, never more than the server sent.
 */
export function describeEvent(event: SdkEvent, who: (id: string) => string): string {
  const p = event.payload ?? {};
  const actor = who(event.actor_id);
  switch (event.type) {
    case "capability.denied": {
      const what = str(p["missing_capability"]) ?? str(p["action"]);
      return event.redacted || !what
        ? `${actor} was denied an action (details hidden)`
        : `${actor} was denied ${what}`;
    }
    case "message.sent":
      return `${actor} sent a message`;
    case "task.created":
      return `${actor} created task “${str((p["task"] as { title?: unknown } | undefined)?.title) ?? ""}”`;
    case "task.claimed":
      return `${actor} claimed a task`;
    case "participant.paused":
      return `${actor} paused ${who(str(p["participant_id"]) ?? "")}`;
    case "participant.resumed":
      return `${actor} resumed ${who(str(p["participant_id"]) ?? "")}`;
    case "lead.changed":
      return `${actor} appointed ${who(str(p["to"]) ?? "")} as lead`;
    default:
      return `${actor} · ${event.type}`;
  }
}
