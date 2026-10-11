-- Migration 0030: Smart Print Recovery, Queue Management and Agent Control Commands

CREATE TABLE IF NOT EXISTS agent_control_commands (
  id TEXT PRIMARY KEY NOT NULL,
  agent_id TEXT NOT NULL,
  command_type TEXT NOT NULL CHECK (command_type IN ('CLEAR_SPOOLER', 'PROBE_PRINTER', 'RECOVER_QUEUE')),
  printer_id TEXT,
  windows_printer_name TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'CLAIMED', 'SUCCEEDED', 'FAILED', 'EXPIRED')),
  result_json TEXT,
  failure_detail TEXT,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  claimed_at_ms INTEGER,
  finished_at_ms INTEGER,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS idx_agent_control_commands_agent_status
  ON agent_control_commands(agent_id, status);

ALTER TABLE orders ADD COLUMN recovered_at_ms INTEGER DEFAULT NULL;
ALTER TABLE orders ADD COLUMN recovery_reason TEXT DEFAULT NULL;
