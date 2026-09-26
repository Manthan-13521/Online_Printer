PRAGMA foreign_keys = ON;

-- Phase 4 customer drafts are bearer-secret protected. Only the SHA-256 digest
-- is retained; the raw token exists only in the customer's browser session.
ALTER TABLE orders ADD COLUMN draft_token_hash TEXT;
ALTER TABLE orders ADD COLUMN draft_expires_at_ms INTEGER;

CREATE UNIQUE INDEX orders_draft_token_hash_uq
  ON orders(draft_token_hash)
  WHERE draft_token_hash IS NOT NULL;

CREATE INDEX orders_draft_expiry_idx
  ON orders(draft_expires_at_ms)
  WHERE draft_expires_at_ms IS NOT NULL AND status IN ('CREATED', 'UPLOADING', 'UPLOADED', 'PAYMENT_PENDING');

-- Expected size is untrusted upload intent. size_bytes remains the Worker-
-- verified R2 object size and is the only size used for pricing.
ALTER TABLE uploads ADD COLUMN expected_size_bytes INTEGER
  CHECK (expected_size_bytes IS NULL OR (expected_size_bytes > 0 AND expected_size_bytes <= 26214400));
ALTER TABLE uploads ADD COLUMN validation_error_code TEXT;
