-- Configurable completed order / PDF retention duration in hours (1, 2, 3, 6, 12). Default is 2 hours.
ALTER TABLE installation ADD COLUMN order_retention_hours INTEGER NOT NULL DEFAULT 2;
