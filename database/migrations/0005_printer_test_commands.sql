-- Phase 8: Printer test commands for diagnostic test prints without customer orders

CREATE TABLE printer_test_commands (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  printer_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN (
    'PENDING', 'CLAIMED', 'SUBMITTED', 'BLOCKED', 'SUCCEEDED', 'FAILED', 'EXPIRED'
  )),
  spooler_job_id TEXT CHECK (spooler_job_id IS NULL OR length(spooler_job_id) > 0),
  failure_code TEXT CHECK (failure_code IS NULL OR failure_code IN (
    'PAPER_OUT', 'PAPER_JAM', 'OFFLINE', 'NO_TONER', 'TONER_LOW',
    'DOOR_OPEN', 'USER_INTERVENTION', 'PRINTER_ERROR', 'UNKNOWN'
  )),
  failure_detail TEXT,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms >= created_at_ms),
  claimed_at_ms INTEGER CHECK (claimed_at_ms IS NULL OR claimed_at_ms >= created_at_ms),
  finished_at_ms INTEGER CHECK (finished_at_ms IS NULL OR finished_at_ms >= created_at_ms),
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE RESTRICT,
  FOREIGN KEY (printer_id, agent_id) REFERENCES printers(id, agent_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX printer_test_commands_agent_status_idx
  ON printer_test_commands(agent_id, status);

CREATE INDEX printer_test_commands_printer_created_idx
  ON printer_test_commands(printer_id, created_at_ms);

CREATE INDEX printer_test_commands_agent_spooler_idx
  ON printer_test_commands(agent_id, spooler_job_id)
  WHERE spooler_job_id IS NOT NULL;
