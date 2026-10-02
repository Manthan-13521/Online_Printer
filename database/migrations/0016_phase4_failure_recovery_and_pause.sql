PRAGMA foreign_keys = OFF;

-- 1. Add failure recovery and pause/resume columns to printers table
ALTER TABLE printers ADD COLUMN is_paused INTEGER NOT NULL DEFAULT 0 CHECK (is_paused IN (0, 1));
ALTER TABLE printers ADD COLUMN paused_reason TEXT;
ALTER TABLE printers ADD COLUMN paused_at_ms INTEGER;
ALTER TABLE printers ADD COLUMN last_health_check_at_ms INTEGER;
ALTER TABLE printers ADD COLUMN health_check_requested INTEGER NOT NULL DEFAULT 0 CHECK (health_check_requested IN (0, 1));

-- 2. Recreate orders table to support RETRY_PENDING, NEEDS_ADMIN, COMPLETION_UNKNOWN and recovery metadata
CREATE TABLE orders_new (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  public_job_code TEXT UNIQUE,
  pickup_code TEXT UNIQUE,
  tracking_token_hash TEXT UNIQUE,
  customer_name TEXT NOT NULL CHECK (length(trim(customer_name)) > 0),
  customer_phone TEXT NOT NULL CHECK (length(trim(customer_phone)) > 0),
  original_filename TEXT NOT NULL CHECK (length(trim(original_filename)) > 0),
  selected_pages TEXT NOT NULL DEFAULT 'ALL' CHECK (length(trim(selected_pages)) > 0),
  source_page_count INTEGER CHECK (source_page_count IS NULL OR source_page_count >= 1),
  copies INTEGER NOT NULL DEFAULT 1 CHECK (copies >= 1),
  color_mode TEXT NOT NULL CHECK (color_mode IN ('BW', 'COLOR')),
  paper_size TEXT NOT NULL CHECK (paper_size IN ('A4', 'A3')),
  sides TEXT NOT NULL CHECK (sides IN ('SINGLE', 'DOUBLE')),
  instructions TEXT,
  printing_amount_paise INTEGER NOT NULL DEFAULT 0 CHECK (printing_amount_paise >= 0),
  service_charge_paise INTEGER NOT NULL DEFAULT 0 CHECK (service_charge_paise >= 0),
  total_amount_paise INTEGER NOT NULL DEFAULT 0 CHECK (total_amount_paise >= 0),
  due_at_pickup_paise INTEGER NOT NULL DEFAULT 0 CHECK (due_at_pickup_paise >= 0),
  is_priority INTEGER NOT NULL DEFAULT 0 CHECK (is_priority IN (0, 1)),
  priority_fee_paise INTEGER NOT NULL DEFAULT 0 CHECK (priority_fee_paise >= 0),
  discount_amount_paise INTEGER NOT NULL DEFAULT 0 CHECK (discount_amount_paise >= 0),
  snapshot_discount_threshold_paise INTEGER,
  snapshot_discount_percent INTEGER,
  identification_required INTEGER NOT NULL DEFAULT 0 CHECK (identification_required IN (0, 1)),
  currency TEXT NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  status TEXT NOT NULL DEFAULT 'CREATED' CHECK (status IN (
    'CREATED', 'UPLOADING', 'UPLOADED',
    'PAYMENT_PENDING', 'PAYMENT_FAILED', 'PAYMENT_CANCELLED',
    'PAID', 'QUEUED', 'CLAIMED', 'SPOOLING', 'PRINTING',
    'PRINT_BLOCKED', 'PRINT_FAILED', 'RETRY_PENDING', 'NEEDS_ADMIN',
    'COMPLETION_UNKNOWN', 'ADMIN_ACTION_REQUIRED',
    'PRINTED', 'MANUAL_PRINT', 'AWAITING_FINISHING', 'COMPLETED', 'CANCELLED'
  )),
  claimed_by_agent_id TEXT,
  claim_id TEXT UNIQUE,
  claim_expires_at_ms INTEGER,
  printer_id TEXT,
  error_category TEXT,
  raw_error TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_attempt_at_ms INTEGER,
  next_retry_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  paid_at_ms INTEGER,
  queued_at_ms INTEGER,
  claimed_at_ms INTEGER,
  print_started_at_ms INTEGER,
  printed_at_ms INTEGER,
  completed_at_ms INTEGER,
  cancelled_at_ms INTEGER,
  draft_token_hash TEXT,
  draft_expires_at_ms INTEGER,
  tracking_created_at_ms INTEGER,
  tracking_expires_at_ms INTEGER,
  pii_purged_at_ms INTEGER,
  purge_at_ms INTEGER,
  cleanup_state TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (cleanup_state IN ('ACTIVE', 'CLAIMED')),
  cleanup_run_id TEXT,
  FOREIGN KEY (claimed_by_agent_id) REFERENCES agents(id) ON DELETE RESTRICT,
  FOREIGN KEY (printer_id) REFERENCES printers(id) ON DELETE RESTRICT,
  FOREIGN KEY (printer_id, claimed_by_agent_id) REFERENCES printers(id, agent_id) ON DELETE RESTRICT,
  CHECK (public_job_code IS NULL OR length(trim(public_job_code)) > 0),
  CHECK (pickup_code IS NULL OR length(trim(pickup_code)) > 0),
  CHECK (tracking_token_hash IS NULL OR length(tracking_token_hash) > 0),
  CHECK (total_amount_paise = printing_amount_paise + service_charge_paise - discount_amount_paise),
  CHECK (
    (claimed_by_agent_id IS NULL AND claim_id IS NULL AND claim_expires_at_ms IS NULL) OR
    (claimed_by_agent_id IS NOT NULL AND claim_id IS NOT NULL AND claim_expires_at_ms IS NOT NULL)
  ),
  CHECK (
    status NOT IN (
      'CLAIMED', 'SPOOLING', 'PRINTING', 'PRINT_BLOCKED', 'PRINT_FAILED',
      'ADMIN_ACTION_REQUIRED', 'PRINTED'
    ) OR claimed_by_agent_id IS NOT NULL
  ),
  CHECK (claimed_at_ms IS NULL OR claimed_at_ms >= created_at_ms),
  CHECK (
    claim_expires_at_ms IS NULL OR
    (claimed_at_ms IS NOT NULL AND claim_expires_at_ms > claimed_at_ms)
  ),
  CHECK (paid_at_ms IS NULL OR paid_at_ms >= created_at_ms),
  CHECK (queued_at_ms IS NULL OR queued_at_ms >= created_at_ms),
  CHECK (print_started_at_ms IS NULL OR print_started_at_ms >= created_at_ms),
  CHECK (printed_at_ms IS NULL OR printed_at_ms >= created_at_ms),
  CHECK (completed_at_ms IS NULL OR completed_at_ms >= created_at_ms),
  CHECK (cancelled_at_ms IS NULL OR cancelled_at_ms >= created_at_ms)
) STRICT;

INSERT INTO orders_new (
  id, public_job_code, pickup_code, tracking_token_hash, customer_name, customer_phone,
  original_filename, selected_pages, source_page_count, copies, color_mode,
  paper_size, sides, instructions, printing_amount_paise, service_charge_paise,
  total_amount_paise, due_at_pickup_paise, is_priority, priority_fee_paise,
  discount_amount_paise, snapshot_discount_threshold_paise, snapshot_discount_percent,
  identification_required, currency, status, claimed_by_agent_id,
  claim_id, claim_expires_at_ms, printer_id, created_at_ms, updated_at_ms,
  paid_at_ms, queued_at_ms, claimed_at_ms, print_started_at_ms, printed_at_ms,
  completed_at_ms, cancelled_at_ms, draft_token_hash, draft_expires_at_ms,
  tracking_created_at_ms, tracking_expires_at_ms, pii_purged_at_ms, purge_at_ms,
  cleanup_state, cleanup_run_id, error_category, raw_error, attempt_count,
  last_attempt_at_ms, next_retry_at_ms
)
SELECT
  id, public_job_code, pickup_code, tracking_token_hash, customer_name, customer_phone,
  original_filename, selected_pages, source_page_count, copies, color_mode,
  paper_size, sides, instructions, printing_amount_paise, service_charge_paise,
  total_amount_paise, due_at_pickup_paise, is_priority, priority_fee_paise,
  discount_amount_paise, snapshot_discount_threshold_paise, snapshot_discount_percent,
  identification_required, currency, status, claimed_by_agent_id,
  claim_id, claim_expires_at_ms, printer_id, created_at_ms, updated_at_ms,
  paid_at_ms, queued_at_ms, claimed_at_ms, print_started_at_ms, printed_at_ms,
  completed_at_ms, cancelled_at_ms, draft_token_hash, draft_expires_at_ms,
  tracking_created_at_ms, tracking_expires_at_ms, pii_purged_at_ms, purge_at_ms,
  cleanup_state, cleanup_run_id, NULL, NULL, 0, NULL, NULL
FROM orders;

DROP TABLE orders;
ALTER TABLE orders_new RENAME TO orders;

-- 3. Recreate indexes for orders table
CREATE INDEX idx_orders_status_created ON orders(status, created_at_ms DESC);
CREATE INDEX idx_orders_created ON orders(created_at_ms DESC, id DESC);
CREATE INDEX idx_orders_customer_phone_created ON orders(customer_phone, created_at_ms DESC);
CREATE INDEX idx_orders_claim_recovery ON orders(claim_expires_at_ms) WHERE status = 'CLAIMED' AND claim_expires_at_ms IS NOT NULL;
CREATE INDEX idx_orders_pickup_code ON orders(pickup_code);
CREATE INDEX idx_orders_claim_priority_queue ON orders(status, is_priority DESC, queued_at_ms ASC);
-- 4. Recreate order_events table to support all new statuses in from_status and to_status
CREATE TABLE order_events_new (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  order_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (length(trim(event_type)) > 0),
  from_status TEXT CHECK (from_status IS NULL OR from_status IN (
    'CREATED', 'UPLOADING', 'UPLOADED',
    'PAYMENT_PENDING', 'PAYMENT_FAILED', 'PAYMENT_CANCELLED',
    'PAID', 'QUEUED', 'CLAIMED', 'SPOOLING', 'PRINTING',
    'PRINT_BLOCKED', 'PRINT_FAILED', 'RETRY_PENDING', 'NEEDS_ADMIN',
    'COMPLETION_UNKNOWN', 'ADMIN_ACTION_REQUIRED',
    'PRINTED', 'MANUAL_PRINT', 'AWAITING_FINISHING', 'COMPLETED', 'CANCELLED'
  )),
  to_status TEXT CHECK (to_status IS NULL OR to_status IN (
    'CREATED', 'UPLOADING', 'UPLOADED',
    'PAYMENT_PENDING', 'PAYMENT_FAILED', 'PAYMENT_CANCELLED',
    'PAID', 'QUEUED', 'CLAIMED', 'SPOOLING', 'PRINTING',
    'PRINT_BLOCKED', 'PRINT_FAILED', 'RETRY_PENDING', 'NEEDS_ADMIN',
    'COMPLETION_UNKNOWN', 'ADMIN_ACTION_REQUIRED',
    'PRINTED', 'MANUAL_PRINT', 'AWAITING_FINISHING', 'COMPLETED', 'CANCELLED'
  )),
  actor_type TEXT NOT NULL CHECK (actor_type IN (
    'SYSTEM', 'CUSTOMER', 'ADMIN', 'AGENT', 'PAYMENT_PROVIDER'
  )),
  actor_id TEXT,
  details_json TEXT CHECK (details_json IS NULL OR json_valid(details_json)),
  idempotency_key TEXT,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
) STRICT;

INSERT INTO order_events_new (
  id, order_id, event_type, from_status, to_status, actor_type, actor_id, details_json, idempotency_key, created_at_ms
)
SELECT
  id, order_id, event_type, from_status, to_status, actor_type, actor_id, details_json, idempotency_key, created_at_ms
FROM order_events;

DROP TABLE order_events;
ALTER TABLE order_events_new RENAME TO order_events;

CREATE INDEX order_events_order_created_idx ON order_events(order_id, created_at_ms, id);
CREATE UNIQUE INDEX order_events_idempotency_key_idx ON order_events(idempotency_key) WHERE idempotency_key IS NOT NULL;

PRAGMA foreign_keys = ON;

