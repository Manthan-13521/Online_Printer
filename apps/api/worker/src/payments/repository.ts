import { WEBHOOK_PROCESSING_STALE_TIMEOUT_MS } from "@printgo/domain";

export interface PayableDraftRecord {
  orderId: string;
  uploadId: string;
  objectKey: string;
  customerName: string;
  customerPhone: string;
  originalFilename: string;
  sourcePageCount: number;
  selectedPages: string;
  copies: number;
  paperSize: "A4" | "A3";
  colorMode: "BW" | "COLOR";
  sides: "SINGLE" | "DOUBLE";
  printingAmountPaise: number;
  serviceChargePaise: number;
  totalAmountPaise: number;
  currency: "INR";
  orderStatus: string;
  publicJobCode: string | null;
  expectedSizeBytes: number;
  actualSizeBytes: number | null;
  storageStatus: string;
  expiresAtMs: number;
  deleteAfterMs: number | null;
}

export interface PaymentRecord {
  id: string;
  orderId: string;
  providerOrderId: string;
  providerPaymentId: string | null;
  amountPaise: number;
  orderAmountPaise: number;
  currency: "INR";
  status: "CREATED" | "PENDING" | "PAID" | "FAILED" | "CANCELLED" | "REFUNDED";
  publicJobCode: string | null;
  orderStatus: string;
}

interface DraftRow {
  order_id: string;
  upload_id: string;
  r2_object_key: string;
  customer_name: string;
  customer_phone: string;
  original_filename: string;
  source_page_count: number;
  selected_pages: string;
  copies: number;
  paper_size: "A4" | "A3";
  color_mode: "BW" | "COLOR";
  sides: "SINGLE" | "DOUBLE";
  printing_amount_paise: number;
  service_charge_paise: number;
  total_amount_paise: number;
  currency: "INR";
  order_status: string;
  public_job_code: string | null;
  expected_size_bytes: number;
  size_bytes: number | null;
  storage_status: string;
  draft_expires_at_ms: number;
  delete_after_ms: number | null;
}

interface PaymentRow {
  id: string;
  order_id: string;
  provider_order_id: string;
  provider_payment_id: string | null;
  amount_paise: number;
  order_amount_paise: number;
  currency: "INR";
  status: PaymentRecord["status"];
  public_job_code: string | null;
  order_status: string;
}

function mapPayment(row: PaymentRow | null): PaymentRecord | null {
  return row
    ? {
        id: row.id,
        orderId: row.order_id,
        providerOrderId: row.provider_order_id,
        providerPaymentId: row.provider_payment_id,
        amountPaise: row.amount_paise,
        orderAmountPaise: row.order_amount_paise,
        currency: row.currency,
        status: row.status,
        publicJobCode: row.public_job_code,
        orderStatus: row.order_status,
      }
    : null;
}

export interface PaymentRepository {
  findDraft(tokenHash: string): Promise<PayableDraftRecord | null>;
  saveRecalculatedQuote(input: {
    orderId: string;
    selectedPages: string;
    printingAmountPaise: number;
    serviceChargePaise: number;
    totalAmountPaise: number;
    nowMs: number;
  }): Promise<boolean>;
  findActivePayment(orderId: string): Promise<PaymentRecord | null>;
  reservePayment(input: {
    paymentId: string;
    orderId: string;
    temporaryProviderOrderId: string;
    amountPaise: number;
    nowMs: number;
  }): Promise<void>;
  activatePayment(input: {
    paymentId: string;
    providerOrderId: string;
    nowMs: number;
  }): Promise<void>;
  abandonReservation(paymentId: string, nowMs: number): Promise<void>;
  findPaymentByProviderOrderId(
    providerOrderId: string,
  ): Promise<PaymentRecord | null>;
  finalizePaid(input: {
    paymentId: string;
    providerPaymentId: string;
    jobCode: string;
    nowMs: number;
    actorType: "CUSTOMER" | "PAYMENT_PROVIDER";
  }): Promise<PaymentRecord>;
  cancelPayment(input: {
    paymentId: string;
    nowMs: number;
    retainedUntilMs: number;
  }): Promise<void>;
  failPayment(input: {
    paymentId: string;
    providerPaymentId: string | null;
    nowMs: number;
    retainedUntilMs: number;
  }): Promise<void>;
  claimProviderEvent(input: {
    id: string;
    providerEventId: string;
    eventType: string;
    nowMs: number;
    staleTimeoutMs?: number;
  }): Promise<boolean>;
  finishProviderEvent(input: {
    providerEventId: string;
    status: "PROCESSED" | "FAILED" | "IGNORED";
    paymentId?: string;
    orderId?: string;
    nowMs: number;
  }): Promise<void>;
}

export class D1PaymentRepository implements PaymentRepository {
  constructor(private readonly db: D1Database) {}

  async findDraft(tokenHash: string): Promise<PayableDraftRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT o.id AS order_id, u.id AS upload_id, u.r2_object_key,
          o.customer_name, o.customer_phone, o.original_filename,
          o.source_page_count, o.selected_pages, o.copies, o.paper_size,
          o.color_mode, o.sides, o.printing_amount_paise,
          o.service_charge_paise, o.total_amount_paise, o.currency,
          o.status AS order_status, o.public_job_code,
          u.expected_size_bytes, u.size_bytes, u.storage_status,
          o.draft_expires_at_ms, u.delete_after_ms
        FROM orders o JOIN uploads u ON u.order_id = o.id
        WHERE o.draft_token_hash = ?`,
      )
      .bind(tokenHash)
      .first<DraftRow>();
    return row
      ? {
          orderId: row.order_id,
          uploadId: row.upload_id,
          objectKey: row.r2_object_key,
          customerName: row.customer_name,
          customerPhone: row.customer_phone,
          originalFilename: row.original_filename,
          sourcePageCount: row.source_page_count,
          selectedPages: row.selected_pages,
          copies: row.copies,
          paperSize: row.paper_size,
          colorMode: row.color_mode,
          sides: row.sides,
          printingAmountPaise: row.printing_amount_paise,
          serviceChargePaise: row.service_charge_paise,
          totalAmountPaise: row.total_amount_paise,
          currency: row.currency,
          orderStatus: row.order_status,
          publicJobCode: row.public_job_code,
          expectedSizeBytes: row.expected_size_bytes,
          actualSizeBytes: row.size_bytes,
          storageStatus: row.storage_status,
          expiresAtMs: row.draft_expires_at_ms,
          deleteAfterMs: row.delete_after_ms,
        }
      : null;
  }

  async saveRecalculatedQuote(
    input: Parameters<PaymentRepository["saveRecalculatedQuote"]>[0],
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE orders SET selected_pages = ?, printing_amount_paise = ?,
          service_charge_paise = ?, total_amount_paise = ?,
          status = 'PAYMENT_PENDING', updated_at_ms = ?
        WHERE id = ? AND status IN
          ('UPLOADED', 'PAYMENT_PENDING', 'PAYMENT_FAILED', 'PAYMENT_CANCELLED')`,
      )
      .bind(
        input.selectedPages,
        input.printingAmountPaise,
        input.serviceChargePaise,
        input.totalAmountPaise,
        input.nowMs,
        input.orderId,
      )
      .run();
    return result.meta.changes === 1;
  }

  private async findPayment(where: string, value: string) {
    const row = await this.db
      .prepare(
        `SELECT p.id, p.order_id, p.provider_order_id, p.provider_payment_id,
          p.amount_paise, o.total_amount_paise AS order_amount_paise,
          p.currency, p.status, o.public_job_code,
          o.status AS order_status
        FROM payments p JOIN orders o ON o.id = p.order_id
        WHERE ${where} = ? ORDER BY p.created_at_ms DESC LIMIT 1`,
      )
      .bind(value)
      .first<PaymentRow>();
    return mapPayment(row);
  }

  async findActivePayment(orderId: string): Promise<PaymentRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT p.id, p.order_id, p.provider_order_id, p.provider_payment_id,
          p.amount_paise, o.total_amount_paise AS order_amount_paise,
          p.currency, p.status, o.public_job_code,
          o.status AS order_status
        FROM payments p JOIN orders o ON o.id = p.order_id
        WHERE p.order_id = ? AND p.status IN ('CREATED', 'PENDING')
        ORDER BY p.created_at_ms DESC LIMIT 1`,
      )
      .bind(orderId)
      .first<PaymentRow>();
    return mapPayment(row);
  }

  async reservePayment(
    input: Parameters<PaymentRepository["reservePayment"]>[0],
  ): Promise<void> {
    const results = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO payments
            (id, order_id, provider_order_id, amount_paise, currency, status,
             created_at_ms, updated_at_ms)
          VALUES (?, ?, ?, ?, 'INR', 'CREATED', ?, ?)`,
        )
        .bind(
          input.paymentId,
          input.orderId,
          input.temporaryProviderOrderId,
          input.amountPaise,
          input.nowMs,
          input.nowMs,
        ),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO order_events
            (id, order_id, event_type, from_status, to_status, actor_type,
             details_json, created_at_ms, idempotency_key)
          SELECT ?, id, 'PAYMENT_ORDER_CREATED', status, 'PAYMENT_PENDING',
            'CUSTOMER', ?, ?, ? FROM orders WHERE id = ?`,
        )
        .bind(
          crypto.randomUUID(),
          JSON.stringify({ paymentId: input.paymentId }),
          input.nowMs,
          `payment:${input.paymentId}:pending`,
          input.orderId,
        ),
      this.db
        .prepare(
          `UPDATE orders SET status = 'PAYMENT_PENDING', updated_at_ms = ?
          WHERE id = ? AND status IN
            ('UPLOADED', 'PAYMENT_PENDING', 'PAYMENT_FAILED', 'PAYMENT_CANCELLED')`,
        )
        .bind(input.nowMs, input.orderId),
    ]);
    if (results[0]?.meta.changes !== 1) {
      throw new Error("Payment reservation failed.");
    }
  }

  async activatePayment(
    input: Parameters<PaymentRepository["activatePayment"]>[0],
  ): Promise<void> {
    const result = await this.db
      .prepare(
        `UPDATE payments SET provider_order_id = ?, status = 'PENDING',
          updated_at_ms = ? WHERE id = ? AND status = 'CREATED'`,
      )
      .bind(input.providerOrderId, input.nowMs, input.paymentId)
      .run();
    if (result.meta.changes !== 1) {
      throw new Error("Payment activation failed.");
    }
  }

  async abandonReservation(paymentId: string, nowMs: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE payments SET status = 'FAILED', updated_at_ms = ?
        WHERE id = ? AND status = 'CREATED'`,
      )
      .bind(nowMs, paymentId)
      .run();
  }

  findPaymentByProviderOrderId(
    providerOrderId: string,
  ): Promise<PaymentRecord | null> {
    return this.findPayment("p.provider_order_id", providerOrderId);
  }

  async finalizePaid(
    input: Parameters<PaymentRepository["finalizePaid"]>[0],
  ): Promise<PaymentRecord> {
    const before = await this.findPayment("p.id", input.paymentId);
    if (!before) throw new Error("Payment record missing.");
    if (before.status === "PAID" && before.publicJobCode) return before;
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE payments SET provider_payment_id = ?, status = 'PAID',
            verified_at_ms = ?, updated_at_ms = ?
          WHERE id = ? AND status IN ('CREATED', 'PENDING', 'FAILED', 'CANCELLED')`,
        )
        .bind(
          input.providerPaymentId,
          input.nowMs,
          input.nowMs,
          input.paymentId,
        ),
      this.db
        .prepare(
          `UPDATE orders SET public_job_code = COALESCE(public_job_code, ?),
            status = 'QUEUED', paid_at_ms = COALESCE(paid_at_ms, ?),
            queued_at_ms = COALESCE(queued_at_ms, ?), updated_at_ms = ?
          WHERE id = ? AND status IN
            ('PAYMENT_PENDING', 'PAYMENT_FAILED', 'PAYMENT_CANCELLED', 'PAID')`,
        )
        .bind(
          input.jobCode,
          input.nowMs,
          input.nowMs,
          input.nowMs,
          before.orderId,
        ),
      this.db
        .prepare(
          `UPDATE uploads SET retention_reason = NULL, delete_after_ms = NULL,
            updated_at_ms = ? WHERE order_id = ?`,
        )
        .bind(input.nowMs, before.orderId),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO order_events
            (id, order_id, event_type, from_status, to_status, actor_type,
             details_json, created_at_ms, idempotency_key)
          VALUES (?, ?, 'PAYMENT_VERIFIED', 'PAYMENT_PENDING', 'PAID', ?, ?, ?, ?)`,
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
          `payment:${input.paymentId}:paid`,
        ),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO order_events
            (id, order_id, event_type, from_status, to_status, actor_type,
             details_json, created_at_ms, idempotency_key)
          VALUES (?, ?, 'JOB_CODE_ASSIGNED', 'PAID', 'PAID', 'SYSTEM', ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          before.orderId,
          JSON.stringify({ paymentId: input.paymentId }),
          input.nowMs,
          `payment:${input.paymentId}:job-code`,
        ),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO order_events
            (id, order_id, event_type, from_status, to_status, actor_type,
             details_json, created_at_ms, idempotency_key)
          VALUES (?, ?, 'QUEUED', 'PAID', 'QUEUED', 'SYSTEM', ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          before.orderId,
          JSON.stringify({ paymentId: input.paymentId }),
          input.nowMs,
          `payment:${input.paymentId}:queued`,
        ),
    ]);
    const result = await this.findPayment("p.id", input.paymentId);
    if (!result?.publicJobCode || result.status !== "PAID") {
      throw new Error("Payment finalization did not complete.");
    }
    return result;
  }

  async cancelPayment(
    input: Parameters<PaymentRepository["cancelPayment"]>[0],
  ): Promise<void> {
    const payment = await this.findPayment("p.id", input.paymentId);
    if (!payment || payment.status === "PAID") return;
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE payments SET status = 'CANCELLED', updated_at_ms = ?
          WHERE id = ? AND status IN ('CREATED', 'PENDING')`,
        )
        .bind(input.nowMs, input.paymentId),
      this.db
        .prepare(
          `UPDATE orders SET status = 'PAYMENT_CANCELLED', updated_at_ms = ?,
            draft_expires_at_ms = ? WHERE id = ? AND status = 'PAYMENT_PENDING'`,
        )
        .bind(input.nowMs, input.retainedUntilMs, payment.orderId),
      this.db
        .prepare(
          `UPDATE uploads SET retention_reason = 'PAYMENT_FAILED_OR_CANCELLED',
            delete_after_ms = ?, updated_at_ms = ? WHERE order_id = ?`,
        )
        .bind(input.retainedUntilMs, input.nowMs, payment.orderId),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO order_events
            (id, order_id, event_type, from_status, to_status, actor_type,
             details_json, created_at_ms, idempotency_key)
          VALUES (?, ?, 'PAYMENT_CANCELLED', 'PAYMENT_PENDING',
            'PAYMENT_CANCELLED', 'CUSTOMER', ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          payment.orderId,
          JSON.stringify({ paymentId: input.paymentId }),
          input.nowMs,
          `payment:${input.paymentId}:cancelled`,
        ),
    ]);
  }

  async failPayment(
    input: Parameters<PaymentRepository["failPayment"]>[0],
  ): Promise<void> {
    const payment = await this.findPayment("p.id", input.paymentId);
    if (!payment || payment.status === "PAID" || payment.status === "FAILED")
      return;
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE payments SET provider_payment_id = COALESCE(provider_payment_id, ?),
            status = 'FAILED', updated_at_ms = ?
          WHERE id = ? AND status IN ('CREATED', 'PENDING')`,
        )
        .bind(input.providerPaymentId, input.nowMs, input.paymentId),
      this.db
        .prepare(
          `UPDATE orders SET status = 'PAYMENT_FAILED', updated_at_ms = ?,
            draft_expires_at_ms = ? WHERE id = ? AND status = 'PAYMENT_PENDING'`,
        )
        .bind(input.nowMs, input.retainedUntilMs, payment.orderId),
      this.db
        .prepare(
          `UPDATE uploads SET retention_reason = 'PAYMENT_FAILED_OR_CANCELLED',
            delete_after_ms = ?, updated_at_ms = ? WHERE order_id = ?`,
        )
        .bind(input.retainedUntilMs, input.nowMs, payment.orderId),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO order_events
            (id, order_id, event_type, from_status, to_status, actor_type,
             details_json, created_at_ms, idempotency_key)
          VALUES (?, ?, 'PAYMENT_FAILED', 'PAYMENT_PENDING', 'PAYMENT_FAILED',
            'PAYMENT_PROVIDER', ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          payment.orderId,
          JSON.stringify({
            paymentId: input.paymentId,
            providerPaymentId: input.providerPaymentId,
          }),
          input.nowMs,
          `payment:${input.paymentId}:failed`,
        ),
    ]);
  }

  async claimProviderEvent(
    input: Parameters<PaymentRepository["claimProviderEvent"]>[0],
  ): Promise<boolean> {
    const staleThresholdMs =
      input.staleTimeoutMs ?? WEBHOOK_PROCESSING_STALE_TIMEOUT_MS;
    try {
      await this.db
        .prepare(
          `INSERT INTO payment_provider_events
            (id, provider_event_id, event_type, received_at_ms, processing_status)
          VALUES (?, ?, ?, ?, 'PROCESSING')`,
        )
        .bind(input.id, input.providerEventId, input.eventType, input.nowMs)
        .run();
      return true;
    } catch {
      const staleBeforeMs = input.nowMs - staleThresholdMs;
      const result = await this.db
        .prepare(
          `UPDATE payment_provider_events
            SET processing_status = 'PROCESSING',
                received_at_ms = ?,
                processed_at_ms = NULL
          WHERE provider = 'RAZORPAY'
            AND provider_event_id = ?
            AND (
              processing_status = 'FAILED'
              OR (processing_status = 'PROCESSING' AND received_at_ms <= ?)
            )`,
        )
        .bind(input.nowMs, input.providerEventId, staleBeforeMs)
        .run();
      return result.meta.changes === 1;
    }
  }

  async finishProviderEvent(
    input: Parameters<PaymentRepository["finishProviderEvent"]>[0],
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE payment_provider_events SET processing_status = ?,
          processed_at_ms = ?, related_payment_id = COALESCE(?, related_payment_id),
          related_order_id = COALESCE(?, related_order_id)
        WHERE provider = 'RAZORPAY' AND provider_event_id = ?`,
      )
      .bind(
        input.status,
        input.nowMs,
        input.paymentId ?? null,
        input.orderId ?? null,
        input.providerEventId,
      )
      .run();
  }
}
