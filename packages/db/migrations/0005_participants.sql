-- Participants (ARCHITECTURE §6.5). Two orthogonal layers: `authority` (who governs the
-- room) and `role` (how work is organized). Capability grants beyond the role defaults live
-- in their own table (T210), not here.
CREATE TABLE participants (
  id            text PRIMARY KEY,
  room_id       text NOT NULL REFERENCES rooms (id),
  kind          text NOT NULL CHECK (kind IN ('HUMAN', 'AGENT')),
  display_name  text NOT NULL,
  authority     text NOT NULL DEFAULT 'MEMBER' CHECK (authority IN ('OWNER', 'ADMIN', 'MEMBER')),
  role          text NOT NULL CHECK (role IN ('LEAD', 'DEVELOPER', 'REVIEWER', 'OBSERVER')),
  status        text NOT NULL DEFAULT 'INVITED'
                CHECK (status IN ('INVITED', 'ACTIVE', 'PAUSED', 'REMOVED')),
  agent_manifest jsonb,
  user_id       text,
  budgets       jsonb NOT NULL DEFAULT '{}',
  joined_at     timestamptz,
  last_seen_at  timestamptz,

  -- D8: only humans can hold governing authority.
  CONSTRAINT participants_authority_human_only
    CHECK (authority = 'MEMBER' OR kind = 'HUMAN'),
  -- §6.5: `user_id` is for humans, `agent_manifest` for agents.
  CONSTRAINT participants_user_id_humans_only CHECK (kind = 'HUMAN' OR user_id IS NULL),
  CONSTRAINT participants_manifest_agents_only CHECK (kind = 'AGENT' OR agent_manifest IS NULL),

  -- Lets other room-scoped tables reference (participant_id, room_id) so a row can never
  -- point at a participant of a different room.
  CONSTRAINT participants_id_room_unique UNIQUE (id, room_id)
);

-- Exactly one owner per room (§6.1).
CREATE UNIQUE INDEX participants_one_owner_per_room ON participants (room_id) WHERE authority = 'OWNER';

CREATE INDEX participants_room_id ON participants (room_id);
