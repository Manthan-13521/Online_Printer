CREATE TABLE installation (id INT, next_pickup_code_index INT, updated_at_ms INT);
INSERT INTO installation VALUES (1, 0, 0);
CREATE TABLE orders (id INT, pickup_code TEXT, cleanup_state TEXT, status TEXT, purge_at_ms INT);
INSERT INTO orders VALUES (10, NULL, 'ACTIVE', 'PAYMENT_PENDING', NULL);
INSERT INTO orders VALUES (11, 'PA-001', 'ACTIVE', 'QUEUED', NULL);
INSERT INTO orders VALUES (12, 'PA-002', 'ACTIVE', 'QUEUED', NULL);

UPDATE orders SET 
  pickup_code = COALESCE(pickup_code, (
    SELECT candidateCode FROM (
       WITH RECURSIVE seq(idx) AS (
         SELECT next_pickup_code_index FROM installation WHERE id = 1
         UNION ALL
         SELECT (idx + 1) % 25974 FROM seq LIMIT 25974
       )
       SELECT 
         'P' || char(65 + (idx / 999)) || '-' || substr('000' || ((idx % 999) + 1), -3, 3) AS candidateCode
       FROM seq 
       WHERE NOT EXISTS (
         SELECT 1 FROM orders o2 
         WHERE o2.pickup_code = 'P' || char(65 + (idx / 999)) || '-' || substr('000' || ((idx % 999) + 1), -3, 3)
           AND o2.cleanup_state = 'ACTIVE'
           AND o2.status NOT IN ('COMPLETED', 'CANCELLED')
       )
       LIMIT 1
    )
  )),
  status = 'QUEUED'
WHERE id = 10 AND cleanup_state = 'ACTIVE' AND status = 'PAYMENT_PENDING';

UPDATE installation SET 
  next_pickup_code_index = (
    SELECT ((unicode(substr(pickup_code, 2, 1)) - 65) * 999 + cast(substr(pickup_code, 4, 3) AS INT)) % 25974 
    FROM orders WHERE id = 10
  ),
  updated_at_ms = 123
WHERE id = 1;

SELECT * FROM orders WHERE id = 10;
SELECT * FROM installation;
