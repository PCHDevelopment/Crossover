-- Workspace snapshots (§9.7): a named, immutable mark of a revision plus a frozen copy of memory.
CREATE TABLE workspace_snapshots (
  id             text PRIMARY KEY,
  room_id        text NOT NULL REFERENCES rooms (id),
  workspace_id   text NOT NULL,
  revision       bigint NOT NULL CHECK (revision >= 1),
  name           text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  description    text NOT NULL DEFAULT '' CHECK (char_length(description) <= 2000),
  created_by     text NOT NULL,
  memory_entries integer NOT NULL CHECK (memory_entries >= 0),
  memory_bytes   bigint NOT NULL CHECK (memory_bytes >= 0),
  created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (workspace_id, room_id, revision)
    REFERENCES workspace_revisions (workspace_id, room_id, revision),
  FOREIGN KEY (created_by, room_id) REFERENCES participants (id, room_id),
  UNIQUE (room_id, name),
  UNIQUE (id, room_id)
);
CREATE INDEX workspace_snapshots_room_created ON workspace_snapshots (room_id, created_at, id);

CREATE TABLE workspace_snapshot_memory (
  room_id      text NOT NULL,
  snapshot_id  text NOT NULL,
  key          text NOT NULL,
  revision     integer NOT NULL CHECK (revision >= 1),
  value        text NOT NULL CHECK (octet_length(value) <= 65536),
  content_type text NOT NULL CHECK (content_type IN ('text/markdown', 'application/json')),
  author_id    text NOT NULL,
  source_refs  jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(source_refs) = 'array'),
  redacted     boolean NOT NULL DEFAULT false,
  PRIMARY KEY (snapshot_id, key),
  FOREIGN KEY (snapshot_id, room_id) REFERENCES workspace_snapshots (id, room_id)
);

-- One row per branch room (§5, §9.7), owned by the BRANCH room: purging the branch deletes it.
-- parent_room_id and snapshot_id have no foreign key on purpose: the parent may be purged first.
CREATE TABLE room_branches (
  room_id                     text PRIMARY KEY REFERENCES rooms (id),
  parent_room_id              text NOT NULL,
  parent_revision             bigint NOT NULL CHECK (parent_revision >= 1),
  parent_commit_sha           text NOT NULL,
  snapshot_id                 text,
  last_merged_branch_revision bigint NOT NULL DEFAULT 1 CHECK (last_merged_branch_revision >= 1),
  last_merged_parent_revision bigint NOT NULL,
  created_by_user_id          text NOT NULL,
  created_at                  timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX room_branches_parent ON room_branches (parent_room_id, created_at, room_id);

ALTER TABLE changesets DROP CONSTRAINT changesets_source_check;
ALTER TABLE changesets ADD CONSTRAINT changesets_source_check
  CHECK (source IN ('EDITOR', 'SANDBOX', 'API', 'UPSTREAM', 'RESOLUTION', 'BRANCH'));
