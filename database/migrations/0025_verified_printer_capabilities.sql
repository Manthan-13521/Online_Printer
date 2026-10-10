-- Migration 0025: Verified Printer Capabilities and Configured Services
-- Adds verified and enabled capabilities tracking to printers
ALTER TABLE printers ADD COLUMN verified_capabilities_json TEXT;
ALTER TABLE printers ADD COLUMN enabled_services_json TEXT;
ALTER TABLE printers ADD COLUMN capabilities_updated_at_ms INTEGER;

-- Adds test type and test settings to printer_test_commands for guided verification tests
ALTER TABLE printer_test_commands ADD COLUMN test_type TEXT DEFAULT 'STANDARD';
ALTER TABLE printer_test_commands ADD COLUMN test_settings_json TEXT;
