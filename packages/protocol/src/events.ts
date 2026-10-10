import { z } from "zod";

/** Every event type in the ARCHITECTURE §19.5 catalog. */
export const EVENT_TYPES = [
  "room.created",
  "room.paused",
  "room.resumed",
  "room.archived",
  "lead.changed",
  "lead.transfer_offered",

  "participant.invited",
  "participant.joined",
  "participant.left",
  "participant.role_changed",
  "participant.manifest_changed",
  "participant.paused",
  "participant.resumed",
  "participant.removed",

  "capability.granted",
  "capability.revoked",
  "capability.denied",
  "approval.requested",
  "approval.decided",

  "message.sent",
  "message.edited",

  "task.created",
  "task.updated",
  "task.claimed",
  "task.assigned",
  "task.released",
  "task.started",
  "task.blocked",
  "task.unblocked",
  "task.submitted",
  "task.reviewed",
  "task.reopened",
  "task.cancelled",
  "task.lease_expired",

  "decision.proposed",
  "decision.position_added",
  "decision.decided",
  "decision.withdrawn",
  "decision.vetoed",
  "decision.superseded",

  "memory.updated",
  "memory.deleted",

  "workspace.changeset.applied",
  "workspace.changeset.rejected",
  "workspace.conflict.created",
  "workspace.conflict.escalated",
  "workspace.conflict.resolved",
  "workspace.conflict.abandoned",
  "workspace.health",
  "workspace.upstream_synced",

  "checkpoint.created",
  "checkpoint.exported",

  "sandbox.created",
  "sandbox.behind",
  "sandbox.hibernated",
  "sandbox.synced",
  "sandbox.exec.started",
  "sandbox.exec.finished",

  "tool.invoked",
  "tool.completed",
  "tool.failed",

  "budget.exceeded",
  "circuit_breaker.tripped",
  "loop.detected",
  "event.redacted",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const eventTypeSchema = z.enum(EVENT_TYPES);

/** `sha256:` followed by 64 lowercase hex characters (§19.1). */
const payloadHashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/, "expected sha256:<64 hex>");

/** A stored event as returned by the ledger and the API (ARCHITECTURE §19.1). */
export const roomEventSchema = z.object({
  sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  room_id: z.string().min(1),
  actor_id: z.string().min(1),
  type: eventTypeSchema,
  schema_version: z.number().int().min(1),
  timestamp: z.iso.datetime(),
  causation_id: z.string().min(1).nullable(),
  payload: z.record(z.string(), z.unknown()),
  payload_hash: payloadHashSchema,
  redacted: z.boolean(),
});

export type RoomEvent = z.infer<typeof roomEventSchema>;
