-- Migration files must not contain BEGIN/COMMIT: the runner wraps each file in its own
-- transaction together with the schema_migrations insert (T102).

-- Rooms (ARCHITECTURE §5). `last_sequence` is the room's event-ledger high-water mark (§19).
CREATE TABLE rooms (
  id                  text PRIMARY KEY,
  slug                text NOT NULL UNIQUE,
  name                text NOT NULL,
  objective           text NOT NULL,
  status              text NOT NULL DEFAULT 'ACTIVE'
                      CHECK (status IN ('ACTIVE', 'PAUSED', 'ARCHIVED', 'DELETED')),
  owner_id            text NOT NULL,
  lead_participant_id text,
  settings            jsonb NOT NULL DEFAULT '{}',
  last_sequence       bigint NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  archived_at         timestamptz
);
