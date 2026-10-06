-- Canonical workspace history (§9.1) and durable ChangeSet payloads (§10.1).
-- Room columns support scoped queries and future row-level security (§23.1).
CREATE TABLE workspaces (
  id       text PRIMARY KEY,
  room_id  text NOT NULL UNIQUE REFERENCES rooms (id),
  repo_path text NOT NULL,
  UNIQUE (id, room_id)
);

CREATE TABLE workspace_revisions (
  workspace_id text NOT NULL,
  room_id      text NOT NULL,
  revision     bigint NOT NULL CHECK (revision >= 0),
  commit_sha   text NOT NULL,
  changeset_id text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, revision),
  UNIQUE (workspace_id, room_id, revision),
  FOREIGN KEY (workspace_id, room_id) REFERENCES workspaces (id, room_id)
);

CREATE TABLE file_revisions (
  workspace_id       text NOT NULL,
  room_id            text NOT NULL,
  path               text NOT NULL,
  revision           bigint NOT NULL CHECK (revision >= 1),
  workspace_revision bigint NOT NULL,
  blob_sha           text, -- NULL is a deletion; rename = deletion plus creation.
  actor_id           text NOT NULL,
  PRIMARY KEY (workspace_id, path, revision),
  FOREIGN KEY (workspace_id, room_id) REFERENCES workspaces (id, room_id),
  FOREIGN KEY (workspace_id, room_id, workspace_revision)
    REFERENCES workspace_revisions (workspace_id, room_id, revision)
);

CREATE TABLE changesets (
  id                      text PRIMARY KEY,
  workspace_id            text NOT NULL,
  room_id                 text NOT NULL,
  actor_id                text NOT NULL,
  idempotency_key          text NOT NULL, -- Command deduplication belongs to T113.
  source                  text NOT NULL
                          CHECK (source IN ('EDITOR', 'SANDBOX', 'API', 'UPSTREAM', 'RESOLUTION')),
  task_id                 text, -- References added when those domain tables exist.
  conflict_id             text,
  message                 text NOT NULL,
  base_workspace_revision bigint NOT NULL CHECK (base_workspace_revision >= 0),
  base_file_revisions     jsonb NOT NULL DEFAULT '{}',
  payload                 jsonb NOT NULL, -- Durable operations, including submitted content.
  status                  text NOT NULL DEFAULT 'PENDING'
                          CHECK (status IN ('PENDING', 'APPLIED', 'CONFLICT', 'REJECTED')),
  rejection_reason        text,
  applied_revision        bigint,
  created_at              timestamptz NOT NULL DEFAULT now(),
  applied_at              timestamptz,
  UNIQUE (id, workspace_id, room_id),
  FOREIGN KEY (workspace_id, room_id) REFERENCES workspaces (id, room_id),
  FOREIGN KEY (workspace_id, room_id, applied_revision)
    REFERENCES workspace_revisions (workspace_id, room_id, revision)
);

-- Initial revision 0 has no ChangeSet. Subsequent links cannot cross workspaces/rooms.
ALTER TABLE workspace_revisions ADD CONSTRAINT workspace_revisions_changeset_fk
  FOREIGN KEY (changeset_id, workspace_id, room_id)
  REFERENCES changesets (id, workspace_id, room_id);
