const fs = require('fs');
const file = 'apps/api/worker/src/payments/repository.ts';
let code = fs.readFileSync(file, 'utf8');

// 1. Remove allocatePickupCode method completely
code = code.replace(/  private async allocatePickupCode[\s\S]*?    return indexToPickupCode\(startIndex\);\n  }\n\n/g, "");

// 2. Rewrite finalizePaid
const newFinalizePaid = `  async finalizePaid(
    input: Parameters<PaymentRepository["finalizePaid"]>[0],
  ): Promise<PaymentRecord> {
    const before = await this.findPayment("p.id", input.paymentId);
    if (!before) throw new Error("Payment record missing.");
    if (before.status === "PAID" && before.publicJobCode) return before;

    // Use a single batch to allocate pickup code atomically, update order, update payment, and record events.
    await this.db.batch([
      this.db
        .prepare(
          \`UPDATE orders SET 
            public_job_code = COALESCE(public_job_code, ?),
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
                     AND (o2.status NOT IN ('COMPLETED', 'CANCELLED') OR (o2.purge_at_ms IS NOT NULL AND o2.purge_at_ms > ?))
                 )
                 LIMIT 1
              )
            )),
            status = 'QUEUED', paid_at_ms = COALESCE(paid_at_ms, ?),
            queued_at_ms = COALESCE(queued_at_ms, ?), updated_at_ms = ?
           WHERE id = ? AND cleanup_state = 'ACTIVE' AND (
             status IN ('PAYMENT_PENDING', 'PAYMENT_FAILED', 'PAYMENT_CANCELLED', 'PAID')
             OR (status = 'QUEUED' AND public_job_code = ?)
           )\`
        )
        .bind(
          input.jobCode,
          input.nowMs,
          input.nowMs,
          input.nowMs,
          input.nowMs,
          before.orderId,
          input.jobCode,
        ),
      this.db
        .prepare(
          \`UPDATE installation SET 
            next_pickup_code_index = (
              SELECT ((unicode(substr(pickup_code, 2, 1)) - 65) * 999 + cast(substr(pickup_code, 4, 3) AS INT)) % 25974 
              FROM orders WHERE id = ?
            ),
            updated_at_ms = ?
          WHERE id = 1 AND EXISTS (SELECT 1 FROM orders WHERE id = ? AND paid_at_ms = ?)\`
        )
        .bind(before.orderId, input.nowMs, before.orderId, input.nowMs),
      this.db
        .prepare(
          \`UPDATE payments SET provider_payment_id = ?, status = 'PAID',
            verified_at_ms = ?, updated_at_ms = ?
          WHERE id = ? AND status IN ('CREATED', 'PENDING', 'FAILED', 'CANCELLED')\`,
        )
        .bind(
          input.providerPaymentId,
          input.nowMs,
          input.nowMs,
          input.paymentId,
        ),
      this.db
        .prepare(
          \`INSERT OR IGNORE INTO payment_attempts
            (id, payment_id, provider_payment_id, status, error_reason)
          VALUES (?, ?, ?, 'VERIFIED', NULL)\`,
        )
        .bind(crypto.randomUUID(), input.paymentId, input.providerPaymentId),
      this.db
        .prepare(
          \`INSERT OR IGNORE INTO order_events
            (id, order_id, event_type, from_status, to_status, actor_type,
             details_json, created_at_ms, idempotency_key)
          VALUES (?, ?, 'PAYMENT_VERIFIED', 'PAYMENT_PENDING', 'PAID', ?, ?, ?, ?)\`,
        )
        .bind(
          crypto.randomUUID(),
          before.orderId,
          input.actorType,
          JSON.stringify({
            paymentId: input.paymentId,
            providerPaymentId: input.providerPaymentId,
          }),
          input.nowMs,
          \`payment:\${input.paymentId}:paid\`,
        ),
      this.db
        .prepare(
          \`INSERT OR IGNORE INTO order_events
            (id, order_id, event_type, from_status, to_status, actor_type,
             details_json, created_at_ms, idempotency_key)
          VALUES (?, ?, 'JOB_CODE_ASSIGNED', 'PAID', 'PAID', 'SYSTEM', ?, ?, ?)\`,
        )
        .bind(
          crypto.randomUUID(),
          before.orderId,
          JSON.stringify({ paymentId: input.paymentId }),
          input.nowMs,
          \`payment:\${input.paymentId}:job-code\`,
        ),
      this.db
        .prepare(
          \`INSERT OR IGNORE INTO order_events
            (id, order_id, event_type, from_status, to_status, actor_type,
             details_json, created_at_ms, idempotency_key)
          VALUES (?, ?, 'QUEUED', 'PAID', 'QUEUED', 'SYSTEM', ?, ?, ?)\`,
        )
        .bind(
          crypto.randomUUID(),
          before.orderId,
          JSON.stringify({ paymentId: input.paymentId }),
          input.nowMs,
          \`payment:\${input.paymentId}:queued\`,
        ),
    ]);
    const result = await this.findPayment("p.id", input.paymentId);
    if (!result?.publicJobCode || result.status !== "PAID") {
      throw new Error("Payment finalization did not complete.");
    }
    return result;
  }`;

// Find finalizePaid and replace
const regex = /  async finalizePaid\([\s\S]*?    return result;\n  }/;
code = code.replace(regex, newFinalizePaid);

// Now also replace `identification_required` everywhere in this file!
code = code.replace(/, o\.identification_required/g, '');
code = code.replace(/identificationRequired: row\.identification_required === 1,/g, '');

fs.writeFileSync(file, code);
