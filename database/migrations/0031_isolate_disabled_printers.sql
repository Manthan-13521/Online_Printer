-- Migration 0031: Isolate Disabled Printers & Inactive Agent Printers Cleanup

-- Ensure all printers belonging to revoked or inactive agents are permanently disabled
UPDATE printers
SET enabled = 0,
    status = 'OFFLINE',
    status_reason = 'Agent inactive or revoked'
WHERE agent_id IN (SELECT id FROM agents WHERE is_active = 0);

-- Ensure installation default printer is never pointing to an inactive or disabled printer
UPDATE installation
SET default_production_printer_id = (
  SELECT p.id FROM printers p
  JOIN agents a ON a.id = p.agent_id
  WHERE a.is_active = 1 AND p.enabled = 1 AND p.is_production_eligible = 1 AND p.is_virtual = 0
  ORDER BY p.priority DESC, p.id ASC LIMIT 1
)
WHERE default_production_printer_id IS NULL
   OR default_production_printer_id IN (
     SELECT p.id FROM printers p
     LEFT JOIN agents a ON a.id = p.agent_id
     WHERE p.enabled = 0 OR a.id IS NULL OR a.is_active = 0
   );
