-- Redaction reaches the copies of an event's text that a reader can still fetch (§19.6, T906):
-- a redacted message or memory revision keeps its row, with the text blanked and this flag set.
ALTER TABLE messages ADD COLUMN redacted boolean NOT NULL DEFAULT false;
ALTER TABLE memory_entries ADD COLUMN redacted boolean NOT NULL DEFAULT false;
ALTER TABLE memory_revisions ADD COLUMN redacted boolean NOT NULL DEFAULT false;

-- A message needs text, except once it is redacted.
ALTER TABLE messages DROP CONSTRAINT messages_body_check;
ALTER TABLE messages ADD CONSTRAINT messages_body_check
  CHECK (octet_length(body) <= 32768 AND (redacted OR octet_length(body) >= 1));
