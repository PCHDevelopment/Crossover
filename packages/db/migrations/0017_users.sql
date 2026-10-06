-- Platform identity for humans (ARCHITECTURE §15.3, T216): who someone is outside any room.
-- Room access still comes from membership (a participant row); a human participant points
-- back here through `participants.user_id`. OAuth providers plug into the same table by
-- using their own `provider` and the provider's stable subject id.
CREATE TABLE users (
  id               text PRIMARY KEY,
  display_name     text NOT NULL CHECK (display_name <> ''),
  provider         text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_-]{0,31}$'),
  provider_subject text NOT NULL CHECK (provider_subject <> ''),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_provider_subject_unique UNIQUE (provider, provider_subject)
);

ALTER TABLE participants
  ADD CONSTRAINT participants_user_id_fkey FOREIGN KEY (user_id) REFERENCES users (id);

CREATE INDEX participants_user_id ON participants (user_id) WHERE user_id IS NOT NULL;

-- Opaque platform session tokens, for acting outside a room (e.g. `room.create`). Only
-- sha256(token) is stored, as for room tokens (§15.3).
CREATE TABLE user_sessions (
  token_hash text PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT user_sessions_expiry_after_creation CHECK (expires_at > created_at)
);

CREATE INDEX user_sessions_user_id ON user_sessions (user_id);
