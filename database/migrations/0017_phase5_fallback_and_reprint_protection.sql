-- Phase 5: Printer Fallback + Duplicate/Reprint Protection
-- ========================================================

-- 1. Add fallback printer configuration to printers table
--    fallback_printer_id: which printer to use when this one is unavailable
--    auto_fallback_enabled: whether automatic fallback is active
ALTER TABLE printers ADD COLUMN fallback_printer_id TEXT;
ALTER TABLE printers ADD COLUMN auto_fallback_enabled INTEGER NOT NULL DEFAULT 0 CHECK (auto_fallback_enabled IN (0, 1));

-- 2. Track fallback provenance on print attempts
--    When a job is printed on a fallback printer, record the original
--    primary printer it was falling back from.
ALTER TABLE print_attempts ADD COLUMN fallback_from_printer_id TEXT;

-- 3. Index for efficient fallback lookup during claim candidate query
CREATE INDEX idx_printers_fallback ON printers(fallback_printer_id) WHERE fallback_printer_id IS NOT NULL;
