import type { RoomEvent } from "@crossover/protocol";

/** Who is reading events: enough to decide what they may see. */
export interface EventViewer {
  participant_id: string;
  role: string;
  authority: string;
}

/** The lead, the owner and admins see the full record of what was denied (§22). */
export const seesDenials = (viewer: EventViewer): boolean =>
  viewer.role === "LEAD" || viewer.authority === "OWNER" || viewer.authority === "ADMIN";

/** `workspace.write:secrets/key` → `workspace.write`: a scope can name a path. */
const base = (value: unknown): unknown =>
  typeof value === "string" ? (value.split(":", 1)[0] ?? value) : value;

/**
 * What `viewer` may see of `event`. A `capability.denied` event records which resource a
 * participant tried to touch (a workspace path, say), which tells everyone who can read the
 * room about paths they may not be allowed to know. So only the participant it is about
 * (`actor_id`, or `on_behalf_of` for a check made on someone else's behalf), the lead, the owner
 * and admins get it in full; everyone else gets it with `resource` removed, `resource_redacted:
 * true`, and any scope cut from the capability names. Other events pass through unchanged.
 * This is a view applied on the way out: the stored event is not touched, and it does not run
 * an authorization check (which would itself record a denial).
 */
export function redactEventFor(viewer: EventViewer, event: RoomEvent): RoomEvent {
  if (event.type !== "capability.denied") return event;
  const payload = event.payload as Record<string, unknown>;
  if (
    seesDenials(viewer) ||
    event.actor_id === viewer.participant_id ||
    payload.on_behalf_of === viewer.participant_id
  ) {
    return event;
  }
  const { resource: _resource, ...rest } = payload;
  void _resource;
  return {
    ...event,
    payload: {
      ...rest,
      action: base(rest.action),
      missing_capability: base(rest.missing_capability),
      resource_redacted: true,
    },
  };
}
