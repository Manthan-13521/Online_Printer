-- Phase 6 private customer tracking authorization.
-- tracking_token_hash already exists in the initial schema. The raw token is
-- never persisted; these timestamps bound and audit the one credential.

ALTER TABLE orders ADD COLUMN tracking_created_at_ms INTEGER;
ALTER TABLE orders ADD COLUMN tracking_expires_at_ms INTEGER;

CREATE INDEX orders_tracking_expiry_idx
  ON orders(tracking_expires_at_ms)
  WHERE tracking_token_hash IS NOT NULL;

CREATE TRIGGER orders_tracking_fields_consistent
BEFORE UPDATE OF tracking_token_hash, tracking_created_at_ms, tracking_expires_at_ms
ON orders
WHEN NOT (
  (NEW.tracking_token_hash IS NULL AND NEW.tracking_created_at_ms IS NULL
    AND NEW.tracking_expires_at_ms IS NULL)
  OR
  (NEW.tracking_token_hash IS NOT NULL AND NEW.tracking_created_at_ms IS NOT NULL
    AND NEW.tracking_expires_at_ms > NEW.tracking_created_at_ms)
)
BEGIN
  SELECT RAISE(ABORT, 'tracking authorization fields are inconsistent');
END;

CREATE TRIGGER orders_tracking_token_immutable
BEFORE UPDATE OF tracking_token_hash ON orders
WHEN OLD.tracking_token_hash IS NOT NULL
  AND NEW.tracking_token_hash IS NOT OLD.tracking_token_hash
BEGIN
  SELECT RAISE(ABORT, 'tracking authorization cannot be replaced');
END;
