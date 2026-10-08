-- Migration 0023: Identification Sheet Threshold Conditions
-- Adds optional minimum printed pages and minimum order amount conditions to installation table

ALTER TABLE installation ADD COLUMN id_sheet_min_pages INTEGER;
ALTER TABLE installation ADD COLUMN id_sheet_min_amount_paise INTEGER;
