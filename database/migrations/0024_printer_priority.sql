-- Migration 0024: Printer Priority
-- Adds priority column to printers table for admin-configurable printer routing and priority
ALTER TABLE printers ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
