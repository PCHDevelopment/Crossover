-- Room ownership leases (ARCHITECTURE §4.2): one row per room that has ever been owned.
-- Rows are never deleted: fencing_token must keep increasing across owners so a stale
-- ("zombie") writer's token can never match again. Releasing a lease expires it instead.
CREATE TABLE room_leases (
  room_id       text PRIMARY KEY REFERENCES rooms (id),
  node_id       text NOT NULL,
  fencing_token bigint NOT NULL CHECK (fencing_token >= 1),
  expires_at    timestamptz NOT NULL
);
