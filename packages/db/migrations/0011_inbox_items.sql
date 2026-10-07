-- Per-participant inbox (ARCHITECTURE §17.2, T402): targeted items that need someone's
-- attention, kept until they acknowledge them. An item is a private pointer to something that
-- happened in the room (the event ledger holds the facts); acknowledging one is a personal
-- state change and is not a room event.
CREATE TABLE inbox_items (
  id             text PRIMARY KEY,
  room_id        text NOT NULL REFERENCES rooms (id),
  participant_id text NOT NULL,
  -- ASSIGNMENT, REVIEW_REQUEST, MENTION, CONFLICT, APPROVAL, LEASE_WARNING, LEASE_EXPIRED,
  -- ESCALATION, VETO, … (validated by the application, which owns the list).
  kind           text NOT NULL CHECK (kind ~ '^[A-Z][A-Z_]{0,39}$'),
  -- What it is about: `{ "kind": "task", "id": "task_…" }`.
  ref            jsonb NOT NULL CHECK (jsonb_typeof(ref) = 'object'),
  summary        text NOT NULL CHECK (summary <> '' AND length(summary) <= 500),
  created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  acked_at       timestamptz,

  FOREIGN KEY (participant_id, room_id) REFERENCES participants (id, room_id)
);

-- "What do I still need to look at?" is the hot query.
CREATE INDEX inbox_items_pending ON inbox_items (participant_id, created_at, id) WHERE acked_at IS NULL;
CREATE INDEX inbox_items_by_participant ON inbox_items (participant_id, created_at, id);
