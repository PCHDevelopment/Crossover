-- Durable workspace conflicts and their counterparties (ARCHITECTURE §11.1).
CREATE TABLE conflicts (
  id                         text PRIMARY KEY,
  workspace_id               text NOT NULL,
  room_id                    text NOT NULL,
  changeset_id               text NOT NULL,
  submitter_id               text NOT NULL,
  base_revision              bigint NOT NULL CHECK (base_revision >= 0),
  head_revision_at_detection bigint NOT NULL CHECK (head_revision_at_detection >= base_revision),
  files                      jsonb NOT NULL CHECK (jsonb_typeof(files) = 'array'),
  counterparty_changesets    jsonb NOT NULL DEFAULT '[]'::jsonb
                             CHECK (jsonb_typeof(counterparty_changesets) = 'array'),
  status                     text NOT NULL DEFAULT 'OPEN'
                             CHECK (status IN ('OPEN', 'ESCALATED', 'RESOLVED', 'ABANDONED')),
  attempts                   integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  resolver_id                text,
  resolution_changeset_id    text,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  escalated_at               timestamptz,
  resolved_at                timestamptz,

  CONSTRAINT conflicts_id_workspace_room_unique UNIQUE (id, workspace_id, room_id),
  CONSTRAINT conflicts_changeset_unique UNIQUE (changeset_id, workspace_id, room_id),
  CONSTRAINT conflicts_workspace_fk FOREIGN KEY (workspace_id, room_id)
    REFERENCES workspaces (id, room_id),
  CONSTRAINT conflicts_changeset_fk FOREIGN KEY (changeset_id, workspace_id, room_id)
    REFERENCES changesets (id, workspace_id, room_id),
  CONSTRAINT conflicts_submitter_fk FOREIGN KEY (submitter_id, room_id)
    REFERENCES participants (id, room_id),
  CONSTRAINT conflicts_resolver_fk FOREIGN KEY (resolver_id, room_id)
    REFERENCES participants (id, room_id),
  CONSTRAINT conflicts_resolution_changeset_fk FOREIGN KEY (resolution_changeset_id, workspace_id, room_id)
    REFERENCES changesets (id, workspace_id, room_id)
);

ALTER TABLE changesets ADD CONSTRAINT changesets_conflict_fk
  FOREIGN KEY (conflict_id, workspace_id, room_id)
  REFERENCES conflicts (id, workspace_id, room_id);

CREATE INDEX conflicts_room_status_created ON conflicts (room_id, status, created_at DESC);
CREATE INDEX conflicts_submitter_created ON conflicts (room_id, submitter_id, created_at DESC);
