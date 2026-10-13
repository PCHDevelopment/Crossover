import type { PoolClient } from "@crossover/db";
import { CrossoverError } from "@crossover/protocol";

export interface MessageRef {
  kind: string;
  id: string;
}

/**
 * How each kind of reference is looked up: a query over `$1` (the room) and `$2` (the ids)
 * that returns the ids which exist in the room.
 */
const LOOKUPS: Record<string, string> = {
  task: "SELECT id FROM tasks WHERE room_id = $1 AND id = ANY($2::text[])",
  decision: "SELECT id FROM decisions WHERE room_id = $1 AND id = ANY($2::text[])",
  message: "SELECT id FROM messages WHERE room_id = $1 AND id = ANY($2::text[])",
  changeset: "SELECT id FROM changesets WHERE room_id = $1 AND id = ANY($2::text[])",
  conflict: "SELECT id FROM conflicts WHERE room_id = $1 AND id = ANY($2::text[])",
  // A memory key is its id; a deleted key is gone.
  memory:
    "SELECT key AS id FROM memory_entries WHERE room_id = $1 AND key = ANY($2::text[]) AND NOT deleted",
  // A file is its path; a path whose latest revision is a deletion is gone.
  file: `SELECT path AS id FROM (
           SELECT DISTINCT ON (path) path, blob_sha FROM file_revisions
           WHERE room_id = $1 AND path = ANY($2::text[]) ORDER BY path, revision DESC
         ) latest WHERE blob_sha IS NOT NULL`,
};

/**
 * `messages.send` refs (§17.5) must name a known kind of thing that exists in this room, like
 * mentions must be participants of it. A ref to another room's task is as unknown as one to
 * nothing: the error never says which.
 */
export async function validateRefs(
  client: PoolClient,
  roomId: string,
  refs: readonly MessageRef[],
): Promise<void> {
  const unknownKind = refs.find((r) => !Object.hasOwn(LOOKUPS, r.kind));
  if (unknownKind) {
    throw new CrossoverError("VALIDATION", `Unknown ref kind "${unknownKind.kind}"`, {
      details: { unknown_refs: [unknownKind], ref_kinds: Object.keys(LOOKUPS) },
    });
  }
  const ids = new Map<string, Set<string>>();
  for (const r of refs) ids.set(r.kind, (ids.get(r.kind) ?? new Set()).add(r.id));
  const missing: MessageRef[] = [];
  for (const [kind, wanted] of ids) {
    const { rows } = await client.query<{ id: string }>(LOOKUPS[kind]!, [roomId, [...wanted]]);
    const found = new Set(rows.map((r) => r.id));
    for (const id of wanted) if (!found.has(id)) missing.push({ kind, id });
  }
  if (missing.length > 0) {
    throw new CrossoverError(
      "VALIDATION",
      `Referenced ${missing[0]!.kind} ${missing[0]!.id} isn't in this room`,
      { details: { unknown_refs: missing } },
    );
  }
}
