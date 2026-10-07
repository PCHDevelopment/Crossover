-- Temporary identities for health dependency installs authorized through the egress proxy.
CREATE TABLE health_install_runs (
  id          text PRIMARY KEY,
  room_id     text NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  cache_key   text NOT NULL CHECK (cache_key ~ '^[a-f0-9]{64}$'),
  status      text NOT NULL CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED')),
  started_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at  timestamptz NOT NULL,
  finished_at timestamptz,

  CHECK (expires_at > started_at),
  CHECK ((status = 'RUNNING' AND finished_at IS NULL) OR
         (status IN ('SUCCEEDED', 'FAILED') AND finished_at IS NOT NULL))
);

CREATE UNIQUE INDEX health_install_one_running_per_room
  ON health_install_runs (room_id) WHERE status = 'RUNNING';

CREATE INDEX health_install_runs_latest
  ON health_install_runs (room_id, started_at DESC);
