-- Wake-up webhooks as an outbox (ARCHITECTURE §17.4, T706): every node can run the delivery loop
-- and the database decides who sends what, so an item is announced once however many nodes run,
-- one that commits late is never skipped, and nothing is lost in a restart.
--
-- `wake_notified_at` is set once an item was announced (or doesn't need to be: its recipient
-- isn't an agent with a webhook). History before this migration counts as announced.
ALTER TABLE inbox_items ADD COLUMN wake_notified_at timestamptz;
UPDATE inbox_items SET wake_notified_at = clock_timestamp();

CREATE INDEX inbox_items_wake_pending
  ON inbox_items (participant_id, created_at, id)
  WHERE wake_notified_at IS NULL AND acked_at IS NULL;

-- One row per agent that has been woken: when the last delivery was tried (a try opens the
-- 30-second window, a failure widens it) and how many in a row failed.
CREATE TABLE wake_windows (
  participant_id text PRIMARY KEY,
  room_id        text NOT NULL,
  last_sent_at   timestamptz NOT NULL,
  failures       integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
  FOREIGN KEY (participant_id, room_id) REFERENCES participants (id, room_id)
);
