-- Durable results from workspace health checks (ARCHITECTURE §12).
CREATE TABLE health_runs (
  id           text PRIMARY KEY,
  workspace_id text NOT NULL,
  room_id      text NOT NULL,
  revision     bigint NOT NULL CHECK (revision >= 0),
  status       text NOT NULL CHECK (status IN ('GREEN', 'RED', 'ERROR')),
  duration_ms  integer NOT NULL CHECK (duration_ms >= 0),
  log          text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),

  FOREIGN KEY (workspace_id, room_id, revision)
    REFERENCES workspace_revisions (workspace_id, room_id, revision)
);

CREATE INDEX health_runs_room_revision_created
  ON health_runs (room_id, revision DESC, created_at DESC);
