PRAGMA foreign_keys = ON;

-- A physical order may require two independent spool submissions. Persisting
-- each step is the idempotency boundary that prevents a completed first step
-- from being submitted again after an Agent or network restart.
CREATE TABLE print_attempt_steps (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  print_attempt_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  sequence_number INTEGER NOT NULL CHECK (sequence_number >= 1),
  step_type TEXT NOT NULL CHECK (step_type IN ('IDENTIFICATION_SHEET', 'CUSTOMER_DOCUMENT')),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN (
    'PENDING', 'SUBMISSION_STARTED', 'SUBMITTED', 'BLOCKED',
    'SUCCEEDED', 'FAILED', 'UNCERTAIN'
  )),
  spooler_job_id TEXT,
  failure_code TEXT CHECK (failure_code IS NULL OR failure_code IN (
    'PAPER_OUT', 'PAPER_JAM', 'OFFLINE', 'NO_TONER', 'TONER_LOW',
    'DOOR_OPEN', 'USER_INTERVENTION', 'PRINTER_ERROR', 'UNKNOWN'
  )),
  failure_detail TEXT,
  submission_started_at_ms INTEGER,
  submitted_at_ms INTEGER,
  last_observed_at_ms INTEGER,
  finished_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  FOREIGN KEY (print_attempt_id) REFERENCES print_attempts(id) ON DELETE RESTRICT,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE RESTRICT,
  UNIQUE (print_attempt_id, sequence_number),
  UNIQUE (print_attempt_id, step_type),
  CHECK (spooler_job_id IS NULL OR length(trim(spooler_job_id)) > 0),
  CHECK (submission_started_at_ms IS NULL OR submission_started_at_ms >= created_at_ms),
  CHECK (submitted_at_ms IS NULL OR submitted_at_ms >= created_at_ms),
  CHECK (last_observed_at_ms IS NULL OR last_observed_at_ms >= created_at_ms),
  CHECK (finished_at_ms IS NULL OR finished_at_ms >= created_at_ms)
) STRICT;

CREATE INDEX print_attempt_steps_attempt_status_idx
  ON print_attempt_steps(print_attempt_id, status, sequence_number);

CREATE INDEX print_attempt_steps_spooler_idx
  ON print_attempt_steps(print_attempt_id, spooler_job_id)
  WHERE spooler_job_id IS NOT NULL;

CREATE UNIQUE INDEX print_attempts_one_active_per_order_uq
  ON print_attempts(order_id)
  WHERE status IN ('CREATED', 'SUBMITTING', 'SPOOLING', 'PRINTING', 'BLOCKED');
