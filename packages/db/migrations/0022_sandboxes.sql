-- Per-participant execution workspaces (ARCHITECTURE §14).
CREATE TABLE sandboxes (
  id             text PRIMARY KEY,
  room_id        text NOT NULL,
  participant_id text NOT NULL,
  status         text NOT NULL CHECK (status IN ('CREATING', 'RUNNING', 'HIBERNATED', 'DESTROYED')),
  base_revision  bigint CHECK (base_revision >= 0),
  volume_ref     text,
  container_ref  text,
  last_active_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at     timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT sandboxes_participant_room_unique UNIQUE (room_id, participant_id),
  CONSTRAINT sandboxes_participant_room_fk
    FOREIGN KEY (participant_id, room_id) REFERENCES participants (id, room_id),
  CONSTRAINT sandboxes_resource_refs_check CHECK (
    (status IN ('RUNNING', 'HIBERNATED') AND volume_ref IS NOT NULL AND container_ref IS NOT NULL)
    OR status IN ('CREATING', 'DESTROYED')
  )
);

CREATE INDEX sandboxes_idle_running ON sandboxes (last_active_at)
  WHERE status = 'RUNNING';
