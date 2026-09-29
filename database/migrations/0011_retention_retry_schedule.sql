-- Retry scheduling is separate from the original privacy/access-expiry deadline.
ALTER TABLE uploads ADD COLUMN next_cleanup_attempt_at_ms INTEGER;

-- EXPLAIN showed history-wide FK probes on parent inserts; retain indexed checks.
CREATE INDEX payment_provider_events_payment_idx ON payment_provider_events(related_payment_id);
CREATE INDEX payment_provider_events_order_idx ON payment_provider_events(related_order_id);
