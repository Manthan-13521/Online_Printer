-- Persistent daily completed order counter (survives order cleanup and PDF purges)
-- Resets daily at midnight IST
CREATE TABLE IF NOT EXISTS daily_order_stats (
  date_key TEXT PRIMARY KEY NOT NULL,
  completed_count INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL
) STRICT;

-- Backfill from any currently existing completed orders
INSERT OR IGNORE INTO daily_order_stats (date_key, completed_count, updated_at_ms)
SELECT 
  strftime('%Y-%m-%d', datetime(COALESCE(completed_at_ms, created_at_ms) / 1000 + 19800, 'unixepoch')) AS date_key,
  COUNT(*) AS completed_count,
  MAX(COALESCE(completed_at_ms, created_at_ms)) AS updated_at_ms
FROM orders
WHERE status = 'COMPLETED'
GROUP BY date_key;

-- Trigger to increment daily count when an order is updated to COMPLETED
CREATE TRIGGER IF NOT EXISTS orders_daily_completed_update
AFTER UPDATE OF status ON orders
WHEN NEW.status = 'COMPLETED' AND OLD.status != 'COMPLETED'
BEGIN
  INSERT INTO daily_order_stats (date_key, completed_count, updated_at_ms)
  VALUES (
    strftime('%Y-%m-%d', datetime(COALESCE(NEW.completed_at_ms, strftime('%s', 'now') * 1000) / 1000 + 19800, 'unixepoch')),
    1,
    COALESCE(NEW.completed_at_ms, strftime('%s', 'now') * 1000)
  )
  ON CONFLICT(date_key) DO UPDATE SET
    completed_count = daily_order_stats.completed_count + 1,
    updated_at_ms = excluded.updated_at_ms;
END;

-- Trigger to increment daily count if an order is inserted directly as COMPLETED
CREATE TRIGGER IF NOT EXISTS orders_daily_completed_insert
AFTER INSERT ON orders
WHEN NEW.status = 'COMPLETED'
BEGIN
  INSERT INTO daily_order_stats (date_key, completed_count, updated_at_ms)
  VALUES (
    strftime('%Y-%m-%d', datetime(COALESCE(NEW.completed_at_ms, NEW.created_at_ms) / 1000 + 19800, 'unixepoch')),
    1,
    COALESCE(NEW.completed_at_ms, NEW.created_at_ms)
  )
  ON CONFLICT(date_key) DO UPDATE SET
    completed_count = daily_order_stats.completed_count + 1,
    updated_at_ms = excluded.updated_at_ms;
END;
