-- Event ledger (ARCHITECTURE §19.1). One row per event; (room_id, sequence) is the total
-- order within a room. Gap-free assignment is the ledger's job (T108): it takes the room
-- row lock and uses last_sequence + 1 inside the same transaction (§19.2). The table only
-- guarantees uniqueness and that sequences start at 1.
CREATE TABLE events (
  room_id        text NOT NULL REFERENCES rooms (id),
  sequence       bigint NOT NULL CHECK (sequence >= 1),
  actor_id       text NOT NULL,
  type           text NOT NULL,
  schema_version integer NOT NULL DEFAULT 1,
  timestamp      timestamptz NOT NULL DEFAULT now(),
  causation_id   text,
  payload        jsonb NOT NULL DEFAULT '{}',
  payload_hash   text NOT NULL,
  redacted       boolean NOT NULL DEFAULT false,
  PRIMARY KEY (room_id, sequence)
);
