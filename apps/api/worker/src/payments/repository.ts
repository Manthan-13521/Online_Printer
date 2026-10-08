import {
  indexToPickupCode,
  TOTAL_PICKUP_CODES,
  UNRESOLVED_PAID_FAILURE_RETENTION_MS,
  WEBHOOK_PROCESSING_STALE_TIMEOUT_MS,
} from "@printgo/domain";

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
  isPriority: boolean;
  currency: "INR";
  orderStatus: string;
  publicJobCode: string | null;
  expectedSizeBytes: number;
  actualSizeBytes: number | null;
  storageStatus: string;
  expiresAtMs: number;
  deleteAfterMs: number | null;
  files?: PayableFileRecord[];
}

export interface PayableFileRecord {
  id: string;
  position: number;
  objectKey: string;
  originalFilename: string;
  sourcePageCount: number;
  selectedPages: string;
  selectedPageCount: number | null;
  copies: number;
  paperSize: "A4" | "A3";
  colorMode: "BW" | "COLOR";
  sides: "SINGLE" | "DOUBLE";
  expectedSizeBytes: number;
  actualSizeBytes: number | null;
  uploadStatus: string;
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
  pickupCode?: string | null;
  isPriority?: boolean;
  identificationRequired?: boolean;
}

export interface RetainedPaymentRecord {
  id: string;
  providerOrderId: string;
  providerPaymentId: string | null;
  amountPaise: number;
  currency: string;
  status: string;
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
  is_priority: number;
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
  pickup_code?: string | null;
  is_priority?: number;
  identification_required?: number;
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
        pickupCode: row.pickup_code ?? null,
        isPriority: row.is_priority === 1,
        identificationRequired: row.identification_required === 1,
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
    isPriority: boolean;
    priorityFeePaise: number;
    discountAmountPaise: number;
    snapshotDiscountThresholdPaise: number | null;
    snapshotDiscountPercent: number | null;
    identificationRequired: boolean;
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
  findRetainedPaymentByProviderOrderId(
    providerOrderId: string,
  ): Promise<RetainedPaymentRecord | null>;
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
  /**
   * After finalizePaid sets an order to QUEUED, call this to route it to
   * MANUAL_PRINT if any of its addon services require manual handling.
   * Safe to call even when no addons are present (no-op in that case).
   */
  routeOrderAfterPayment(orderId: string, nowMs: number): Promise<void>;
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
          o.service_charge_paise, o.total_amount_paise, o.is_priority, o.currency,
          o.status AS order_status, o.public_job_code,
          u.expected_size_bytes, u.size_bytes, u.storage_status,
          o.draft_expires_at_ms, u.delete_after_ms
        FROM orders o JOIN uploads u ON u.order_id = o.id
        WHERE o.draft_token_hash = ? AND o.cleanup_state = 'ACTIVE'`,
      )
      .bind(tokenHash)
      .first<DraftRow>();
    if (!row) return null;
    const files = await this.db
      .prepare(
        `SELECT id, position, r2_object_key, original_filename,
          source_page_count, selected_pages, selected_page_count, copies,
          paper_size, color_mode, sides, expected_size_bytes, size_bytes,
          upload_status
         FROM order_files WHERE order_id = ? ORDER BY position`,
      )
      .bind(row.order_id)
      .all<{
        id: string;
        position: number;
        r2_object_key: string;
        original_filename: string;
        source_page_count: number;
        selected_pages: string;
        selected_page_count: number | null;
        copies: number;
        paper_size: "A4" | "A3";
        color_mode: "BW" | "COLOR";
        sides: "SINGLE" | "DOUBLE";
        expected_size_bytes: number;
        size_bytes: number | null;
        upload_status: string;
      }>();
    return {
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
      isPriority: row.is_priority === 1,
      currency: row.currency,
      orderStatus: row.order_status,
      publicJobCode: row.public_job_code,
      expectedSizeBytes: row.expected_size_bytes,
      actualSizeBytes: row.size_bytes,
      storageStatus: row.storage_status,
      expiresAtMs: row.draft_expires_at_ms,
      deleteAfterMs: row.delete_after_ms,
      files: files.results.map((file) => ({
        id: file.id,
        position: file.position,
        objectKey: file.r2_object_key,
        originalFilename: file.original_filename,
        sourcePageCount: file.source_page_count,
        selectedPages: file.selected_pages,
        selectedPageCount: file.selected_page_count,
        copies: file.copies,
        paperSize: file.paper_size,
        colorMode: file.color_mode,
        sides: file.sides,
        expectedSizeBytes: file.expected_size_bytes,
        actualSizeBytes: file.size_bytes,
        uploadStatus: file.upload_status,
      })),
    };
  }

  async saveRecalculatedQuote(
    input: Parameters<PaymentRepository["saveRecalculatedQuote"]>[0],
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE orders SET selected_pages = ?, printing_amount_paise = ?,
          service_charge_paise = ?, total_amount_paise = ?,
          is_priority = ?, priority_fee_paise = ?, discount_amount_paise = ?,
          snapshot_discount_threshold_paise = ?, snapshot_discount_percent = ?,
          identification_required = ?,
          status = 'PAYMENT_PENDING', updated_at_ms = ?
        WHERE id = ? AND status IN
          ('UPLOADED', 'PAYMENT_PENDING', 'PAYMENT_FAILED', 'PAYMENT_CANCELLED')
          AND cleanup_state = 'ACTIVE'
          AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = orders.id
            AND p.status IN ('CREATED', 'PENDING', 'PAID'))
          AND (status <> 'PAYMENT_PENDING' OR selected_pages IS NOT ? OR printing_amount_paise IS NOT ?
            OR service_charge_paise IS NOT ? OR total_amount_paise IS NOT ?
            OR is_priority IS NOT ? OR priority_fee_paise IS NOT ? OR discount_amount_paise IS NOT ?
            OR snapshot_discount_threshold_paise IS NOT ? OR snapshot_discount_percent IS NOT ?
            OR identification_required IS NOT ?)`,
      )
      .bind(
        input.selectedPages,
        input.printingAmountPaise,
        input.serviceChargePaise,
        input.totalAmountPaise,
        input.isPriority ? 1 : 0,
        input.priorityFeePaise,
        input.discountAmountPaise,
        input.snapshotDiscountThresholdPaise,
        input.snapshotDiscountPercent,
        input.identificationRequired ? 1 : 0,
        input.nowMs,
        input.orderId,
        input.selectedPages,
        input.printingAmountPaise,
        input.serviceChargePaise,
        input.totalAmountPaise,
        input.isPriority ? 1 : 0,
        input.priorityFeePaise,
        input.discountAmountPaise,
        input.snapshotDiscountThresholdPaise,
        input.snapshotDiscountPercent,
        input.identificationRequired ? 1 : 0,
      )
      .run();
    if (result.meta.changes === 1) return true;
    // A no-op quote is valid only while the same authoritative quote remains payable.
    return Boolean(
      await this.db
        .prepare(
          `SELECT 1 FROM orders WHERE id = ? AND status = 'PAYMENT_PENDING'
      AND cleanup_state = 'ACTIVE'
      AND selected_pages IS ? AND printing_amount_paise IS ? AND service_charge_paise IS ? AND total_amount_paise IS ?
      AND is_priority IS ? AND priority_fee_paise IS ? AND discount_amount_paise IS ?
      AND snapshot_discount_threshold_paise IS ? AND snapshot_discount_percent IS ?
      AND identification_required IS ?`,
        )
        .bind(
          input.orderId,
          input.selectedPages,
          input.printingAmountPaise,
          input.serviceChargePaise,
          input.totalAmountPaise,
          input.isPriority ? 1 : 0,
          input.priorityFeePaise,
          input.discountAmountPaise,
          input.snapshotDiscountThresholdPaise,
          input.snapshotDiscountPercent,
          input.identificationRequired ? 1 : 0,
        )
        .first(),
    );
  }

  private async findPayment(where: string, value: string) {
    const row = await this.db
      .prepare(
        `SELECT p.id, p.order_id, p.provider_order_id, p.provider_payment_id,
          p.amount_paise, o.total_amount_paise AS order_amount_paise,
          p.currency, p.status, o.public_job_code,
          o.status AS order_status, o.pickup_code, o.is_priority, o.identification_required
        FROM payments p JOIN orders o ON o.id = p.order_id
        WHERE p.provider = 'RAZORPAY' AND ${where} = ? ORDER BY p.created_at_ms DESC LIMIT 1`,
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
          o.status AS order_status, o.pickup_code, o.is_priority, o.identification_required
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
          SELECT ?, o.id, ?, ?, 'INR', 'CREATED', ?, ? FROM orders o
          WHERE o.id = ? AND o.cleanup_state = 'ACTIVE'
            AND o.status IN ('PAYMENT_PENDING','PAYMENT_FAILED','PAYMENT_CANCELLED')
            AND o.total_amount_paise = ?
            AND EXISTS (SELECT 1 FROM order_files f WHERE f.order_id = o.id)
            AND NOT EXISTS (SELECT 1 FROM order_files f WHERE f.order_id = o.id
              AND f.upload_status <> 'UPLOADED')`,
        )
        .bind(
          input.paymentId,
          input.temporaryProviderOrderId,
          input.amountPaise,
          input.nowMs,
          input.nowMs,
          input.orderId,
          input.amountPaise,
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
            ('UPLOADED', 'PAYMENT_FAILED', 'PAYMENT_CANCELLED')`,
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

  async findRetainedPaymentByProviderOrderId(
    providerOrderId: string,
  ): Promise<RetainedPaymentRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT id, provider_order_id, provider_payment_id, amount_paise,
          currency, status FROM retained_payment_records
         WHERE provider = 'RAZORPAY' AND provider_order_id = ?`,
      )
      .bind(providerOrderId)
      .first<{
        id: string;
        provider_order_id: string;
        provider_payment_id: string | null;
        amount_paise: number;
        currency: string;
        status: string;
      }>();
    return row
      ? {
          id: row.id,
          providerOrderId: row.provider_order_id,
          providerPaymentId: row.provider_payment_id,
          amountPaise: row.amount_paise,
          currency: row.currency,
          status: row.status,
        }
      : null;
  }

  private async allocatePickupCode(nowMs: number): Promise<string> {
    const row = await this.db
      .prepare(`SELECT next_pickup_code_index FROM installation WHERE id = 1`)
      .first<{ next_pickup_code_index: number }>();
    const startIndex = row?.next_pickup_code_index ?? 0;

    for (let offset = 0; offset < TOTAL_PICKUP_CODES; offset++) {
      const candidateIndex = (startIndex + offset) % TOTAL_PICKUP_CODES;
      const candidateCode = indexToPickupCode(candidateIndex);

      const active = await this.db
        .prepare(
          `SELECT 1 FROM orders
           WHERE pickup_code = ?
             AND cleanup_state = 'ACTIVE'
           LIMIT 1`,
        )
        .bind(candidateCode)
        .first();

      if (!active) {
        const nextIndex = (candidateIndex + 1) % TOTAL_PICKUP_CODES;
        await this.db
          .prepare(
            `UPDATE installation SET next_pickup_code_index = ?, updated_at_ms = ? WHERE id = 1`,
          )
          .bind(nextIndex, nowMs)
          .run();
        return candidateCode;
      }
    }
    return indexToPickupCode(startIndex);
  }

  async finalizePaid(
    input: Parameters<PaymentRepository["finalizePaid"]>[0],
  ): Promise<PaymentRecord> {
    const before = await this.findPayment("p.id", input.paymentId);
    if (!before) throw new Error("Payment record missing.");
    if (before.status === "PAID" && before.publicJobCode) return before;

    const orderRow = await this.db
      .prepare(`SELECT pickup_code FROM orders WHERE id = ?`)
      .bind(before.orderId)
      .first<{ pickup_code: string | null }>();
    const pickupCode =
      orderRow?.pickup_code || (await this.allocatePickupCode(input.nowMs));

    const orderUpdate = await this.db
      .prepare(
        `UPDATE orders SET public_job_code = COALESCE(public_job_code, ?),
          pickup_code = COALESCE(pickup_code, ?),
          status = 'QUEUED', paid_at_ms = COALESCE(paid_at_ms, ?),
          queued_at_ms = COALESCE(queued_at_ms, ?), updated_at_ms = ?
         WHERE id = ? AND cleanup_state = 'ACTIVE' AND (
           status IN ('PAYMENT_PENDING', 'PAYMENT_FAILED', 'PAYMENT_CANCELLED', 'PAID')
           OR (status = 'QUEUED' AND public_job_code = ?)
         )`,
      )
      .bind(
        input.jobCode,
        pickupCode,
        input.nowMs,
        input.nowMs,
        input.nowMs,
        before.orderId,
        input.jobCode,
      )
      .run();
    if (orderUpdate.meta.changes !== 1)
      throw new Error("Payment order is no longer eligible for finalization.");
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
          `UPDATE uploads SET retention_reason = 'UNRESOLVED_PAID_FAILURE', delete_after_ms = ?,
            updated_at_ms = ? WHERE order_id = ?`,
        )
        .bind(
          input.nowMs + UNRESOLVED_PAID_FAILURE_RETENTION_MS,
          input.nowMs,
          before.orderId,
        ),
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
    const retained = await this.db
      .prepare(
        `SELECT 1 FROM retained_provider_events
         WHERE provider = 'RAZORPAY' AND provider_event_id = ?`,
      )
      .bind(input.providerEventId)
      .first();
    if (retained) return false;
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

  async routeOrderAfterPayment(orderId: string, nowMs: number): Promise<void> {
    // Check if any selected addon service requires manual printing
    const manualCheck = await this.db
      .prepare(
        `SELECT 1 FROM order_addon_services
         WHERE order_id = ? AND snapshot_handling_mode = 'MANUAL_PRINT'
         LIMIT 1`,
      )
      .bind(orderId)
      .first<{ 1: number }>();
    if (manualCheck === null) return; // No manual addons — stay QUEUED
    // Transition QUEUED → MANUAL_PRINT
    await this.db
      .prepare(
        `UPDATE orders
         SET status = 'MANUAL_PRINT', updated_at_ms = ?
         WHERE id = ? AND status = 'QUEUED' AND cleanup_state = 'ACTIVE'`,
      )
      .bind(nowMs, orderId)
      .run();
  }
}
