-- Checkpoints: a workspace revision the lead or owner marked as a good state to export (§24.3).
CREATE TABLE checkpoints (
  id            text PRIMARY KEY,
  room_id       text NOT NULL REFERENCES rooms (id),
  workspace_id  text NOT NULL,
  revision      bigint NOT NULL CHECK (revision >= 1),
  message       text NOT NULL CHECK (char_length(message) BETWEEN 1 AND 500),
  created_by    text NOT NULL,
  -- The health run that covered the revision when it was marked; null if the room has no
  -- health command. Anything but GREEN means the owner overrode.
  health_status text CHECK (health_status IN ('GREEN', 'RED', 'ERROR', 'PENDING')),
  overridden    boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp(),

  FOREIGN KEY (workspace_id, room_id, revision)
    REFERENCES workspace_revisions (workspace_id, room_id, revision),
  FOREIGN KEY (created_by, room_id) REFERENCES participants (id, room_id),
  UNIQUE (room_id, revision),
  CHECK (overridden OR health_status IS NULL OR health_status = 'GREEN')
);
CREATE INDEX checkpoints_room_created ON checkpoints (room_id, created_at, id);
