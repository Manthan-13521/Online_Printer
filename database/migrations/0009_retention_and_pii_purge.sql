PRAGMA foreign_keys = ON;

-- Phase 12: Automated Retention, R2 PDF Deletion & Customer PII Purge
-- Supports fast indexed queries for scheduled cleanup without full table scans.

-- 1. Track PII redaction timestamp on orders
ALTER TABLE orders ADD COLUMN pii_purged_at_ms INTEGER;

-- 2. Partial index for fast, zero-scan lookup of completed orders needing PII purge (completed >= 5 hours ago)
CREATE INDEX IF NOT EXISTS orders_pii_purge_idx
  ON orders(completed_at_ms)
  WHERE status = 'COMPLETED' AND pii_purged_at_ms IS NULL AND completed_at_ms IS NOT NULL;

-- 3. Optimized cleanup index for uploads awaiting deletion (unpaid, failed, completed, unresolved failure)
CREATE INDEX IF NOT EXISTS uploads_retention_cleanup_idx
  ON uploads(delete_after_ms)
  WHERE storage_status <> 'DELETED' AND delete_after_ms IS NOT NULL;

-- 4. Backfill existing historical unresolved paid orders with 24-hour maximum retention limit
UPDATE uploads
SET retention_reason = 'UNRESOLVED_PAID_FAILURE',
    delete_after_ms = (
      SELECT COALESCE(o.paid_at_ms, o.created_at_ms) + 86400000
      FROM orders o WHERE o.id = uploads.order_id
    )
WHERE storage_status = 'UPLOADED'
  AND retention_reason IS NULL
  AND delete_after_ms IS NULL
  AND EXISTS (
    SELECT 1 FROM orders o
    WHERE o.id = uploads.order_id
      AND o.status IN (
        'PAID', 'QUEUED', 'CLAIMED', 'SPOOLING', 'PRINTING',
        'PRINT_BLOCKED', 'PRINT_FAILED', 'ADMIN_ACTION_REQUIRED'
      )
  );
