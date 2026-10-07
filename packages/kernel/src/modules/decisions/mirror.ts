import type { PoolClient } from "@crossover/db";
import type { EmittedEvent } from "../../dispatcher.js";
import { putMemory, SYSTEM_MEMORY_AUTHOR } from "../memory/memory.js";
import type { DecisionRow } from "./decisions.js";

/** The memory key an accepted decision is mirrored to (§7.4): `decisions/<decision-id>`. */
export const decisionMemoryKey = (decisionId: string) => `decisions/${decisionId}`;

/**
 * What the mirrored entry says: the decision as it stands, as JSON with a fixed key order, so
 * the same decision always projects to the same bytes. A deterministic projection, not inference.
 */
export function decisionMirrorValue(d: DecisionRow): string {
  const outcome = d.options.find((o) => o.id === d.outcome_option_id) ?? null;
  return JSON.stringify({
    id: d.id,
    title: d.title,
    status: d.status,
    outcome_option_id: d.outcome_option_id,
    outcome_summary: outcome ? outcome.summary : null,
    rationale: d.rationale,
    proposed_by: d.proposed_by,
    decided_by: d.decided_by,
    decided_at: d.decided_at ? d.decided_at.toISOString() : null,
    supersedes: d.supersedes,
    version: d.version,
  });
}

/**
 * Mirror `decision` into the reserved `decisions/<id>` memory namespace (§7.4, T407), as the
 * platform (`system`), in the caller's transaction, so the decision and its mirror commit or
 * roll back together. An `ACCEPTED` decision creates the entry; a later `VETOED` or
 * `SUPERSEDED` one updates its status. Any other status without an existing entry (a rejected,
 * withdrawn or still-open decision) writes nothing: only accepted decisions are knowledge.
 * Returns the `memory.updated` event to emit, attributed to `system`, or `null`.
 */
export async function mirrorDecision(
  client: PoolClient,
  roomId: string,
  decision: DecisionRow,
): Promise<(EmittedEvent & { actor_id: string }) | null> {
  const key = decisionMemoryKey(decision.id);
  const { rows } = await client.query<{ revision: number }>(
    "SELECT revision FROM memory_entries WHERE room_id = $1 AND key = $2 FOR UPDATE",
    [roomId, key],
  );
  const current = rows[0];
  if (!current && decision.status !== "ACCEPTED") return null;
  const entry = await putMemory(client, roomId, SYSTEM_MEMORY_AUTHOR, {
    key,
    value: decisionMirrorValue(decision),
    content_type: "application/json",
    expected_revision: current ? current.revision : 0,
    source_refs: [{ kind: "decision", id: decision.id }],
  });
  return {
    type: "memory.updated",
    actor_id: SYSTEM_MEMORY_AUTHOR,
    payload: {
      key: entry.key,
      revision: entry.revision,
      previous_revision: current ? current.revision : 0,
      content_type: entry.content_type,
      bytes: Buffer.byteLength(entry.value, "utf8"),
      author_id: entry.author_id,
      source_refs: entry.source_refs,
    },
  };
}
