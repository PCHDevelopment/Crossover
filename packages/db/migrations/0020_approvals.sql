-- Approval gates (ARCHITECTURE §22.2, T905): a command refused with APPROVAL_REQUIRED is kept
-- here, whole, until the owner or an admin approves it (it then runs, once, as its requester) or
-- rejects it, the requester withdraws it, or 24 hours pass.
CREATE TABLE approvals (
  id           text PRIMARY KEY,
  room_id      text NOT NULL REFERENCES rooms (id),
  requester_id text NOT NULL,
  method       text NOT NULL,
  params       jsonb NOT NULL,
  -- The requester's idempotency key, and the hash of (method, params): a retry of the same
  -- request finds its approval already waiting, or already given.
  idempotency_key text NOT NULL,
  -- Hash of (room, method, params as sent): what the idempotency key stands for, so approving can
  -- record the result under it and a later retry replays instead of running again.
  idempotency_hash text NOT NULL,
  request_hash text NOT NULL,
  -- The capability whose grant carried the gate.
  capability   text NOT NULL,
  status       text NOT NULL DEFAULT 'PENDING'
               CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'EXPIRED')),
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at   timestamptz NOT NULL,
  decided_by   text,
  decided_at   timestamptz,
  note         text CHECK (note IS NULL OR char_length(note) <= 500),

  FOREIGN KEY (requester_id, room_id) REFERENCES participants (id, room_id),
  FOREIGN KEY (decided_by, room_id) REFERENCES participants (id, room_id),
  CHECK (expires_at > created_at),
  CHECK ((status IN ('APPROVED', 'REJECTED', 'WITHDRAWN')) = (decided_by IS NOT NULL AND decided_at IS NOT NULL))
);

-- One waiting approval per identical request.
CREATE UNIQUE INDEX approvals_one_pending
  ON approvals (room_id, requester_id, request_hash) WHERE status = 'PENDING';
CREATE INDEX approvals_room_status_created ON approvals (room_id, status, created_at, id);
