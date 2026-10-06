CREATE TABLE installation (id INT, next_pickup_code_index INT, updated_at_ms INT);
INSERT INTO installation VALUES (1, 10, 0);
CREATE TABLE orders (id INT, pickup_code TEXT, cleanup_state TEXT, status TEXT, paid_at_ms INT);
INSERT INTO orders VALUES (10, 'PA-001', 'ACTIVE', 'QUEUED', 500);

-- Try to run the finalize batch with NOW_MS = 1000
UPDATE orders SET 
  pickup_code = COALESCE(pickup_code, 'PA-999'),
  status = 'QUEUED',
  paid_at_ms = COALESCE(paid_at_ms, 1000)
WHERE id = 10 AND cleanup_state = 'ACTIVE' AND status = 'PAYMENT_PENDING';

UPDATE installation SET 
  next_pickup_code_index = (
    SELECT ((unicode(substr(pickup_code, 2, 1)) - 65) * 999 + cast(substr(pickup_code, 4, 3) AS INT)) % 25974 
    FROM orders WHERE id = 10
  ),
  updated_at_ms = 1000
WHERE id = 1 AND EXISTS (SELECT 1 FROM orders WHERE id = 10 AND paid_at_ms = 1000);

SELECT * FROM installation;
