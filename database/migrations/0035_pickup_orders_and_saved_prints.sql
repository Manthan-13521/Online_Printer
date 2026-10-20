PRAGMA foreign_keys = ON;

-- Migration 0035: Pickup at Opening, 24/7 Order Acceptance & Saved Prints

-- 1. Extend installation table with Operating Hours and Feature Toggles
ALTER TABLE installation ADD COLUMN opening_time TEXT NOT NULL DEFAULT '07:00'
  CHECK (opening_time GLOB '[0-2][0-9]:[0-5][0-9]');
ALTER TABLE installation ADD COLUMN closing_time TEXT NOT NULL DEFAULT '21:00'
  CHECK (closing_time GLOB '[0-2][0-9]:[0-5][0-9]');
ALTER TABLE installation ADD COLUMN operating_days_json TEXT NOT NULL DEFAULT '[1,2,3,4,5,6]';
ALTER TABLE installation ADD COLUMN pickup_at_opening_enabled INTEGER NOT NULL DEFAULT 0 
  CHECK (pickup_at_opening_enabled IN (0, 1));
ALTER TABLE installation ADD COLUMN pickup_auto_print_enabled INTEGER NOT NULL DEFAULT 0 
  CHECK (pickup_auto_print_enabled IN (0, 1));
ALTER TABLE installation ADD COLUMN accept_offline_orders_enabled INTEGER NOT NULL DEFAULT 0 
  CHECK (accept_offline_orders_enabled IN (0, 1));
ALTER TABLE installation ADD COLUMN pickup_abandoned_retention_days INTEGER NOT NULL DEFAULT 7 
  CHECK (pickup_abandoned_retention_days >= 1 AND pickup_abandoned_retention_days <= 30);

-- 2. Extend orders table for Scheduled Pickup Tracking and Saved Prints internal authorization
ALTER TABLE orders ADD COLUMN order_type TEXT NOT NULL DEFAULT 'CUSTOMER' 
  CHECK (order_type IN ('CUSTOMER', 'SAVED_PRINT'));
ALTER TABLE orders ADD COLUMN admin_authorized_by TEXT;
ALTER TABLE orders ADD COLUMN is_pickup INTEGER NOT NULL DEFAULT 0 
  CHECK (is_pickup IN (0, 1));
ALTER TABLE orders ADD COLUMN pickup_target_time_ms INTEGER;
ALTER TABLE orders ADD COLUMN pickup_manual_print_requested INTEGER NOT NULL DEFAULT 0 
  CHECK (pickup_manual_print_requested IN (0, 1));
ALTER TABLE orders ADD COLUMN pickup_collected_at_ms INTEGER;

-- 3. Create index for fast admin filtering of pickup queues
CREATE INDEX IF NOT EXISTS idx_orders_pickup_queue 
  ON orders(is_pickup, status, pickup_target_time_ms)
  WHERE cleanup_state = 'ACTIVE';

-- 4. Create saved_prints table for reusable Admin PDF templates
CREATE TABLE IF NOT EXISTS saved_prints (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0 AND length(name) <= 100),
  original_filename TEXT NOT NULL CHECK (length(trim(original_filename)) > 0),
  r2_object_key TEXT NOT NULL UNIQUE,
  file_size_bytes INTEGER NOT NULL CHECK (file_size_bytes > 0 AND file_size_bytes <= 10485760),
  page_count INTEGER NOT NULL CHECK (page_count >= 1),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_saved_prints_created ON saved_prints(created_at_ms DESC);

PRAGMA optimize;
