PRAGMA foreign_keys = ON;

-- OPT-4: Dedicated partial index for listLiveOrders active dashboard queries.
-- Eliminates temporary B-tree sorting, enables single-pass descending index scan
-- for live candidates, enables B-tree index seek for recently printed orders,
-- and excludes historical purged orders from the index pages.
CREATE INDEX IF NOT EXISTS idx_orders_active_updated_at
  ON orders(updated_at_ms DESC, status)
  WHERE cleanup_state = 'ACTIVE';

-- Refresh query planner statistics after adding the partial index.
PRAGMA optimize;
