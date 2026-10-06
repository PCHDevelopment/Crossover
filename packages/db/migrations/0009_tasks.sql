-- Tasks and their reviews (ARCHITECTURE §8.1, §8.2, T301). Every task belongs to a room and
-- refers to participants of that same room through composite foreign keys.
CREATE TABLE tasks (
  id                   text PRIMARY KEY,
  room_id              text NOT NULL REFERENCES rooms (id),
  title                text NOT NULL CHECK (title <> ''),
  description          text NOT NULL DEFAULT '',
  -- Explicit completion criteria: a JSON array of strings (at least one is enforced when a
  -- task is created, T302).
  requirements         jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(requirements) = 'array'),
  owner_id             text,
  created_by           text NOT NULL,
  status               text NOT NULL DEFAULT 'OPEN'
                       CHECK (status IN ('OPEN', 'CLAIMED', 'IN_PROGRESS', 'BLOCKED', 'REVIEW', 'DONE', 'CANCELLED')),
  -- 0 is P0 (most urgent) to 3 is P3.
  priority             smallint NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 3),
  -- Other tasks' ids. Validated by the application: an array can't carry foreign keys.
  dependencies         text[] NOT NULL DEFAULT '{}',
  -- Related files and ChangeSets, as a JSON array.
  artifacts            jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(artifacts) = 'array'),
  reviewer_id          text,
  review_required      boolean NOT NULL DEFAULT true,
  -- Set by the lead so a task can start before its dependencies are DONE (§8.2).
  override_dependencies boolean NOT NULL DEFAULT false,
  blocked_reason       text,
  lease_expires_at     timestamptz,
  version              integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at           timestamptz NOT NULL DEFAULT clock_timestamp(),

  FOREIGN KEY (owner_id, room_id) REFERENCES participants (id, room_id),
  FOREIGN KEY (created_by, room_id) REFERENCES participants (id, room_id),
  FOREIGN KEY (reviewer_id, room_id) REFERENCES participants (id, room_id),
  CONSTRAINT tasks_id_room_unique UNIQUE (id, room_id),
  -- A reason is required while a task is blocked.
  CONSTRAINT tasks_blocked_needs_reason
    CHECK (status <> 'BLOCKED' OR (blocked_reason IS NOT NULL AND blocked_reason <> '')),
  -- Nobody owns an open task; every claimed, running, blocked or reviewed one has an owner.
  CONSTRAINT tasks_open_has_no_owner CHECK (status <> 'OPEN' OR owner_id IS NULL),
  CONSTRAINT tasks_active_has_owner
    CHECK (status NOT IN ('CLAIMED', 'IN_PROGRESS', 'BLOCKED', 'REVIEW') OR owner_id IS NOT NULL)
);

CREATE INDEX tasks_room_status ON tasks (room_id, status);
CREATE INDEX tasks_room_created ON tasks (room_id, created_at, id);
CREATE INDEX tasks_room_owner ON tasks (room_id, owner_id) WHERE owner_id IS NOT NULL;
-- The lease sweeper (T311) looks for claims whose lease has run out.
CREATE INDEX tasks_lease_expiry ON tasks (lease_expires_at) WHERE lease_expires_at IS NOT NULL;

CREATE TABLE task_reviews (
  id          text PRIMARY KEY,
  room_id     text NOT NULL,
  task_id     text NOT NULL,
  reviewer_id text NOT NULL,
  verdict     text NOT NULL CHECK (verdict IN ('APPROVE', 'REQUEST_CHANGES')),
  comments    text NOT NULL DEFAULT '',
  -- The workspace revision that was reviewed.
  revision    bigint NOT NULL CHECK (revision >= 0),
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),

  FOREIGN KEY (task_id, room_id) REFERENCES tasks (id, room_id),
  FOREIGN KEY (reviewer_id, room_id) REFERENCES participants (id, room_id)
);

CREATE INDEX task_reviews_task ON task_reviews (task_id, created_at);
