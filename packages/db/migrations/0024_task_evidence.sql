-- Evidence on submit (ARCHITECTURE §34.3, T1302). `evidence` is the latest submission's: for
-- each requirement it proves, the proof (tests run, checks, manual steps) and any sabotage
-- checks. The earlier submissions' evidence stays in the `task.submitted` events.
ALTER TABLE tasks
  ADD COLUMN evidence jsonb NOT NULL DEFAULT '[]'
    CONSTRAINT tasks_evidence_is_array CHECK (jsonb_typeof(evidence) = 'array')
    CONSTRAINT tasks_evidence_size CHECK (octet_length(evidence::text) <= 32768);
