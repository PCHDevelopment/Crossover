-- Scope stale health-install cleanup to the server process that owns each run.
-- Rows created before this migration (and by older binaries) remain safe until expiry.
ALTER TABLE health_install_runs
  ADD COLUMN node_id text NOT NULL DEFAULT 'legacy';

CREATE INDEX health_install_runs_node_running
  ON health_install_runs (node_id, started_at)
  WHERE status = 'RUNNING';
