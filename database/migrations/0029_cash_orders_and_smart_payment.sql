-- Migration 0029: Cash Orders and Smart Payment Toggle

-- 1. Add cash_orders_enabled toggle to installation (default 0 / OFF)
ALTER TABLE installation ADD COLUMN cash_orders_enabled INTEGER NOT NULL DEFAULT 0 CHECK (cash_orders_enabled IN (0, 1));

-- 2. Add cash order tracking columns to orders
ALTER TABLE orders ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'ONLINE' CHECK (payment_method IN ('ONLINE', 'CASH'));
ALTER TABLE orders ADD COLUMN cash_selected_at_ms INTEGER;
ALTER TABLE orders ADD COLUMN cash_expires_at_ms INTEGER;
ALTER TABLE orders ADD COLUMN cash_grace_until_ms INTEGER;
ALTER TABLE orders ADD COLUMN cash_confirmed_at_ms INTEGER;
ALTER TABLE orders ADD COLUMN cash_confirmed_by_admin_id TEXT;

-- 3. Index for efficient lookup of pending cash orders in Admin UI
CREATE INDEX IF NOT EXISTS idx_orders_cash_pending 
  ON orders(payment_method, status, cash_grace_until_ms);

-- 4. Recreate payments table to support CASH provider
CREATE TABLE payments_new (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  order_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'RAZORPAY' CHECK (provider IN ('RAZORPAY', 'CASH')),
  provider_order_id TEXT NOT NULL CHECK (length(provider_order_id) > 0),
  provider_payment_id TEXT,
  amount_paise INTEGER NOT NULL CHECK (amount_paise >= 0),
  currency TEXT NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  status TEXT NOT NULL DEFAULT 'CREATED'
    CHECK (status IN ('CREATED', 'PENDING', 'PAID', 'FAILED', 'CANCELLED', 'REFUNDED', 'DUPLICATE_CAPTURED')),
  verified_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE RESTRICT,
  UNIQUE (provider, provider_order_id),
  UNIQUE (provider, provider_payment_id),
  CHECK (provider_payment_id IS NULL OR length(provider_payment_id) > 0),
  CHECK (verified_at_ms IS NULL OR verified_at_ms >= created_at_ms),
  CHECK (
    status NOT IN ('PAID', 'REFUNDED', 'DUPLICATE_CAPTURED') OR
    (provider_payment_id IS NOT NULL AND verified_at_ms IS NOT NULL)
  )
) STRICT;

INSERT INTO payments_new (
  id, order_id, provider, provider_order_id, provider_payment_id,
  amount_paise, currency, status, verified_at_ms, created_at_ms, updated_at_ms
)
SELECT
  id, order_id, provider, provider_order_id, provider_payment_id,
  amount_paise, currency, status, verified_at_ms, created_at_ms, updated_at_ms
FROM payments;

DROP TABLE payments;
ALTER TABLE payments_new RENAME TO payments;

CREATE INDEX payments_order_created_idx ON payments(order_id, created_at_ms DESC);
CREATE INDEX payments_status_created_idx ON payments(status, created_at_ms DESC);

-- Trigger to track earnings when cash payment is inserted directly as PAID
CREATE TRIGGER IF NOT EXISTS payments_daily_earnings_insert
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
