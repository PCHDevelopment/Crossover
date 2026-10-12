import { CrossoverError } from "@crossover/protocol";
import { scanSecrets, type SecretFinding } from "@crossover/security";
import type { PoolClient } from "@crossover/db";
import { deliverInbox } from "./inbox/inbox.js";

/**
 * T902: secret scanning on messages and memory.
 *
 * The same scanner as the ChangeSet path (T901) applied to `messages.send/edit`
 * and `memory.put`. A high-confidence match (e.g. a private key block) rejects
 * with `VALIDATION`/`secret_detected`; a low-confidence match is flagged to the
 * author and the room owner with a `SECRET_SCAN` inbox item. The matched value
 * never appears in the error, the inbox summary, or any event — only its rule,
 * confidence, position and fingerprint.
 */

const MAX_FINDINGS = 100;

/** Where the scanned text lives, so a finding can be located without the value. */
export type SecretLocation =
  { kind: "message"; field: "body"; id: string } | { kind: "memory"; key: string };

/** A scanner finding tagged with its location (never the matched value). */
export type LocatedFinding = SecretFinding & { location: SecretLocation };

function locationLabel(loc: SecretLocation): string {
  return loc.kind === "message" ? `message ${loc.id}` : `memory key ${loc.key}`;
}

function inboxRef(loc: SecretLocation): { kind: string; id: string } {
  return loc.kind === "message" ? { kind: "message", id: loc.id } : { kind: "memory", id: loc.key };
}

/**
 * Scan a message body or memory value for secrets. Throws `VALIDATION`
 * (`secret_detected`) on a high-confidence match; otherwise delivers a
 * `SECRET_SCAN` inbox item to the author and the room owner (one item when they
 * are the same person) on a low-confidence match.
 */
export async function scanTextForSecrets(
  client: PoolClient,
  roomId: string,
  authorId: string,
  text: string,
  location: SecretLocation,
): Promise<void> {
  const findings = scanSecrets(text);
  const high = findings.filter((f) => f.confidence === "high");
  const low = findings.filter((f) => f.confidence === "low");

  if (high.length > 0) {
    const shown: LocatedFinding[] = high.slice(0, MAX_FINDINGS).map((f) => ({
      ...f,
      location,
    }));
    const omitted = high.length - shown.length;
    throw new CrossoverError("VALIDATION", "Contains a high-confidence secret", {
      details: {
        reason: "secret_detected",
        findings: shown,
        ...(omitted > 0 ? { omitted } : {}),
      },
    });
  }

  if (low.length > 0) {
    const { rows } = await client.query<{ owner_id: string }>(
      "SELECT owner_id FROM rooms WHERE id = $1",
      [roomId],
    );
    const owner_id = rows[0]?.owner_id;
    // The author and the owner are the recipients; a Set dedupes them when the
    // author is the owner, so they get one item, not two.
    const recipients = new Set([authorId, owner_id].filter((x): x is string => Boolean(x)));
    const shown = low
      .slice(0, 5)
      .map((f) => `${locationLabel(location)}, line ${f.line}, rule ${f.rule}`);
    const more = low.length > 5 ? ` (+${low.length - 5} more)` : "";
    const summary = `Secret scan: ${shown.join(", ")}${more}. Review before this ships.`;
    for (const recipient of recipients) {
      // An edit that leaves the same match in place must not pile up another item: skip the
      // recipient who already has an unacknowledged one for this location with this summary.
      const { rows: open } = await client.query(
        `SELECT 1 FROM inbox_items
         WHERE room_id = $1 AND participant_id = $2 AND kind = 'SECRET_SCAN'
           AND ref = $3::jsonb AND summary = $4 AND acked_at IS NULL
         LIMIT 1`,
        [roomId, recipient, JSON.stringify(inboxRef(location)), summary.slice(0, 500)],
      );
      if (open.length > 0) continue;
      await deliverInbox(client, roomId, recipient, {
        kind: "SECRET_SCAN",
        ref: inboxRef(location),
        summary,
        author_id: "system",
      });
    }
  }
}
