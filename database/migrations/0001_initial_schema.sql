PRAGMA foreign_keys = ON;

-- One D1 database is one PrintGo installation for exactly one shop.
CREATE TABLE installation (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  shop_name TEXT NOT NULL CHECK (length(trim(shop_name)) > 0),
  logo_url TEXT,
  contact_phone TEXT,
  address TEXT,
  customer_notice TEXT,
  online_printing_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (online_printing_enabled IN (0, 1)),
  max_pdf_size_bytes INTEGER NOT NULL DEFAULT 26214400
    CHECK (max_pdf_size_bytes > 0 AND max_pdf_size_bytes <= 26214400),
  identification_sheet_enabled INTEGER NOT NULL DEFAULT 1
    CHECK (identification_sheet_enabled IN (0, 1)),
  identification_sheet_placement TEXT NOT NULL DEFAULT 'LAST'
    CHECK (identification_sheet_placement IN ('FIRST', 'LAST')),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
) STRICT;

-- V1 permits one admin account per installation. Authentication arrives in Phase 2.
CREATE TABLE admins (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  singleton_key INTEGER NOT NULL DEFAULT 1 UNIQUE CHECK (singleton_key = 1),
  login_identifier TEXT NOT NULL COLLATE NOCASE
    CHECK (length(trim(login_identifier)) > 0),
  password_hash TEXT NOT NULL CHECK (length(password_hash) > 0),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  password_changed_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  CHECK (password_changed_at_ms IS NULL OR password_changed_at_ms >= created_at_ms)
) STRICT;

CREATE UNIQUE INDEX admins_login_identifier_uq
  ON admins(login_identifier);

CREATE TABLE admin_sessions (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  admin_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) > 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
  revoked_at_ms INTEGER,
  last_seen_at_ms INTEGER,
  FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE RESTRICT,
  CHECK (revoked_at_ms IS NULL OR revoked_at_ms >= created_at_ms),
  CHECK (last_seen_at_ms IS NULL OR last_seen_at_ms >= created_at_ms)
) STRICT;

CREATE INDEX admin_sessions_admin_expiry_idx
  ON admin_sessions(admin_id, expires_at_ms);

CREATE TABLE print_rates (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  paper_size TEXT NOT NULL CHECK (paper_size IN ('A4', 'A3')),
  color_mode TEXT NOT NULL CHECK (color_mode IN ('BW', 'COLOR')),
  sides TEXT NOT NULL CHECK (sides IN ('SINGLE', 'DOUBLE')),
  price_per_page_paise INTEGER NOT NULL CHECK (price_per_page_paise >= 0),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  UNIQUE (paper_size, color_mode, sides)
) STRICT;

CREATE TABLE file_size_service_charges (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  min_bytes_exclusive INTEGER NOT NULL CHECK (min_bytes_exclusive >= 0),
  max_bytes_inclusive INTEGER NOT NULL
    CHECK (max_bytes_inclusive > min_bytes_exclusive AND max_bytes_inclusive <= 26214400),
  charge_paise INTEGER NOT NULL CHECK (charge_paise >= 0),
  sort_order INTEGER NOT NULL CHECK (sort_order >= 1),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  UNIQUE (min_bytes_exclusive, max_bytes_inclusive),
  UNIQUE (sort_order)
) STRICT;

CREATE TABLE agents (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
  credential_hash TEXT UNIQUE,
  is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
  paired_at_ms INTEGER,
  last_heartbeat_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  CHECK (
    (credential_hash IS NULL AND paired_at_ms IS NULL) OR
    (credential_hash IS NOT NULL AND length(credential_hash) > 0 AND paired_at_ms IS NOT NULL)
  ),
  CHECK (paired_at_ms IS NULL OR paired_at_ms >= created_at_ms),
  CHECK (last_heartbeat_at_ms IS NULL OR last_heartbeat_at_ms >= created_at_ms)
) STRICT;

CREATE INDEX agents_heartbeat_idx
  ON agents(is_active, last_heartbeat_at_ms);

CREATE TABLE agent_pair_codes (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  code_hash TEXT NOT NULL UNIQUE CHECK (length(code_hash) > 0),
  expires_at_ms INTEGER NOT NULL,
  used_at_ms INTEGER,
  paired_agent_id TEXT,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  FOREIGN KEY (paired_agent_id) REFERENCES agents(id) ON DELETE RESTRICT,
  CHECK (expires_at_ms > created_at_ms),
  CHECK (used_at_ms IS NULL OR (used_at_ms >= created_at_ms AND used_at_ms <= expires_at_ms)),
  CHECK (
    (used_at_ms IS NULL AND paired_agent_id IS NULL) OR
    (used_at_ms IS NOT NULL AND paired_agent_id IS NOT NULL)
  )
) STRICT;

CREATE INDEX agent_pair_codes_expiry_idx
  ON agent_pair_codes(expires_at_ms)
  WHERE used_at_ms IS NULL;

CREATE TABLE printers (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  agent_id TEXT NOT NULL,
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
  windows_printer_name TEXT NOT NULL CHECK (length(trim(windows_printer_name)) > 0),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'UNKNOWN'
    CHECK (status IN ('UNKNOWN', 'ONLINE', 'OFFLINE', 'BLOCKED', 'ERROR')),
  status_reason TEXT,
  capabilities_json TEXT CHECK (capabilities_json IS NULL OR json_valid(capabilities_json)),
  last_status_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE RESTRICT,
  UNIQUE (agent_id, windows_printer_name),
  UNIQUE (id, agent_id),
  CHECK (last_status_at_ms IS NULL OR last_status_at_ms >= created_at_ms)
) STRICT;

CREATE INDEX printers_agent_enabled_idx
  ON printers(agent_id, enabled);

CREATE INDEX printers_status_idx
  ON printers(enabled, status);

CREATE TABLE orders (
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
  currency TEXT NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  status TEXT NOT NULL DEFAULT 'CREATED' CHECK (status IN (
    'CREATED', 'UPLOADING', 'UPLOADED',
    'PAYMENT_PENDING', 'PAYMENT_FAILED', 'PAYMENT_CANCELLED',
    'PAID', 'QUEUED', 'CLAIMED', 'SPOOLING', 'PRINTING',
    'PRINT_BLOCKED', 'PRINT_FAILED', 'ADMIN_ACTION_REQUIRED',
    'PRINTED', 'COMPLETED', 'CANCELLED'
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
      'ADMIN_ACTION_REQUIRED', 'PRINTED', 'COMPLETED'
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

CREATE INDEX orders_status_created_idx
  ON orders(status, created_at_ms DESC);

CREATE INDEX orders_created_idx
  ON orders(created_at_ms DESC, id DESC);

CREATE INDEX orders_customer_phone_created_idx
  ON orders(customer_phone, created_at_ms DESC);

CREATE INDEX orders_claim_recovery_idx
  ON orders(claim_expires_at_ms)
  WHERE status = 'CLAIMED' AND claim_expires_at_ms IS NOT NULL;

CREATE TABLE uploads (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  order_id TEXT NOT NULL UNIQUE,
  r2_object_key TEXT NOT NULL UNIQUE CHECK (length(r2_object_key) > 0),
  original_filename TEXT NOT NULL CHECK (length(trim(original_filename)) > 0),
  size_bytes INTEGER CHECK (size_bytes IS NULL OR (size_bytes > 0 AND size_bytes <= 26214400)),
  mime_type TEXT CHECK (mime_type IS NULL OR mime_type = 'application/pdf'),
  storage_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (storage_status IN (
    'PENDING', 'UPLOADED', 'EXPIRED', 'DELETE_PENDING', 'DELETED', 'DELETE_FAILED'
  )),
  retention_reason TEXT CHECK (retention_reason IS NULL OR retention_reason IN (
    'UNPAID', 'PAYMENT_FAILED_OR_CANCELLED', 'COMPLETED', 'UNRESOLVED_PAID_FAILURE'
  )),
  delete_after_ms INTEGER,
  deleted_at_ms INTEGER,
  deletion_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (deletion_attempt_count >= 0),
  last_deletion_error TEXT,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  uploaded_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE RESTRICT,
  CHECK (
    (retention_reason IS NULL AND delete_after_ms IS NULL) OR
    (retention_reason IS NOT NULL AND delete_after_ms IS NOT NULL)
  ),
  CHECK (delete_after_ms IS NULL OR delete_after_ms >= created_at_ms),
  CHECK (uploaded_at_ms IS NULL OR uploaded_at_ms >= created_at_ms),
  CHECK (storage_status = 'PENDING' OR (size_bytes IS NOT NULL AND uploaded_at_ms IS NOT NULL)),
  CHECK (
    (storage_status = 'DELETED' AND deleted_at_ms IS NOT NULL) OR
    (storage_status <> 'DELETED' AND deleted_at_ms IS NULL)
  )
) STRICT;

CREATE INDEX uploads_cleanup_idx
  ON uploads(storage_status, delete_after_ms)
  WHERE storage_status <> 'DELETED' AND delete_after_ms IS NOT NULL;

CREATE TABLE payments (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  order_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'RAZORPAY' CHECK (provider = 'RAZORPAY'),
  provider_order_id TEXT NOT NULL CHECK (length(provider_order_id) > 0),
  provider_payment_id TEXT,
  amount_paise INTEGER NOT NULL CHECK (amount_paise >= 0),
  currency TEXT NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  status TEXT NOT NULL DEFAULT 'CREATED'
    CHECK (status IN ('CREATED', 'PENDING', 'PAID', 'FAILED', 'CANCELLED', 'REFUNDED')),
  verified_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE RESTRICT,
  UNIQUE (provider, provider_order_id),
  UNIQUE (provider, provider_payment_id),
  CHECK (provider_payment_id IS NULL OR length(provider_payment_id) > 0),
  CHECK (verified_at_ms IS NULL OR verified_at_ms >= created_at_ms),
  CHECK (
    status NOT IN ('PAID', 'REFUNDED') OR
    (provider_payment_id IS NOT NULL AND verified_at_ms IS NOT NULL)
  )
) STRICT;

CREATE INDEX payments_order_created_idx
  ON payments(order_id, created_at_ms DESC);

CREATE INDEX payments_status_created_idx
  ON payments(status, created_at_ms DESC);

CREATE TABLE payment_provider_events (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  provider TEXT NOT NULL DEFAULT 'RAZORPAY' CHECK (provider = 'RAZORPAY'),
  provider_event_id TEXT NOT NULL CHECK (length(provider_event_id) > 0),
  event_type TEXT NOT NULL CHECK (length(trim(event_type)) > 0),
  received_at_ms INTEGER NOT NULL CHECK (received_at_ms >= 0),
  processed_at_ms INTEGER,
  processing_status TEXT NOT NULL DEFAULT 'RECEIVED'
    CHECK (processing_status IN ('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED', 'IGNORED')),
  related_payment_id TEXT,
  related_order_id TEXT,
  FOREIGN KEY (related_payment_id) REFERENCES payments(id) ON DELETE RESTRICT,
  FOREIGN KEY (related_order_id) REFERENCES orders(id) ON DELETE RESTRICT,
  UNIQUE (provider, provider_event_id),
  CHECK (processed_at_ms IS NULL OR processed_at_ms >= received_at_ms)
) STRICT;

CREATE INDEX payment_provider_events_processing_idx
  ON payment_provider_events(processing_status, received_at_ms);

CREATE TABLE print_attempts (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  order_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
  agent_id TEXT NOT NULL,
  printer_id TEXT NOT NULL,
  windows_job_id TEXT,
  status TEXT NOT NULL DEFAULT 'CREATED' CHECK (status IN (
    'CREATED', 'SUBMITTING', 'SPOOLING', 'PRINTING',
    'BLOCKED', 'SUCCEEDED', 'FAILED', 'CANCELLED'
  )),
  failure_code TEXT CHECK (failure_code IS NULL OR failure_code IN (
    'PAPER_OUT', 'PAPER_JAM', 'OFFLINE', 'NO_TONER', 'TONER_LOW',
    'DOOR_OPEN', 'USER_INTERVENTION', 'PRINTER_ERROR', 'UNKNOWN'
  )),
  failure_detail TEXT,
  identification_sheet_included INTEGER NOT NULL DEFAULT 0
    CHECK (identification_sheet_included IN (0, 1)),
  submitted_at_ms INTEGER,
  last_observed_at_ms INTEGER,
  finished_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE RESTRICT,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE RESTRICT,
  FOREIGN KEY (printer_id, agent_id) REFERENCES printers(id, agent_id) ON DELETE RESTRICT,
  UNIQUE (order_id, attempt_number),
  CHECK (windows_job_id IS NULL OR length(windows_job_id) > 0),
  CHECK (submitted_at_ms IS NULL OR submitted_at_ms >= created_at_ms),
  CHECK (last_observed_at_ms IS NULL OR last_observed_at_ms >= created_at_ms),
  CHECK (finished_at_ms IS NULL OR finished_at_ms >= created_at_ms)
) STRICT;

CREATE INDEX print_attempts_agent_windows_job_idx
  ON print_attempts(agent_id, windows_job_id)
  WHERE windows_job_id IS NOT NULL;

CREATE INDEX print_attempts_order_status_idx
  ON print_attempts(order_id, status);

CREATE INDEX print_attempts_status_observed_idx
  ON print_attempts(status, last_observed_at_ms);

CREATE TABLE order_events (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  order_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (length(trim(event_type)) > 0),
  from_status TEXT CHECK (from_status IS NULL OR from_status IN (
    'CREATED', 'UPLOADING', 'UPLOADED',
    'PAYMENT_PENDING', 'PAYMENT_FAILED', 'PAYMENT_CANCELLED',
    'PAID', 'QUEUED', 'CLAIMED', 'SPOOLING', 'PRINTING',
    'PRINT_BLOCKED', 'PRINT_FAILED', 'ADMIN_ACTION_REQUIRED',
    'PRINTED', 'COMPLETED', 'CANCELLED'
  )),
  to_status TEXT CHECK (to_status IS NULL OR to_status IN (
    'CREATED', 'UPLOADING', 'UPLOADED',
    'PAYMENT_PENDING', 'PAYMENT_FAILED', 'PAYMENT_CANCELLED',
    'PAID', 'QUEUED', 'CLAIMED', 'SPOOLING', 'PRINTING',
    'PRINT_BLOCKED', 'PRINT_FAILED', 'ADMIN_ACTION_REQUIRED',
    'PRINTED', 'COMPLETED', 'CANCELLED'
  )),
  actor_type TEXT NOT NULL CHECK (actor_type IN (
    'SYSTEM', 'CUSTOMER', 'ADMIN', 'AGENT', 'PAYMENT_PROVIDER'
  )),
  actor_id TEXT,
  details_json TEXT CHECK (details_json IS NULL OR json_valid(details_json)),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX order_events_order_created_idx
  ON order_events(order_id, created_at_ms, id);

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  actor_type TEXT NOT NULL CHECK (actor_type IN (
    'SYSTEM', 'CUSTOMER', 'ADMIN', 'AGENT', 'PAYMENT_PROVIDER'
  )),
  actor_id TEXT,
  action TEXT NOT NULL CHECK (length(trim(action)) > 0),
  entity_type TEXT NOT NULL CHECK (length(trim(entity_type)) > 0),
  entity_id TEXT,
  metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
) STRICT;

CREATE INDEX audit_logs_created_idx
  ON audit_logs(created_at_ms DESC, id DESC);

CREATE INDEX audit_logs_entity_idx
  ON audit_logs(entity_type, entity_id, created_at_ms DESC);
