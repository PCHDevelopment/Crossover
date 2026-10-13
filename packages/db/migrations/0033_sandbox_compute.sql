-- Daily sandbox CPU accounting (T1504). Usage and outstanding reservations are separate so
-- concurrent execs can reserve capacity before they start and reconcile against cgroup samples.
CREATE TABLE sandbox_compute_room_daily (
  room_id text NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  usage_date date NOT NULL,
  used_cpu_usec bigint NOT NULL DEFAULT 0 CHECK (used_cpu_usec >= 0),
  reserved_cpu_usec bigint NOT NULL DEFAULT 0 CHECK (reserved_cpu_usec >= 0),
  PRIMARY KEY (room_id, usage_date)
);

CREATE TABLE sandbox_compute_agent_daily (
  room_id text NOT NULL,
  participant_id text NOT NULL,
  usage_date date NOT NULL,
  used_cpu_usec bigint NOT NULL DEFAULT 0 CHECK (used_cpu_usec >= 0),
  reserved_cpu_usec bigint NOT NULL DEFAULT 0 CHECK (reserved_cpu_usec >= 0),
  PRIMARY KEY (room_id, participant_id, usage_date),
  FOREIGN KEY (participant_id, room_id)
    REFERENCES participants (id, room_id) ON DELETE CASCADE
);

CREATE TABLE sandbox_compute_samples (
  sandbox_id text PRIMARY KEY REFERENCES sandboxes (id) ON DELETE CASCADE,
  last_usage_usec bigint NOT NULL CHECK (last_usage_usec >= 0),
  generation text NOT NULL,
  sampled_at timestamptz NOT NULL
);

CREATE TABLE sandbox_compute_reservations (
  exec_id text PRIMARY KEY,
  room_id text NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  participant_id text NOT NULL,
  sandbox_id text NOT NULL REFERENCES sandboxes (id) ON DELETE CASCADE,
  usage_date date NOT NULL,
  remaining_cpu_usec bigint NOT NULL CHECK (remaining_cpu_usec >= 0),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (participant_id, room_id)
    REFERENCES participants (id, room_id) ON DELETE CASCADE
);

CREATE INDEX sandbox_compute_reservations_expiry
  ON sandbox_compute_reservations (expires_at);
CREATE INDEX sandbox_compute_reservations_sandbox_day
  ON sandbox_compute_reservations (sandbox_id, usage_date, created_at);
