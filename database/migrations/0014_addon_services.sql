PRAGMA foreign_keys = OFF;

-- 1. Create addon_services table
CREATE TABLE addon_services (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  display_order INTEGER NOT NULL DEFAULT 0,
  pricing_type TEXT NOT NULL CHECK (pricing_type IN ('FIXED_PRICE', 'STAFF_PRICED')),
  fixed_price_paise INTEGER CHECK (
    (pricing_type = 'FIXED_PRICE' AND fixed_price_paise IS NOT NULL AND fixed_price_paise >= 0) OR
    (pricing_type = 'STAFF_PRICED' AND fixed_price_paise IS NULL)
  ),
  handling_mode TEXT NOT NULL CHECK (handling_mode IN ('AUTO', 'POST_PRINT', 'MANUAL_PRINT')),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
) STRICT;

-- 2. Create order_addon_services table
CREATE TABLE order_addon_services (
  order_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  snapshot_name TEXT NOT NULL,
  snapshot_pricing_type TEXT NOT NULL CHECK (snapshot_pricing_type IN ('FIXED_PRICE', 'STAFF_PRICED')),
  snapshot_price_charged_online_paise INTEGER NOT NULL CHECK (snapshot_price_charged_online_paise >= 0),
  snapshot_handling_mode TEXT NOT NULL CHECK (snapshot_handling_mode IN ('AUTO', 'POST_PRINT', 'MANUAL_PRINT')),
  PRIMARY KEY (order_id, service_id),
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
) STRICT;

-- 3. Recreate orders table to allow new statuses and add due_at_pickup_paise
CREATE TABLE orders_new (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  public_job_code TEXT UNIQUE,
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
  currency TEXT NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  status TEXT NOT NULL DEFAULT 'CREATED' CHECK (status IN (
    'CREATED', 'UPLOADING', 'UPLOADED',
    'PAYMENT_PENDING', 'PAYMENT_FAILED', 'PAYMENT_CANCELLED',
    'PAID', 'QUEUED', 'CLAIMED', 'SPOOLING', 'PRINTING',
    'PRINT_BLOCKED', 'PRINT_FAILED', 'ADMIN_ACTION_REQUIRED',
    'PRINTED', 'MANUAL_PRINT', 'AWAITING_FINISHING', 'COMPLETED', 'CANCELLED'
  )),
  claimed_by_agent_id TEXT,
  claim_id TEXT UNIQUE,
  claim_expires_at_ms INTEGER,
  printer_id TEXT,
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
  CHECK (tracking_token_hash IS NULL OR length(tracking_token_hash) > 0),
  CHECK (total_amount_paise = printing_amount_paise + service_charge_paise),
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
  id, public_job_code, tracking_token_hash, customer_name, customer_phone,
  original_filename, selected_pages, source_page_count, copies, color_mode,
  paper_size, sides, instructions, printing_amount_paise, service_charge_paise,
  total_amount_paise, due_at_pickup_paise, currency, status, claimed_by_agent_id,
  claim_id, claim_expires_at_ms, printer_id, created_at_ms, updated_at_ms,
  paid_at_ms, queued_at_ms, claimed_at_ms, print_started_at_ms, printed_at_ms,
  completed_at_ms, cancelled_at_ms, draft_token_hash, draft_expires_at_ms,
  tracking_created_at_ms, tracking_expires_at_ms, pii_purged_at_ms, purge_at_ms,
  cleanup_state, cleanup_run_id
)
SELECT
  id, public_job_code, tracking_token_hash, customer_name, customer_phone,
  original_filename, selected_pages, source_page_count, copies, color_mode,
  paper_size, sides, instructions, printing_amount_paise, service_charge_paise,
  total_amount_paise, 0, currency, status, claimed_by_agent_id,
  claim_id, claim_expires_at_ms, printer_id, created_at_ms, updated_at_ms,
  paid_at_ms, queued_at_ms, claimed_at_ms, print_started_at_ms, printed_at_ms,
  completed_at_ms, cancelled_at_ms, draft_token_hash, draft_expires_at_ms,
  tracking_created_at_ms, tracking_expires_at_ms, pii_purged_at_ms, purge_at_ms,
  cleanup_state, cleanup_run_id
FROM orders;

-- Drop old table and rename
DROP TABLE orders;
ALTER TABLE orders_new RENAME TO orders;

-- Recreate indexes and triggers on orders
CREATE INDEX orders_status_created_idx ON orders(status, created_at_ms DESC);
CREATE INDEX orders_created_idx ON orders(created_at_ms DESC, id DESC);
CREATE INDEX orders_customer_phone_created_idx ON orders(customer_phone, created_at_ms DESC);
CREATE INDEX orders_claim_recovery_idx ON orders(claim_expires_at_ms) WHERE status = 'CLAIMED' AND claim_expires_at_ms IS NOT NULL;
CREATE INDEX orders_status_updated_idx ON orders(status, updated_at_ms DESC);
CREATE UNIQUE INDEX orders_draft_token_hash_uq ON orders(draft_token_hash) WHERE draft_token_hash IS NOT NULL;
CREATE INDEX orders_draft_expiry_idx ON orders(draft_expires_at_ms) WHERE draft_expires_at_ms IS NOT NULL AND status IN ('CREATED', 'UPLOADING', 'UPLOADED', 'PAYMENT_PENDING');
CREATE INDEX orders_tracking_expiry_idx ON orders(tracking_expires_at_ms) WHERE tracking_token_hash IS NOT NULL;

CREATE TRIGGER orders_tracking_fields_consistent
BEFORE UPDATE OF tracking_token_hash, tracking_created_at_ms, tracking_expires_at_ms
ON orders
WHEN NOT (
  (NEW.tracking_token_hash IS NULL AND NEW.tracking_created_at_ms IS NULL AND NEW.tracking_expires_at_ms IS NULL)
  OR
  (NEW.tracking_token_hash IS NOT NULL AND NEW.tracking_created_at_ms IS NOT NULL AND NEW.tracking_expires_at_ms > NEW.tracking_created_at_ms)
)
BEGIN
  SELECT RAISE(ABORT, 'tracking authorization fields are inconsistent');
END;

CREATE TRIGGER orders_tracking_token_immutable
BEFORE UPDATE OF tracking_token_hash ON orders
WHEN OLD.tracking_token_hash IS NOT NULL AND NEW.tracking_token_hash IS NOT OLD.tracking_token_hash
BEGIN
  SELECT RAISE(ABORT, 'tracking authorization cannot be replaced');
END;

CREATE INDEX orders_pii_purge_idx ON orders(completed_at_ms) WHERE status = 'COMPLETED' AND pii_purged_at_ms IS NULL AND completed_at_ms IS NOT NULL;
CREATE INDEX orders_agent_status_idx ON orders(claimed_by_agent_id, status);
CREATE INDEX orders_status_completed_idx ON orders(status, completed_at_ms);

CREATE INDEX orders_unpaid_cleanup_due_idx
  ON orders(draft_expires_at_ms, id)
  WHERE cleanup_state = 'ACTIVE'
    AND status IN ('CREATED','UPLOADING','UPLOADED','PAYMENT_PENDING','PAYMENT_FAILED','PAYMENT_CANCELLED');

CREATE INDEX orders_completed_cleanup_due_idx
  ON orders(purge_at_ms, id)
  WHERE cleanup_state = 'ACTIVE' AND status = 'COMPLETED' AND purge_at_ms IS NOT NULL;

PRAGMA foreign_keys = ON;
