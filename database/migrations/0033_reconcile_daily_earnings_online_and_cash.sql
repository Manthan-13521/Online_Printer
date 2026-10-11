-- Migration 0033: Reconcile Daily Earnings for Both Online and Cash Orders
-- Restores payment triggers dropped during migration 0029 table rebuild
-- and backfills daily_order_stats to accurately aggregate both online and cash orders.

-- 1. Restore trigger for payment updates to PAID (online payments captured via Razorpay webhook)
DROP TRIGGER IF EXISTS payments_daily_earnings_update;
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

-- 2. Restore/ensure trigger for direct PAID payment inserts (cash confirmations)
DROP TRIGGER IF EXISTS payments_daily_earnings_insert;
CREATE TRIGGER payments_daily_earnings_insert
AFTER INSERT ON payments
WHEN NEW.status = 'PAID'
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

-- 3. Restore refund trigger
DROP TRIGGER IF EXISTS payments_daily_earnings_refund;
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

-- 4. Backfill daily_order_stats to accurately reflect both online and cash orders
UPDATE daily_order_stats
SET earnings_paise = COALESCE((
  SELECT SUM(amount_paise)
  FROM (
    SELECT p.amount_paise
    FROM payments p
    WHERE p.status = 'PAID'
      AND strftime('%Y-%m-%d', datetime(p.verified_at_ms / 1000 + 19800, 'unixepoch')) = daily_order_stats.date_key
    UNION ALL
    SELECT o.total_amount_paise AS amount_paise
    FROM orders o
    WHERE o.payment_method = 'CASH'
      AND o.status NOT IN ('CANCELLED', 'DRAFT')
      AND strftime('%Y-%m-%d', datetime(COALESCE(o.cash_confirmed_at_ms, o.paid_at_ms, o.created_at_ms) / 1000 + 19800, 'unixepoch')) = daily_order_stats.date_key
      AND NOT EXISTS (
        SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.status = 'PAID'
      )
  )
), 0) + COALESCE((
  SELECT SUM(amount_paise)
  FROM retained_payment_records
  WHERE status = 'PAID'
    AND strftime('%Y-%m-%d', datetime(verified_at_ms / 1000 + 19800, 'unixepoch')) = daily_order_stats.date_key
), 0);
