import type { PoolClient } from "@crossover/db";
import { CrossoverError } from "@crossover/protocol";
import { z } from "zod";
import type { Dispatcher, EmittedEvent } from "../../dispatcher.js";
import { agentManifestSchema, AGENT_CLIENTS, type AgentManifest } from "../invites/join.js";
import { deliverInbox } from "../inbox/inbox.js";

/** The manifest fields whose change the room is told about (§34.6). Self-declared, never trusted. */
export const TRACKED_MANIFEST_FIELDS = ["vendor", "model", "client", "client_version"] as const;
export type TrackedManifestField = (typeof TRACKED_MANIFEST_FIELDS)[number];

export const participantsUpdateManifestParams = z.strictObject({
  /** Only ever yourself; naming anyone else is `FORBIDDEN`. */
  participant_id: z.string().min(1).max(100).optional(),
  manifest: agentManifestSchema,
});

export interface ManifestChange {
  /** Stored and (for the tracked fields) reported. */
  changed: boolean;
  /** `field → { before, after }` for the tracked fields that moved. */
  changes: Partial<Record<TrackedManifestField, { before: string; after: string }>>;
  /** The wake webhook was added, removed or replaced. Never says to what. */
  wake_webhook_url_changed: boolean;
  /** The events to emit: `participant.manifest_changed`, or none when nothing tracked moved. */
  events: (EmittedEvent & { actor_id?: string })[];
}

/** JSON with object keys sorted, so two manifests compare equal whatever order they were built in. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
/** What the agent declared: the stored manifest without the fields the platform added at join. */
export const declaredManifest = (stored: object): AgentManifest =>
  Object.fromEntries(
    Object.entries(stored).filter(([key]) => key in agentManifestSchema.shape),
  ) as AgentManifest;

const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

/**
 * Store `next` as `participantId`'s manifest, in the caller's transaction (T1303, §34.6).
 *
 * An identical manifest is a no-op: nothing is written or emitted. Otherwise the manifest is
 * stored. If `vendor`, `model`, `client` or `client_version` changed, or the wake webhook did,
 * `participant.manifest_changed { participant_id, changes: { field: { before, after } } }` is
 * emitted and the lead and the owner get a `MANIFEST_CHANGED` inbox item. A changed
 * `wake_webhook_url` is reported only as `wake_webhook_url_changed: true`: the URL is a
 * credential-bearing address and never reaches the event or the inbox. A change to only the
 * name, operator or description is stored and reported to no one.
 */
export async function changeAgentManifest(
  client: PoolClient,
  roomId: string,
  participantId: string,
  next: AgentManifest,
  actorId?: string,
): Promise<ManifestChange> {
  const { rows } = await client.query<{ kind: string; agent_manifest: AgentManifest | null }>(
    "SELECT kind, agent_manifest FROM participants WHERE id = $1 AND room_id = $2 FOR UPDATE",
    [participantId, roomId],
  );
  const row = rows[0];
  if (!row) throw new CrossoverError("NOT_FOUND", `Participant ${participantId} not found`);
  if (row.kind !== "AGENT" || !row.agent_manifest) {
    throw new CrossoverError("VALIDATION", "Only an agent has a manifest", {
      details: { participant_id: participantId, kind: row.kind },
    });
  }
  // The stored manifest also carries fields the platform added at join (`self_declared`): the
  // comparison is of what the agent declares, and those fields are kept as they are.
  const before = declaredManifest(row.agent_manifest);
  const platformFields = Object.fromEntries(
    Object.entries(row.agent_manifest).filter(([key]) => !(key in agentManifestSchema.shape)),
  );
  const none: ManifestChange = {
    changed: false,
    changes: {},
    wake_webhook_url_changed: false,
    events: [],
  };
  if (same(before, next)) return none;

  await client.query(
    "UPDATE participants SET agent_manifest = $3::jsonb WHERE id = $1 AND room_id = $2",
    [participantId, roomId, JSON.stringify({ ...next, ...platformFields })],
  );

  const changes: ManifestChange["changes"] = {};
  for (const field of TRACKED_MANIFEST_FIELDS) {
    if (before[field] !== next[field])
      changes[field] = { before: before[field], after: next[field] };
  }
  const webhookChanged = before.wake_webhook_url !== next.wake_webhook_url;
  if (Object.keys(changes).length === 0 && !webhookChanged) {
    return { ...none, changed: true };
  }

  const payload = {
    participant_id: participantId,
    changes,
    ...(webhookChanged ? { wake_webhook_url_changed: true } : {}),
  };
  const parts = Object.entries(changes).map(([f, c]) => `${f} ${c.before} → ${c.after}`);
  if (webhookChanged) parts.push("wake webhook changed");
  const { rows: leaders } = await client.query<{ id: string }>(
    `SELECT id FROM participants
     WHERE room_id = $1 AND status <> 'REMOVED' AND id <> $2
       AND (role = 'LEAD' OR authority = 'OWNER')
     ORDER BY id`,
    [roomId, participantId],
  );
  for (const { id } of leaders) {
    await deliverInbox(client, roomId, id, {
      kind: "MANIFEST_CHANGED",
      ref: { kind: "participant", id: participantId },
      summary: `${next.name} (${participantId}) changed its manifest: ${parts.join("; ")}`,
    });
  }
  return {
    changed: true,
    changes,
    wake_webhook_url_changed: webhookChanged,
    events: [
      {
        type: "participant.manifest_changed",
        ...(actorId ? { actor_id: actorId } : {}),
        payload,
      },
    ],
  };
}

/**
 * Register `participants.update_manifest { manifest }` (T1303): an agent declares what it now
 * is (a new model, a new client version), validated like the join manifest. **Self only**:
 * naming another participant is `FORBIDDEN`; a human has no manifest (`VALIDATION`).
 */
export function registerParticipantManifestCommand(dispatcher: Dispatcher): void {
  dispatcher.registerCommand({
    method: "participants.update_manifest",
    // Every participant who may act at all (paused ones are already refused): the command
    // itself restricts it to an agent updating its own manifest.
    action: "room.read",
    mutating: true,
    params: participantsUpdateManifestParams,
    execute: async (ctx, p) => {
      const me = ctx.principal.participant_id;
      if (p.participant_id !== undefined && p.participant_id !== me) {
        throw new CrossoverError("FORBIDDEN", "You can only update your own manifest", {
          details: { reason: "not_self" },
        });
      }
      if (ctx.principal.kind !== "AGENT") {
        throw new CrossoverError("VALIDATION", "Only an agent has a manifest", {
          details: { kind: ctx.principal.kind },
        });
      }
      const result = await changeAgentManifest(ctx.client, ctx.room_id, me, p.manifest);
      return {
        response: {
          participant_id: me,
          changed: result.changed,
          changes: result.changes,
          wake_webhook_url_changed: result.wake_webhook_url_changed,
        },
        events: result.events,
      };
    },
  });
}

export interface McpClientInfo {
  name?: unknown;
  version?: unknown;
}

/**
 * The MCP gateway's side of T1303: an agent that reconnects (`initialize`) with a different
 * `clientInfo.version` has changed its `client_version`, whatever it says. Applied as `system`
 * through {@link Dispatcher.runSystem}, so there is one event and one inbox item per lead and
 * owner for a real change and nothing for a reconnect with the same version. `clientInfo.name`
 * is free text, while the manifest's `client` is one of {@link AGENT_CLIENTS}: it is applied
 * only when it names one of them. A frozen room skips it; a malformed clientInfo is ignored.
 * Never throws into the MCP request.
 */
export async function syncAgentClientInfo(
  dispatcher: Dispatcher,
  principal: { participant_id: string; room_id: string; kind: string },
  info: McpClientInfo,
): Promise<boolean> {
  if (principal.kind !== "AGENT") return false;
  const version = typeof info.version === "string" ? info.version.trim() : "";
  if (version === "" || version.length > 50) return false;
  const name = typeof info.name === "string" ? info.name.trim() : "";
  const client = (AGENT_CLIENTS as readonly string[]).includes(name)
    ? (name as AgentManifest["client"])
    : undefined;
  const { result } = await dispatcher.runSystem(
    principal.room_id,
    "participants.sync_client_info",
    async (ctx) => {
      const { rows } = await ctx.client.query<{ agent_manifest: AgentManifest | null }>(
        "SELECT agent_manifest FROM participants WHERE id = $1 AND room_id = $2",
        [principal.participant_id, ctx.room_id],
      );
      const current = rows[0]?.agent_manifest;
      if (!current) return { result: false, events: [] };
      const next: AgentManifest = {
        ...declaredManifest(current),
        client_version: version,
        ...(client ? { client } : {}),
      };
      const change = await changeAgentManifest(
        ctx.client,
        ctx.room_id,
        principal.participant_id,
        next,
        "system",
      );
      return {
        result: change.changed,
        events: change.events.map((e) => ({ ...e, actor_id: "system" })),
      };
    },
    { whenFrozen: () => false },
  );
  return result;
}
