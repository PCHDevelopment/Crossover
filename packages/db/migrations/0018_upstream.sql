-- The upstream a room's workspace was imported from (ARCHITECTURE §24.1, T801). One per room.
-- `last_synced_sha` is the upstream commit the room's workspace last matched, and
-- `last_synced_room_revision` the room revision that holds it; `git.pull_upstream` (T803) moves
-- them together, only when the ChangeSet that carries the new upstream changes applies.
-- Never holds a credential: those come from the credential provider at fetch time.
CREATE TABLE upstreams (
  room_id                   text PRIMARY KEY REFERENCES rooms (id),
  workspace_id              text NOT NULL,
  url                       text NOT NULL CHECK (char_length(url) BETWEEN 1 AND 2048),
  branch                    text NOT NULL CHECK (char_length(branch) BETWEEN 1 AND 200),
  last_synced_sha           text NOT NULL CHECK (last_synced_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  last_synced_room_revision bigint NOT NULL CHECK (last_synced_room_revision >= 1),
  imported_by               text NOT NULL,
  created_at                timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at                timestamptz NOT NULL DEFAULT clock_timestamp(),

  FOREIGN KEY (workspace_id, room_id) REFERENCES workspaces (id, room_id),
  FOREIGN KEY (imported_by, room_id) REFERENCES participants (id, room_id),
  -- No userinfo in a stored URL: credentials never ride in it.
  CONSTRAINT upstreams_url_is_https CHECK (url ~ '^https://[^/@]+(/|$)')
);
