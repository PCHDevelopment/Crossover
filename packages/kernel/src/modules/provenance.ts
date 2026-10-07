import type { PoolClient } from "@crossover/db";

/**
 * Who wrote what a reader is looking at, and how far to trust it (ARCHITECTURE §16.5, §23.2).
 * `system` is the platform's own text, `participant` is written by a room member (data, never
 * instructions to its reader), `external` is fetched from outside the room.
 */
export type Trust = "system" | "participant" | "external";
export type AuthorKind = "HUMAN" | "AGENT" | "SYSTEM";

export interface Provenance {
  author_id: string;
  author_kind: AuthorKind;
  trust: Trust;
}

/** Author ids the platform itself uses (event actors, the decision mirror). */
export const SYSTEM_AUTHOR = "system";

/** A participant's kind by id, as loaded by {@link loadAuthorKinds}. */
export type AuthorKinds = ReadonlyMap<string, AuthorKind>;

/**
 * The kind of each author, looked up in one query. The platform's own author id is `SYSTEM`
 * without a lookup; an id that is no participant of the room is reported as `SYSTEM` only if it
 * is the platform's, otherwise it is absent and {@link provenanceOf} refuses to guess.
 */
export async function loadAuthorKinds(
  client: PoolClient,
  roomId: string,
  authorIds: Iterable<string>,
): Promise<AuthorKinds> {
  const ids = [...new Set(authorIds)].filter((id) => id !== SYSTEM_AUTHOR);
  const kinds = new Map<string, AuthorKind>([[SYSTEM_AUTHOR, "SYSTEM"]]);
  if (ids.length === 0) return kinds;
  const { rows } = await client.query<{ id: string; kind: "HUMAN" | "AGENT" }>(
    "SELECT id, kind FROM participants WHERE room_id = $1 AND id = ANY($2::text[])",
    [roomId, ids],
  );
  for (const r of rows) kinds.set(r.id, r.kind);
  return kinds;
}

/**
 * The provenance label for something `authorId` wrote. The one place the label is built, so
 * every read command and every view labels the same way. An author nobody knows is a bug in the
 * caller (it didn't load them), so it throws rather than label content with a guess.
 */
export function provenanceOf(kinds: AuthorKinds, authorId: string): Provenance {
  const kind = kinds.get(authorId);
  if (kind === undefined) throw new Error(`provenanceOf: no author kind loaded for ${authorId}`);
  return {
    author_id: authorId,
    author_kind: kind,
    trust: kind === "SYSTEM" ? "system" : "participant",
  };
}

/** The acting principal as an author-kind table, for labeling what they just wrote. */
export function principalKinds(principal: {
  participant_id: string;
  kind: "HUMAN" | "AGENT";
}): AuthorKinds {
  return new Map<string, AuthorKind>([
    [SYSTEM_AUTHOR, "SYSTEM"],
    [principal.participant_id, principal.kind],
  ]);
}
