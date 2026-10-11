-- Circuit breakers (T903, ARCHITECTURE §22.4): held ChangeSets wait for a lead or owner.
ALTER TABLE changesets DROP CONSTRAINT changesets_status_check;
ALTER TABLE changesets
  ADD CONSTRAINT changesets_status_check
  CHECK (status IN ('PENDING', 'HELD', 'APPLIED', 'CONFLICT', 'REJECTED')),
  ADD COLUMN rejected_at timestamptz;

-- Earlier releases did not record when a ChangeSet was abandoned. Its creation time is the only
-- available timestamp, so retain that as the best historical approximation.
UPDATE changesets
   SET rejected_at = created_at
 WHERE status = 'REJECTED' AND rejection_reason IS DISTINCT FROM 'SUPERSEDED';

CREATE INDEX changesets_rejection_streak
  ON changesets (room_id, actor_id, rejected_at)
  WHERE status = 'REJECTED' AND rejection_reason IS DISTINCT FROM 'SUPERSEDED';
