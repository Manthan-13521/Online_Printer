PRAGMA foreign_keys = ON;

-- Optimize Live Orders filtering and bounded scan by status and updated timestamp
CREATE INDEX IF NOT EXISTS orders_status_updated_idx
  ON orders(status, updated_at_ms DESC);

-- Optimize latest print attempt lookup per order
CREATE INDEX IF NOT EXISTS print_attempts_order_attempt_idx
  ON print_attempts(order_id, attempt_number DESC);
