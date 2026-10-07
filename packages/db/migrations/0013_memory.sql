-- Shared memory / room blackboard (ARCHITECTURE §18, T408). `memory_entries` holds the current
-- value of each key; `memory_revisions` keeps every revision, including tombstones, so history
-- is never lost. Writes use compare-and-set on `revision` (0 creates).
CREATE TABLE memory_entries (
  room_id      text NOT NULL REFERENCES rooms (id),
  key          text NOT NULL CHECK (char_length(key) BETWEEN 1 AND 200),
  value        text NOT NULL CHECK (octet_length(value) <= 65536),
  content_type text NOT NULL CHECK (content_type IN ('text/markdown', 'application/json')),
  author_id    text NOT NULL,
  revision     integer NOT NULL CHECK (revision >= 1),
  -- What this knowledge came from: `[{ "kind": "task", "id": "task_…" }, …]`.
  source_refs  jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(source_refs) = 'array'),
  deleted      boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at   timestamptz NOT NULL DEFAULT clock_timestamp(),

  PRIMARY KEY (room_id, key),
  -- `author_id` may be the platform (`system`, for mirrored decisions), so it is not a foreign key.
  CONSTRAINT memory_entries_updated_after_created CHECK (updated_at >= created_at)
);

CREATE TABLE memory_revisions (
  room_id      text NOT NULL,
  key          text NOT NULL,
  revision     integer NOT NULL CHECK (revision >= 1),
  value        text NOT NULL CHECK (octet_length(value) <= 65536),
  content_type text NOT NULL CHECK (content_type IN ('text/markdown', 'application/json')),
  author_id    text NOT NULL,
  source_refs  jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(source_refs) = 'array'),
  deleted      boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),

  PRIMARY KEY (room_id, key, revision),
  FOREIGN KEY (room_id, key) REFERENCES memory_entries (room_id, key)
);

-- `memory.list { prefix }` (T409) walks keys in order within a room.
CREATE INDEX memory_entries_room_key ON memory_entries (room_id, key text_pattern_ops);
