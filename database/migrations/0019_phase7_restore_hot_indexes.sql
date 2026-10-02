-- The Phase 4 orders table rebuild dropped these lookup/due indexes.
-- Keep only the three access paths observed missing in local query plans.
CREATE INDEX orders_draft_token_lookup_idx
  ON orders(draft_token_hash) WHERE draft_token_hash IS NOT NULL;

CREATE INDEX orders_unpaid_cleanup_due_idx
  ON orders(draft_expires_at_ms, id)
  WHERE cleanup_state = 'ACTIVE'
    AND status IN ('CREATED','UPLOADING','UPLOADED','PAYMENT_PENDING','PAYMENT_FAILED','PAYMENT_CANCELLED');

CREATE INDEX orders_completed_cleanup_due_idx
  ON orders(purge_at_ms, id)
  WHERE cleanup_state = 'ACTIVE' AND status = 'COMPLETED' AND purge_at_ms IS NOT NULL;

-- Only manual/finishing orders enter this small keyset-paginated Admin queue.
CREATE INDEX orders_manual_queue_idx
  ON orders(paid_at_ms, id)
  WHERE cleanup_state = 'ACTIVE'
    AND status IN ('MANUAL_PRINT','AWAITING_FINISHING');
