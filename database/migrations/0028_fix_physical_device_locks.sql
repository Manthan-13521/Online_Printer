-- Migration 0028: Expand Physical Lock States
-- Ensures that active and unconfirmed mid-flight failure states preserve the physical hardware lock

DROP INDEX IF EXISTS idx_active_physical_device_reservation;

CREATE UNIQUE INDEX IF NOT EXISTS idx_active_physical_device_reservation 
  ON orders(physical_device_id) 
  WHERE status IN (
    'CLAIMED', 
    'SPOOLING', 
    'PRINTING', 
    'ADMIN_ACTION_REQUIRED', 
    'COMPLETION_UNKNOWN', 
    'NEEDS_ADMIN'
  ) AND physical_device_id IS NOT NULL;
