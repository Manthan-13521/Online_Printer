-- Migration 0027: Phase 6 Safe Parallel Printing, Durable Execution Lanes & Physical Printer Locking
-- Enforces per-physical-device mutual exclusion and concurrent execution across independent hardware

-- 1. Physical Device ID on printers: queues pointing to the same device share physical_device_id
ALTER TABLE printers ADD COLUMN physical_device_id TEXT;

-- 2. Physical Device ID on orders: tracks the locked physical device currently servicing or reserved for this order
ALTER TABLE orders ADD COLUMN physical_device_id TEXT;

-- 3. Physical Device ID on print_attempts: records the physical device used during each attempt
ALTER TABLE print_attempts ADD COLUMN physical_device_id TEXT;

-- 4. Partial unique index ensuring that no two active orders can lock the same physical device concurrently
CREATE UNIQUE INDEX IF NOT EXISTS idx_active_physical_device_reservation 
  ON orders(physical_device_id) 
  WHERE status IN ('CLAIMED', 'SPOOLING', 'PRINTING', 'PRINT_BLOCKED') AND physical_device_id IS NOT NULL;

-- 5. Index on printers physical_device_id for efficient lookup and grouping
CREATE INDEX IF NOT EXISTS idx_printers_physical_device ON printers(physical_device_id);
