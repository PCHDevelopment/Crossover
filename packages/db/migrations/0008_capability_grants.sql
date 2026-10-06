-- Capability grants and revocations beyond the role bundle (ARCHITECTURE §21.1, T210).
-- Effective capabilities = role bundle + active GRANT rows - active DENY rows, evaluated on
-- every command, so a revocation takes effect on the next one.
--
--   GRANT  adds a capability (with an optional scope, an optional expiry, and optionally an
--          approval gate, §22.2).
--   DENY   removes one from what the role bundle gives; written by `capabilities.revoke`.
--
-- Rows are never deleted: `ended_at` records when a grant was revoked, superseded or a deny
-- was lifted, so the history stays. A row whose `expires_at` has passed is simply ignored.
CREATE TABLE capability_grants (
  id                text PRIMARY KEY,
  room_id           text NOT NULL REFERENCES rooms (id),
  participant_id    text NOT NULL,
  effect            text NOT NULL CHECK (effect IN ('GRANT', 'DENY')),
  -- `<resource>.<action>[:<scope>]`, validated by the application.
  capability        text NOT NULL CHECK (capability <> '' AND length(capability) <= 512),
  requires_approval boolean NOT NULL DEFAULT false,
  created_by        text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at        timestamptz,
  ended_at          timestamptz,
  ended_by          text,

  FOREIGN KEY (participant_id, room_id) REFERENCES participants (id, room_id),
  FOREIGN KEY (created_by, room_id) REFERENCES participants (id, room_id),
  FOREIGN KEY (ended_by, room_id) REFERENCES participants (id, room_id),
  CONSTRAINT capability_grants_approval_only_grants CHECK (effect = 'GRANT' OR NOT requires_approval),
  CONSTRAINT capability_grants_expiry_after_creation CHECK (expires_at IS NULL OR expires_at > created_at),
  CONSTRAINT capability_grants_ended_by_set CHECK ((ended_at IS NULL) = (ended_by IS NULL))
);

-- At most one live row per (participant, effect, capability): granting again refreshes it.
CREATE UNIQUE INDEX capability_grants_one_live
  ON capability_grants (participant_id, effect, capability) WHERE ended_at IS NULL;

-- What authorize() reads on every command.
CREATE INDEX capability_grants_live_by_participant
  ON capability_grants (room_id, participant_id) WHERE ended_at IS NULL;
