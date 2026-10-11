-- Migration 0032: Safe Reconciliation of Corrupted Webhook Replay Payments & Inactive Agent Cleanup
-- Reconciles legitimate payments that were erroneously marked DUPLICATE_CAPTURED
-- during concurrent/duplicate Razorpay webhook processing, and purges all old inactive agents.
--
-- Strict Safety Invariants:
-- 1. Sole payment: The order has exactly 1 payment record across the entire system.
-- 2. Genuine verification: payments.verified_at_ms IS NOT NULL and matches orders.paid_at_ms.
-- 3. Exact amount: payments.amount_paise matches orders.total_amount_paise.
-- 4. Active queue status: Order is ACTIVE and in QUEUED, RETRY_PENDING, or PRINT_BLOCKED with a job code.
-- 5. Not cash: Orders paid via CASH are strictly excluded.
-- 6. Event verification: Order events contain a genuine PAYMENT_VERIFIED event for this payment ID.

UPDATE payments
SET status = 'PAID',
    updated_at_ms = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
WHERE status = 'DUPLICATE_CAPTURED'
  AND provider = 'RAZORPAY'
  AND provider_payment_id IS NOT NULL
  AND verified_at_ms IS NOT NULL
  AND id IN (
    SELECT p.id
    FROM payments p
    JOIN orders o ON o.id = p.order_id
    WHERE p.status = 'DUPLICATE_CAPTURED'
      AND p.verified_at_ms = o.paid_at_ms
      AND p.amount_paise = o.total_amount_paise
      AND o.cleanup_state = 'ACTIVE'
      AND o.status IN ('QUEUED', 'RETRY_PENDING', 'PRINT_BLOCKED')
      AND o.public_job_code IS NOT NULL
      AND (o.payment_method IS NULL OR o.payment_method <> 'CASH')
      AND (
        SELECT COUNT(*) FROM payments all_p WHERE all_p.order_id = o.id
      ) = 1
      AND EXISTS (
        SELECT 1 FROM order_events oe
        WHERE oe.order_id = o.id
          AND oe.event_type = 'PAYMENT_VERIFIED'
          AND oe.details_json LIKE '%' || p.id || '%'
      )
  );

-- Purge old inactive agents, duplicate printers, test commands, and pair codes,
-- keeping only active production agents and preserving development seed.
DELETE FROM printer_test_commands
WHERE agent_id IN (SELECT id FROM agents WHERE is_active = 0 AND id NOT LIKE '30000000-%');

DELETE FROM printers
WHERE agent_id IN (SELECT id FROM agents WHERE is_active = 0 AND id NOT LIKE '30000000-%');

DELETE FROM agent_pair_codes
WHERE paired_agent_id IN (SELECT id FROM agents WHERE is_active = 0 AND id NOT LIKE '30000000-%');

DELETE FROM agents
WHERE is_active = 0 AND id NOT LIKE '30000000-%';
