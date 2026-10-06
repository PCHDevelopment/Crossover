-- Opaque access and refresh tokens (ARCHITECTURE §15.3). Only sha256(token) is stored; the
-- plaintext exists once, in the response that issues it. Tokens of one login share a
-- family_id so reuse of a rotated refresh token can revoke the whole family.
CREATE TABLE auth_tokens (
  token_hash     text PRIMARY KEY,
  kind           text NOT NULL CHECK (kind IN ('ACCESS', 'REFRESH')),
  participant_id text NOT NULL,
  room_id        text NOT NULL,
  family_id      text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  -- Refresh tokens only: set when the token has been exchanged for a new pair.
  used_at        timestamptz,
  revoked_at     timestamptz,
  FOREIGN KEY (participant_id, room_id) REFERENCES participants (id, room_id),
  CONSTRAINT auth_tokens_used_only_refresh CHECK (kind = 'REFRESH' OR used_at IS NULL)
);

CREATE INDEX auth_tokens_family_id ON auth_tokens (family_id);
CREATE INDEX auth_tokens_participant_id ON auth_tokens (participant_id);
