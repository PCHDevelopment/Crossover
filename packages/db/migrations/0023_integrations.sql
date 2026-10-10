-- Room-scoped integration credentials (ARCHITECTURE §21.5, T1203).
-- Plaintext data keys never reach PostgreSQL; production stores their KMS-wrapped form only.
CREATE TABLE integration_room_keys (
  room_id           text PRIMARY KEY REFERENCES rooms (id) ON DELETE CASCADE,
  key_strategy      text NOT NULL CHECK (key_strategy IN ('CONFIG', 'KMS')),
  wrapped_data_key  text,
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT integration_room_keys_wrapped_check CHECK (
    (key_strategy = 'CONFIG' AND wrapped_data_key IS NULL)
    OR (key_strategy = 'KMS' AND wrapped_data_key IS NOT NULL AND length(wrapped_data_key) > 0)
  )
);

CREATE TABLE integrations (
  room_id          text NOT NULL,
  provider         text NOT NULL CHECK (
    provider IN ('github', 'aws') OR provider ~ '^oauth:[a-z][a-z0-9_]{1,31}$'
  ),
  status           text NOT NULL CHECK (status IN ('PENDING', 'CONNECTED', 'EXPIRED')),
  status_reason    text,
  public_config    jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(public_config) = 'object'),
  encrypted_secret jsonb NOT NULL CHECK (
    jsonb_typeof(encrypted_secret) = 'object'
    AND encrypted_secret->>'version' = '1'
    AND jsonb_typeof(encrypted_secret->'iv') = 'string'
    AND jsonb_typeof(encrypted_secret->'ciphertext') = 'string'
    AND jsonb_typeof(encrypted_secret->'tag') = 'string'
  ),
  connected_at     timestamptz,
  connected_by     text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at       timestamptz NOT NULL DEFAULT clock_timestamp(),

  PRIMARY KEY (room_id, provider),
  CONSTRAINT integrations_room_fk
    FOREIGN KEY (room_id) REFERENCES rooms (id) ON DELETE CASCADE,
  CONSTRAINT integrations_room_key_fk
    FOREIGN KEY (room_id) REFERENCES integration_room_keys (room_id) ON DELETE CASCADE,
  CONSTRAINT integrations_connected_by_fk
    FOREIGN KEY (connected_by, room_id) REFERENCES participants (id, room_id)
);

CREATE INDEX integrations_room_status ON integrations (room_id, status, provider COLLATE "C");
