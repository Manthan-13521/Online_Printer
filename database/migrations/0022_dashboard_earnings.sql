-- Fix daily stats to accurately reflect financial reality and consistent order counts
ALTER TABLE daily_order_stats ADD COLUMN earnings_paise INTEGER NOT NULL DEFAULT 0;
ALTER TABLE daily_order_stats ADD COLUMN created_count INTEGER NOT NULL DEFAULT 0;

-- Backfill earnings_paise using ALL available payment data
UPDATE daily_order_stats
SET earnings_paise = COALESCE((
  SELECT SUM(amount_paise)
  FROM payments
  WHERE status = 'PAID'
    AND strftime('%Y-%m-%d', datetime(verified_at_ms / 1000 + 19800, 'unixepoch')) = daily_order_stats.date_key
), 0) + COALESCE((
  SELECT SUM(amount_paise)
  FROM retained_payment_records
  WHERE status = 'PAID'
    AND strftime('%Y-%m-%d', datetime(verified_at_ms / 1000 + 19800, 'unixepoch')) = daily_order_stats.date_key
), 0);

-- Backfill created_count using ALL available order data
UPDATE daily_order_stats
SET created_count = COALESCE((
  SELECT COUNT(*)
  FROM orders
  WHERE strftime('%Y-%m-%d', datetime(created_at_ms / 1000 + 19800, 'unixepoch')) = daily_order_stats.date_key
), 0) + COALESCE((
  SELECT COUNT(*)
  FROM retained_order_history
  WHERE strftime('%Y-%m-%d', datetime(created_at_ms / 1000 + 19800, 'unixepoch')) = daily_order_stats.date_key
), 0);

-- Trigger to track earnings when payment is verified
CREATE TRIGGER payments_daily_earnings_update
AFTER UPDATE OF status ON payments
WHEN NEW.status = 'PAID' AND OLD.status != 'PAID'
BEGIN
  INSERT INTO daily_order_stats (date_key, earnings_paise, created_count, updated_at_ms)
  VALUES (
    strftime('%Y-%m-%d', datetime(NEW.verified_at_ms / 1000 + 19800, 'unixepoch')),
    NEW.amount_paise,
    0,
    NEW.verified_at_ms
  )
  ON CONFLICT(date_key) DO UPDATE SET
    earnings_paise = daily_order_stats.earnings_paise + excluded.earnings_paise,
    updated_at_ms = excluded.updated_at_ms;
END;

-- Trigger to track orders when created
CREATE TRIGGER orders_daily_created_insert
AFTER INSERT ON orders
BEGIN
  INSERT INTO daily_order_stats (date_key, created_count, earnings_paise, updated_at_ms)
  VALUES (
    strftime('%Y-%m-%d', datetime(NEW.created_at_ms / 1000 + 19800, 'unixepoch')),
    1,
    0,
    NEW.created_at_ms
  )
  ON CONFLICT(date_key) DO UPDATE SET
    created_count = daily_order_stats.created_count + 1,
    updated_at_ms = excluded.updated_at_ms;
END;

-- Trigger to deduct earnings when payment is refunded
CREATE TRIGGER payments_daily_earnings_refund
AFTER UPDATE OF status ON payments
WHEN NEW.status = 'REFUNDED' AND OLD.status = 'PAID'
BEGIN
  UPDATE daily_order_stats
  SET 
    earnings_paise = daily_order_stats.earnings_paise - NEW.amount_paise,
    updated_at_ms = NEW.updated_at_ms
  WHERE date_key = strftime('%Y-%m-%d', datetime(NEW.verified_at_ms / 1000 + 19800, 'unixepoch'));
END;

-- Phase 2 Recovery Foundation columns (restored for schema parity with production)
ALTER TABLE installation ADD COLUMN recovery_lock_id TEXT;
ALTER TABLE installation ADD COLUMN recovery_locked_at_ms INTEGER;
ALTER TABLE installation ADD COLUMN claims_paused INTEGER NOT NULL DEFAULT 0 CHECK (claims_paused IN (0, 1));
ALTER TABLE print_attempts ADD COLUMN last_progress_at_ms INTEGER;
