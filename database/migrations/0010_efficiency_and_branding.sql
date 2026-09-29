-- Branding belongs to this one installation; it is not a customer upload.
ALTER TABLE installation ADD COLUMN logo_key TEXT;
CREATE INDEX print_attempt_steps_order_status_idx ON print_attempt_steps(order_id, status);
CREATE INDEX orders_agent_status_idx ON orders(claimed_by_agent_id, status);
CREATE INDEX orders_status_completed_idx ON orders(status, completed_at_ms);

-- Payment capture sets a recovery deadline. Completion must shorten it to one hour.
UPDATE uploads SET retention_reason = 'COMPLETED',
  delete_after_ms = (SELECT completed_at_ms + 3600000 FROM orders WHERE orders.id = uploads.order_id)
WHERE storage_status = 'UPLOADED' AND retention_reason IS NOT 'COMPLETED'
  AND EXISTS (SELECT 1 FROM orders WHERE orders.id = uploads.order_id
    AND status = 'COMPLETED' AND completed_at_ms IS NOT NULL);
