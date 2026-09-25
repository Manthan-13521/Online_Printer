-- Deterministic synthetic development data. No credentials or real customer data.
INSERT INTO installation (
  id,
  shop_name,
  contact_phone,
  address,
  customer_notice,
  online_printing_enabled,
  max_pdf_size_bytes,
  identification_sheet_enabled,
  identification_sheet_placement,
  created_at_ms,
  updated_at_ms
) VALUES (
  1,
  'PrintGo Development Shop',
  '9000000000',
  'Development address only',
  'Development installation — no real orders',
  0,
  26214400,
  1,
  'LAST',
  1735689600000,
  1735689600000
);

INSERT INTO print_rates (
  id, paper_size, color_mode, sides, price_per_page_paise, enabled, created_at_ms, updated_at_ms
) VALUES
  ('10000000-0000-4000-8000-000000000001', 'A4', 'BW',    'SINGLE', 100, 1, 1735689600000, 1735689600000),
  ('10000000-0000-4000-8000-000000000002', 'A4', 'BW',    'DOUBLE', 150, 1, 1735689600000, 1735689600000),
  ('10000000-0000-4000-8000-000000000003', 'A4', 'COLOR', 'SINGLE', 500, 1, 1735689600000, 1735689600000),
  ('10000000-0000-4000-8000-000000000004', 'A4', 'COLOR', 'DOUBLE', 900, 1, 1735689600000, 1735689600000),
  ('10000000-0000-4000-8000-000000000005', 'A3', 'BW',    'SINGLE', 200, 0, 1735689600000, 1735689600000),
  ('10000000-0000-4000-8000-000000000006', 'A3', 'BW',    'DOUBLE', 350, 0, 1735689600000, 1735689600000),
  ('10000000-0000-4000-8000-000000000007', 'A3', 'COLOR', 'SINGLE', 900, 0, 1735689600000, 1735689600000),
  ('10000000-0000-4000-8000-000000000008', 'A3', 'COLOR', 'DOUBLE', 1700, 0, 1735689600000, 1735689600000);

INSERT INTO file_size_service_charges (
  id, min_bytes_exclusive, max_bytes_inclusive, charge_paise, sort_order, enabled, created_at_ms, updated_at_ms
) VALUES
  ('20000000-0000-4000-8000-000000000001', 0,        2097152,  200, 1, 1, 1735689600000, 1735689600000),
  ('20000000-0000-4000-8000-000000000002', 2097152,  5242880,  400, 2, 1, 1735689600000, 1735689600000),
  ('20000000-0000-4000-8000-000000000003', 5242880,  10485760, 600, 3, 1, 1735689600000, 1735689600000),
  ('20000000-0000-4000-8000-000000000004', 10485760, 26214400, 1000, 4, 1, 1735689600000, 1735689600000);

INSERT INTO agents (
  id, display_name, credential_hash, is_active, paired_at_ms,
  last_heartbeat_at_ms, created_at_ms, updated_at_ms
) VALUES (
  '30000000-0000-4000-8000-000000000001',
  'Unpaired Development Agent',
  NULL,
  0,
  NULL,
  NULL,
  1735689600000,
  1735689600000
);

INSERT INTO printers (
  id, agent_id, display_name, windows_printer_name, enabled, status,
  capabilities_json, created_at_ms, updated_at_ms
) VALUES (
  '40000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000001',
  'Disabled Development Printer',
  'PRINTGO_DEV_PRINTER',
  0,
  'UNKNOWN',
  '{"color":"UNKNOWN","duplex":"UNKNOWN","paperSizes":[]}',
  1735689600000,
  1735689600000
);
