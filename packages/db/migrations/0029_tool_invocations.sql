-- Tool invocations (T1201, §21.4): the claim on an idempotency key for a tool run, taken BEFORE the
-- tool's side effect, and its outcome once it has run. `outcome` is NULL while it runs.
CREATE TABLE tool_invocations (
  participant_id  text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash    text NOT NULL,
  room_id         text NOT NULL,
  tool            text NOT NULL,
  claimed_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  outcome         jsonb,
  -- Whether the run's events (`tool.completed` / `tool.failed`) are in the ledger.
  events_logged   boolean NOT NULL DEFAULT false,
  PRIMARY KEY (participant_id, idempotency_key)
);
CREATE INDEX tool_invocations_claimed_at ON tool_invocations (claimed_at);
