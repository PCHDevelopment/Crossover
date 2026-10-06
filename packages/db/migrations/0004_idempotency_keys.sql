-- Idempotency keys (ARCHITECTURE §16.2): a duplicate command with the same key returns the
-- stored response. Keys live 24 hours per participant (see purgeIdempotencyKeys).
-- `response` is NULL only between claiming a key and finishing the request, inside the
-- caller's transaction; a committed row always has a response.
CREATE TABLE idempotency_keys (
  participant_id  text NOT NULL,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 128),
  request_hash    text NOT NULL,
  response        jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (participant_id, idempotency_key)
);

CREATE INDEX idempotency_keys_created_at ON idempotency_keys (created_at);
