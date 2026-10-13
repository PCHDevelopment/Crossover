-- Archived rooms can be restored by their owner until their configured retention deadline.
-- Purge phases make external workspace removal restartable before the final database delete.
ALTER TABLE rooms
  ADD COLUMN retention_days smallint NOT NULL DEFAULT 365
    CHECK (retention_days BETWEEN 30 AND 365),
  ADD COLUMN retention_notice_sent_at timestamptz,
  ADD COLUMN purge_started_at timestamptz,
  ADD COLUMN purge_phase text
    CHECK (purge_phase IS NULL OR purge_phase IN ('WORKSPACE', 'DATABASE')),
  ADD CONSTRAINT rooms_purge_phase_started_together
    CHECK ((purge_started_at IS NULL) = (purge_phase IS NULL));

-- Older archived rows without a timestamp get a full retention period from migration time.
UPDATE rooms
   SET archived_at = clock_timestamp()
 WHERE status = 'ARCHIVED' AND archived_at IS NULL;

-- A deleted room ID can never be re-used, so its lease row has no fencing history to preserve.
ALTER TABLE room_leases DROP CONSTRAINT room_leases_room_id_fkey;
ALTER TABLE room_leases
  ADD CONSTRAINT room_leases_room_id_fkey FOREIGN KEY (room_id)
    REFERENCES rooms (id) ON DELETE CASCADE;

-- This audit survives the room and its ledger. Deliberately no foreign key to rooms/participants.
CREATE TABLE room_deletion_audit (
  room_id         text PRIMARY KEY,
  owner_id        text NOT NULL,
  archived_at     timestamptz NOT NULL,
  retention_days  smallint NOT NULL CHECK (retention_days BETWEEN 30 AND 365),
  deleted_at      timestamptz NOT NULL DEFAULT clock_timestamp()
);
