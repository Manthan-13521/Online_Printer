-- Anonymous operational summary survives disposal of customer workload.
-- Pickup codes, document names, customer fields, raw errors and R2 keys do not.
CREATE TABLE retained_order_history (
  id TEXT PRIMARY KEY NOT NULL,
  created_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER,
  final_status TEXT NOT NULL,
  is_priority INTEGER NOT NULL,
  is_manual INTEGER NOT NULL,
  online_paid_paise INTEGER NOT NULL,
  due_at_pickup_paise INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL,
  printer_name TEXT,
  fallback_printer_name TEXT,
  addon_summary_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(addon_summary_json)),
  had_failure INTEGER NOT NULL DEFAULT 0,
  had_uncertain INTEGER NOT NULL DEFAULT 0,
  purged_at_ms INTEGER NOT NULL
) STRICT;

CREATE INDEX retained_order_history_created_idx
  ON retained_order_history(created_at_ms DESC, id DESC);

CREATE INDEX orders_cleanup_created_idx
  ON orders(created_at_ms, id) WHERE cleanup_state = 'ACTIVE';

CREATE INDEX cleanup_runs_scope_source_status_idx
  ON cleanup_runs(scope, source, status, created_at_ms);

CREATE INDEX cleanup_run_items_retry_idx
  ON cleanup_run_items(run_id, status, next_attempt_at_ms, updated_at_ms);
