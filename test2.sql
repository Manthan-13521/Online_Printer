CREATE TABLE installation (id INT, next_pickup_code_index INT, updated_at_ms INT);
INSERT INTO installation VALUES (1, 0, 0);
CREATE TABLE orders (pickup_code TEXT, cleanup_state TEXT, status TEXT, purge_at_ms INT);
INSERT INTO orders VALUES ('PA-001', 'ACTIVE', 'QUEUED', NULL);
INSERT INTO orders VALUES ('PA-002', 'ACTIVE', 'QUEUED', NULL);

WITH RECURSIVE seq(idx) AS (
  SELECT next_pickup_code_index FROM installation WHERE id = 1
  UNION ALL
  SELECT (idx + 1) % 25974 FROM seq LIMIT 25974
),
available AS (
  SELECT (idx + 1) % 25974 AS nextIndex
  FROM seq 
  WHERE NOT EXISTS (
    SELECT 1 FROM orders o2 
    WHERE o2.pickup_code = 'P' || char(65 + (idx / 999)) || '-' || substr('000' || ((idx % 999) + 1), -3, 3)
      AND o2.cleanup_state = 'ACTIVE'
      AND (o2.status NOT IN ('COMPLETED', 'CANCELLED') OR (o2.purge_at_ms IS NOT NULL AND o2.purge_at_ms > 0))
  )
  LIMIT 1
)
UPDATE installation 
SET next_pickup_code_index = (SELECT nextIndex FROM available),
    updated_at_ms = 123
WHERE id = 1
RETURNING next_pickup_code_index;
