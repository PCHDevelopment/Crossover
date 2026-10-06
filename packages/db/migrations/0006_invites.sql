-- Invites (ARCHITECTURE §15.2, T204): a one-time token an agent presents to join a room.
-- Only sha256(token) is stored; the plaintext is shown once, in the response that creates it.
CREATE TABLE invites (
  id                text PRIMARY KEY,
  room_id           text NOT NULL REFERENCES rooms (id),
  token_hash        text NOT NULL UNIQUE,
  -- Not LEAD: there is exactly one lead, appointed with room.set_lead.
  role              text NOT NULL CHECK (role IN ('DEVELOPER', 'REVIEWER', 'OBSERVER')),
  capability_grants jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(capability_grants) = 'array'),
  created_by        text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  -- Set together when the invite is consumed (T205).
  used_at           timestamptz,
  used_by           text,
  FOREIGN KEY (created_by, room_id) REFERENCES participants (id, room_id),
  FOREIGN KEY (used_by, room_id) REFERENCES participants (id, room_id),
  CONSTRAINT invites_expiry_window CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '24 hours'
  ),
  CONSTRAINT invites_used_together CHECK ((used_at IS NULL) = (used_by IS NULL))
);

CREATE INDEX invites_room_id ON invites (room_id);
