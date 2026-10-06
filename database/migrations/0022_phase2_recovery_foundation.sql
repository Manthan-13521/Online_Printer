-- Phase 2: Recovery Foundation
-- Adds fields for lock coordination, paused claims, and print progress stall detection

PRAGMA foreign_keys = OFF;

-- Add recovery coordination fields to installation
ALTER TABLE installation ADD COLUMN recovery_lock_id TEXT;
ALTER TABLE installation ADD COLUMN recovery_locked_at_ms INTEGER;
ALTER TABLE installation ADD COLUMN claims_paused INTEGER NOT NULL DEFAULT 0 CHECK (claims_paused IN (0, 1));

-- Add progress tracking to print_attempts for stall detection
ALTER TABLE print_attempts ADD COLUMN last_progress_at_ms INTEGER;

-- Update existing print_attempts
UPDATE print_attempts SET last_progress_at_ms = updated_at_ms WHERE last_progress_at_ms IS NULL;

PRAGMA foreign_keys = ON;
