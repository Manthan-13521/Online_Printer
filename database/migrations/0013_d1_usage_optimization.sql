PRAGMA foreign_keys = ON;

-- Keep the five-minute scheduler cheap while a resumable cleanup run is open.
-- Terminal runs are excluded so historical cleanup records do not grow this index.
CREATE INDEX cleanup_runs_open_scope_idx
  ON cleanup_runs(scope, source, created_at_ms)
  WHERE status IN ('PENDING','RUNNING','PARTIAL');

-- Failed R2 cleanup must remain retryable, but not on every scheduler tick.
-- The original privacy/cutoff boundary is unchanged; these columns only pace
-- retries after an external deletion failure.
ALTER TABLE cleanup_run_items ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0
  CHECK (attempt_count >= 0);
ALTER TABLE cleanup_run_items ADD COLUMN next_attempt_at_ms INTEGER;

-- Cloudflare recommends refreshing planner statistics after schema/index work.
PRAGMA optimize;
