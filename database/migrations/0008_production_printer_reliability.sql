PRAGMA foreign_keys = ON;

-- Phase 11: Production printer classification and default primary printer routing.
-- Prevents virtual printers (OneNote, Print to PDF, XPS, Fax) from receiving paid customer jobs.

ALTER TABLE printers ADD COLUMN is_production_eligible INTEGER NOT NULL DEFAULT 1;
ALTER TABLE printers ADD COLUMN is_virtual INTEGER NOT NULL DEFAULT 0;
ALTER TABLE printers ADD COLUMN port_name TEXT;
ALTER TABLE printers ADD COLUMN driver_name TEXT;

-- Singleton shop installation selects one explicit default production printer.
ALTER TABLE installation ADD COLUMN default_production_printer_id TEXT;

-- Index to fast-filter eligible production printers for readiness and claiming.
CREATE INDEX IF NOT EXISTS printers_production_eligible_idx
  ON printers(agent_id, is_production_eligible, enabled, status);
