PRAGMA foreign_keys = ON;

-- Phase 13: additive multi-file orders, resumable disposable-workload cleanup,
-- daily cleanup scheduling, and application branding. Legacy order/upload
-- columns remain intact until a later, explicitly approved compatibility phase.

ALTER TABLE installation ADD COLUMN app_name TEXT NOT NULL DEFAULT 'PrintGo'
  CHECK (length(trim(app_name)) BETWEEN 1 AND 50);
ALTER TABLE installation ADD COLUMN max_order_upload_bytes INTEGER NOT NULL DEFAULT 104857600
  CHECK (max_order_upload_bytes > 0 AND max_order_upload_bytes <= 104857600);
ALTER TABLE installation ADD COLUMN automatic_daily_cleanup_enabled INTEGER NOT NULL DEFAULT 0
  CHECK (automatic_daily_cleanup_enabled IN (0, 1));
ALTER TABLE installation ADD COLUMN daily_cleanup_time TEXT NOT NULL DEFAULT '23:30'
  CHECK (daily_cleanup_time GLOB '[0-2][0-9]:[0-5][0-9]');
ALTER TABLE installation ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata'
  CHECK (length(trim(timezone)) BETWEEN 1 AND 100);
ALTER TABLE installation ADD COLUMN next_daily_cleanup_at_ms INTEGER;
ALTER TABLE installation ADD COLUMN last_cleanup_at_ms INTEGER;
ALTER TABLE installation ADD COLUMN last_cleanup_result TEXT;

ALTER TABLE orders ADD COLUMN purge_at_ms INTEGER;
ALTER TABLE orders ADD COLUMN cleanup_state TEXT NOT NULL DEFAULT 'ACTIVE'
  CHECK (cleanup_state IN ('ACTIVE', 'CLAIMED'));
ALTER TABLE orders ADD COLUMN cleanup_run_id TEXT;

-- Existing completed orders already have authoritative relational ownership.
-- Give them the same deterministic two-hour deadline without listing R2.
UPDATE orders
SET purge_at_ms = COALESCE(completed_at_ms, printed_at_ms, updated_at_ms) + 7200000
WHERE status = 'COMPLETED' AND purge_at_ms IS NULL;

CREATE INDEX orders_unpaid_cleanup_due_idx
  ON orders(draft_expires_at_ms, id)
  WHERE cleanup_state = 'ACTIVE'
    AND status IN ('CREATED','UPLOADING','UPLOADED','PAYMENT_PENDING','PAYMENT_FAILED','PAYMENT_CANCELLED');

CREATE INDEX orders_completed_cleanup_due_idx
  ON orders(purge_at_ms, id)
  WHERE cleanup_state = 'ACTIVE' AND status = 'COMPLETED' AND purge_at_ms IS NOT NULL;

CREATE TABLE order_files (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  order_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 10),
  original_filename TEXT NOT NULL CHECK (length(trim(original_filename)) BETWEEN 1 AND 255),
  r2_object_key TEXT NOT NULL UNIQUE CHECK (length(trim(r2_object_key)) > 0),
  expected_size_bytes INTEGER NOT NULL CHECK (expected_size_bytes > 0 AND expected_size_bytes <= 26214400),
  size_bytes INTEGER CHECK (size_bytes IS NULL OR (size_bytes > 0 AND size_bytes <= 26214400)),
  mime_type TEXT CHECK (mime_type IS NULL OR mime_type = 'application/pdf'),
  source_page_count INTEGER NOT NULL CHECK (source_page_count BETWEEN 1 AND 1000000),
  selected_pages TEXT NOT NULL DEFAULT 'ALL' CHECK (length(trim(selected_pages)) > 0),
  selected_page_count INTEGER CHECK (selected_page_count IS NULL OR selected_page_count >= 1),
  copies INTEGER NOT NULL DEFAULT 1 CHECK (copies BETWEEN 1 AND 100),
  paper_size TEXT NOT NULL CHECK (paper_size IN ('A4', 'A3')),
  color_mode TEXT NOT NULL CHECK (color_mode IN ('BW', 'COLOR')),
  sides TEXT NOT NULL CHECK (sides IN ('SINGLE', 'DOUBLE')),
  printing_amount_paise INTEGER NOT NULL DEFAULT 0 CHECK (printing_amount_paise >= 0),
  service_charge_paise INTEGER NOT NULL DEFAULT 0 CHECK (service_charge_paise >= 0),
  upload_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (upload_status IN (
    'PENDING','UPLOADED','VALIDATION_FAILED','DELETE_PENDING','DELETE_FAILED'
  )),
  print_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (print_status IN (
    'PENDING','SUBMISSION_STARTED','SUBMITTED','BLOCKED','PRINTED','FAILED','UNCERTAIN'
  )),
  spooler_job_id TEXT,
  validation_error_code TEXT,
  submission_started_at_ms INTEGER,
  submitted_at_ms INTEGER,
  uploaded_at_ms INTEGER,
  printed_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE RESTRICT,
  UNIQUE (order_id, position),
  CHECK (size_bytes IS NULL OR uploaded_at_ms IS NOT NULL),
  CHECK (spooler_job_id IS NULL OR length(trim(spooler_job_id)) > 0)
) STRICT;

CREATE INDEX order_files_order_position_idx ON order_files(order_id, position);
CREATE INDEX order_files_order_print_idx ON order_files(order_id, print_status, position);

-- Every legacy single-file order becomes a one-child order without removing or
-- rewriting its legacy upload row.
INSERT INTO order_files (
  id, order_id, position, original_filename, r2_object_key,
  expected_size_bytes, size_bytes, mime_type, source_page_count,
  selected_pages, selected_page_count, copies, paper_size, color_mode, sides,
  printing_amount_paise, service_charge_paise, upload_status, print_status,
  validation_error_code, uploaded_at_ms, printed_at_ms, created_at_ms, updated_at_ms
)
SELECT u.id, u.order_id, 1, u.original_filename, u.r2_object_key,
  COALESCE(u.expected_size_bytes, u.size_bytes, 1), u.size_bytes, u.mime_type,
  COALESCE(o.source_page_count, 1), o.selected_pages,
  NULL,
  o.copies, o.paper_size, o.color_mode, o.sides,
  o.printing_amount_paise, o.service_charge_paise,
  CASE
    WHEN u.storage_status = 'UPLOADED' THEN 'UPLOADED'
    WHEN u.storage_status IN ('DELETE_PENDING','DELETE_FAILED') THEN u.storage_status
    WHEN u.validation_error_code IS NOT NULL THEN 'VALIDATION_FAILED'
    ELSE 'PENDING'
  END,
  CASE WHEN o.status IN ('PRINTED','COMPLETED') THEN 'PRINTED' ELSE 'PENDING' END,
  u.validation_error_code, u.uploaded_at_ms, o.printed_at_ms, u.created_at_ms, u.updated_at_ms
FROM uploads u
JOIN orders o ON o.id = u.order_id;

ALTER TABLE print_attempts ADD COLUMN order_file_id TEXT;
ALTER TABLE print_attempts ADD COLUMN file_position INTEGER;
CREATE INDEX print_attempts_order_file_idx ON print_attempts(order_file_id, attempt_number);

CREATE TABLE cleanup_runs (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  scope TEXT NOT NULL CHECK (scope IN ('EXPIRED_UNPAID','COMPLETED_DUE','ALL_COMPLETED','ALL_PRINT_DATA')),
  source TEXT NOT NULL CHECK (source IN ('SCHEDULED','ADMIN','DAILY')),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RUNNING','COMPLETED','PARTIAL','FAILED')),
  requested_by_admin_id TEXT,
  orders_selected INTEGER NOT NULL DEFAULT 0,
  orders_deleted INTEGER NOT NULL DEFAULT 0,
  files_selected INTEGER NOT NULL DEFAULT 0,
  bytes_selected INTEGER NOT NULL DEFAULT 0,
  files_deleted INTEGER NOT NULL DEFAULT 0,
  bytes_deleted INTEGER NOT NULL DEFAULT 0,
  active_skipped INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  cutoff_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  started_at_ms INTEGER,
  completed_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL,
  FOREIGN KEY (requested_by_admin_id) REFERENCES admins(id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX cleanup_runs_status_created_idx ON cleanup_runs(status, created_at_ms);

CREATE TABLE cleanup_run_items (
  run_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACTIVE_SKIPPED','DELETED','FAILED')),
  file_count INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (run_id, order_id),
  FOREIGN KEY (run_id) REFERENCES cleanup_runs(id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX cleanup_run_items_pending_idx ON cleanup_run_items(run_id, status, updated_at_ms);

-- Minimal payment/idempotency records retained after disposable customer work
-- is purged. These intentionally contain no customer identity, filename,
-- document settings, page details, or R2 key.
CREATE TABLE retained_payment_records (
  id TEXT PRIMARY KEY NOT NULL,
  provider TEXT NOT NULL,
  provider_order_id TEXT NOT NULL,
  provider_payment_id TEXT,
  amount_paise INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  verified_at_ms INTEGER,
  payment_created_at_ms INTEGER NOT NULL,
  purged_at_ms INTEGER NOT NULL,
  UNIQUE (provider, provider_order_id),
  UNIQUE (provider, provider_payment_id)
) STRICT;

CREATE TABLE retained_provider_events (
  id TEXT PRIMARY KEY NOT NULL,
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  received_at_ms INTEGER NOT NULL,
  processed_at_ms INTEGER,
  processing_status TEXT NOT NULL,
  purged_at_ms INTEGER NOT NULL,
  UNIQUE (provider, provider_event_id)
) STRICT;
