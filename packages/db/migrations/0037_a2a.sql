-- A2A v1.0.0 remote registry and outbound calls (ARCHITECTURE §15.5, T1618).
CREATE TABLE a2a_remotes (
  participant_id text PRIMARY KEY,
  room_id text NOT NULL,
  card_url text NOT NULL CHECK (length(card_url) <= 2048),
  card jsonb,
  endpoint_url text,
  card_status text NOT NULL DEFAULT 'PENDING' CHECK (card_status IN ('PENDING', 'OK', 'FAILED')),
  card_error text CHECK (length(card_error) <= 500),
  card_fetched_at timestamptz,
  write_files boolean NOT NULL DEFAULT false,
  auth_secret jsonb,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (participant_id, room_id) REFERENCES participants (id, room_id)
);

CREATE TABLE a2a_calls (
  id text PRIMARY KEY,
  room_id text NOT NULL,
  UNIQUE (id, room_id),
  remote_id text NOT NULL,
  trigger_inbox_id text NOT NULL UNIQUE,
  trigger_kind text NOT NULL CHECK (trigger_kind IN ('MENTION', 'ASSIGNMENT')),
  message_id text,
  task_id text,
  continues_call_id text,
  remote_task_id text CHECK (length(remote_task_id) <= 200),
  remote_context_id text CHECK (length(remote_context_id) <= 200),
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN (
    'PENDING', 'SENT', 'WORKING', 'INPUT_REQUIRED', 'AUTH_REQUIRED',
    'COMPLETED', 'FAILED', 'CANCELED', 'REJECTED', 'ERROR')),
  base_revision bigint,
  last_posted_message_id text,
  reply_body text CHECK (length(reply_body) <= 40000),
  poll_failures integer NOT NULL DEFAULT 0 CHECK (poll_failures >= 0),
  next_poll_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_error text CHECK (length(last_error) <= 500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  FOREIGN KEY (remote_id, room_id) REFERENCES participants (id, room_id),
  FOREIGN KEY (continues_call_id, room_id) REFERENCES a2a_calls (id, room_id)
);

CREATE INDEX a2a_calls_due ON a2a_calls (next_poll_at) WHERE finished_at IS NULL;
CREATE INDEX a2a_calls_remote_open ON a2a_calls (remote_id) WHERE finished_at IS NULL;
