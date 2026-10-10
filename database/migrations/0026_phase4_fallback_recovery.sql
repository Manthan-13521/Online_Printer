-- Migration 0026: Phase 4 Safe Fallback, Printer Failure Recovery & Queue Unstarvation
-- Tracks fallback authorization provenance and unstarved retry queue status

ALTER TABLE print_attempts ADD COLUMN fallback_reason TEXT;
ALTER TABLE print_attempts ADD COLUMN fallback_authorized_at_ms INTEGER;

ALTER TABLE orders ADD COLUMN fallback_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN blocked_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_orders_blocked_retry ON orders(status, next_retry_at_ms)
  WHERE status IN ('PRINT_BLOCKED', 'RETRY_PENDING');
