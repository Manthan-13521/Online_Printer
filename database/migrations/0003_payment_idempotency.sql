-- Phase 5 payment idempotency constraints.

CREATE UNIQUE INDEX payments_one_active_attempt_per_order_idx
  ON payments(order_id)
  WHERE status IN ('CREATED', 'PENDING');

ALTER TABLE order_events ADD COLUMN idempotency_key TEXT;

CREATE UNIQUE INDEX order_events_idempotency_key_idx
  ON order_events(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
