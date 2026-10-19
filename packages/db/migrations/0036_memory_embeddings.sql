-- Derived, rebuildable vector index of memory_entries (ARCHITECTURE §18.4, T1579).
-- It is never authoritative; searches re-check the source memory row.
CREATE TABLE memory_embeddings (
  room_id    text NOT NULL,
  key        text NOT NULL,
  model      text NOT NULL CHECK (char_length(model) BETWEEN 1 AND 100),
  revision   integer NOT NULL CHECK (revision >= 1),
  dims       integer NOT NULL CHECK (dims BETWEEN 1 AND 4096),
  embedding  bytea NOT NULL CHECK (octet_length(embedding) = dims * 4),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (room_id, key, model),
  FOREIGN KEY (room_id, key) REFERENCES memory_entries (room_id, key) ON DELETE CASCADE
);
