import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";

import { hashSessionToken } from "@printgo/auth";
import { FILE_SIZE_SERVICE_CHARGE_BANDS } from "@printgo/domain";
import { D1CustomerRepository } from "../customer/repository.js";
import { D1PaymentRepository } from "./repository.js";
import { PaymentService } from "./service.js";
import { D1PrintingRepository } from "../printing/repository.js";
import { hmacSha256Hex } from "./razorpay.js";

interface QueryMetrics {
  statements: number;
  returnedRows: number;
  changedRows: number;
}

class InstrumentedStatementWrapper {
  private bindings: SQLInputValue[] = [];
  constructor(
    private readonly db: DatabaseSync,
    readonly sql: string,
    private readonly metrics: QueryMetrics,
  ) {}

  bind(...values: unknown[]) {
    this.bindings = values.map((v) => {
      if (v === undefined || v === null) return null;
      if (typeof v === "boolean") return v ? 1 : 0;
      return v;
    }) as SQLInputValue[];
    return this;
  }

  first<T>(): Promise<T | null> {
    this.metrics.statements++;
    const row = this.db.prepare(this.sql).get(...this.bindings) as
      T | undefined;
    if (row) this.metrics.returnedRows++;
    return Promise.resolve(row ?? null);
  }

  all<T>(): Promise<D1Result<T>> {
    this.metrics.statements++;
    const results = this.db.prepare(this.sql).all(...this.bindings) as T[];
    this.metrics.returnedRows += results.length;
    return Promise.resolve({
      success: true,
      meta: { changes: 0 },
      results,
    } as unknown as D1Result<T>);
  }

  run(): Promise<D1Result> {
    this.metrics.statements++;
    const info = this.db.prepare(this.sql).run(...this.bindings);
    const changes = Number(info.changes);
    this.metrics.changedRows += changes;
    return Promise.resolve({
      success: true,
      meta: { changes },
      results: [],
    } as unknown as D1Result);
  }
}

class InstrumentedD1Database {
  readonly metrics: QueryMetrics = {
    statements: 0,
    returnedRows: 0,
    changedRows: 0,
  };

  constructor(private readonly db: DatabaseSync) {}

  prepare(query: string): InstrumentedStatementWrapper {
    return new InstrumentedStatementWrapper(this.db, query, this.metrics);
  }

  async batch(statements: InstrumentedStatementWrapper[]): Promise<D1Result[]> {
    const results: D1Result[] = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of statements) {
        if (statement.sql.trim().toUpperCase().startsWith("SELECT")) {
          results.push(await statement.all());
        } else {
          results.push(await statement.run());
        }
      }
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  exec(query: string): Promise<D1ExecResult> {
    this.db.exec(query);
    return Promise.resolve({ count: 1, duration: 0 });
  }
}

function createTestDatabase(): {
  db: DatabaseSync;
  d1: D1Database;
  metrics: QueryMetrics;
} {
  const db = new DatabaseSync(":memory:");
  const migrationFiles = readdirSync("database/migrations")
    .filter((file) => file.endsWith(".sql"))
    .sort();

  for (const file of migrationFiles) {
    const sql = readFileSync(`database/migrations/${file}`, "utf8");
    db.exec(sql);
  }

  const instrumented = new InstrumentedD1Database(db);
  return {
    db,
    d1: instrumented as unknown as D1Database,
    metrics: instrumented.metrics,
  };
}

describe("Critical Payment & Print Queue Fix: Webhook/Verify Race & DUPLICATE_CAPTURED Self-Healing", () => {
  let db: DatabaseSync;
  let d1: D1Database;
  let customerRepo: D1CustomerRepository;
  let paymentRepo: D1PaymentRepository;
  let printingRepo: D1PrintingRepository;
  let currentSimulatedTime: number;

  const RZP_KEY_SECRET = "rzp_secret_test_key_12345";
  const AGENT_ID = "11111111-1111-4111-8111-111111111111";
  const PRINTER_ID = "22222222-2222-4222-8222-222222222222";

  beforeEach(async () => {
    currentSimulatedTime = 1791719200000;
    const testDb = createTestDatabase();
    db = testDb.db;
    d1 = testDb.d1;

    customerRepo = new D1CustomerRepository(d1);
    paymentRepo = new D1PaymentRepository(d1);
    printingRepo = new D1PrintingRepository(d1);

    // Set up active agent and enabled online production printer
    const agentTokenHash = await hashSessionToken("agent-token-test-12345");
    db.prepare(
      `INSERT INTO agents (id, display_name, credential_hash, paired_at_ms, is_active, last_heartbeat_at_ms, created_at_ms, updated_at_ms)
       VALUES (?, 'Main Shop Agent', ?, ?, 1, ?, ?, ?)`,
    ).run(
      AGENT_ID,
      agentTokenHash,
      currentSimulatedTime,
      currentSimulatedTime,
      currentSimulatedTime,
      currentSimulatedTime,
    );

    db.prepare(
      `INSERT INTO printers (id, agent_id, display_name, windows_printer_name, status, enabled, priority, is_production_eligible, is_virtual, capabilities_json, created_at_ms, updated_at_ms)
       VALUES (?, ?, 'HP Laser MFP 135', 'HP Laser MFP 135', 'ONLINE', 1, 1, 1, 0, ?, ?, ?)`,
    ).run(
      PRINTER_ID,
      AGENT_ID,
      JSON.stringify({ colour: false, duplex: false, paperSizes: ["A4"] }),
      currentSimulatedTime,
      currentSimulatedTime,
    );

    db.exec(`
      INSERT OR REPLACE INTO installation (
        id, shop_name, contact_phone, address, customer_notice,
        online_printing_enabled, cash_orders_enabled, max_pdf_size_bytes, max_order_upload_bytes,
        identification_sheet_enabled, default_production_printer_id,
        created_at_ms, updated_at_ms
      ) VALUES (
        1, 'PrintGo Test Shop', '+919876543210', '123 Market St', 'Welcome',
        1, 1, 26214400, 104857600,
        0, '${PRINTER_ID}',
        ${currentSimulatedTime}, ${currentSimulatedTime}
      );
    `);

    const paperSizes = ["A4", "A3"] as const;
    const colorModes = ["BW", "COLOR"] as const;
    const sidesModes = ["SINGLE", "DOUBLE"] as const;
    let rateIdx = 1;
    for (const paperSize of paperSizes) {
      for (const colorMode of colorModes) {
        for (const sides of sidesModes) {
          const id = `00000000-0000-4000-8000-${String(rateIdx++).padStart(12, "0")}`;
          db.prepare(
            `INSERT INTO print_rates (id, paper_size, color_mode, sides, price_per_page_paise, enabled, created_at_ms, updated_at_ms)
             VALUES (?, ?, ?, ?, 200, 1, ?, ?)`,
          ).run(
            id,
            paperSize,
            colorMode,
            sides,
            currentSimulatedTime,
            currentSimulatedTime,
          );
        }
      }
    }

    FILE_SIZE_SERVICE_CHARGE_BANDS.forEach((band, index) => {
      const id = `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
      db.prepare(
        `INSERT INTO file_size_service_charges (id, min_bytes_exclusive, max_bytes_inclusive, charge_paise, enabled, sort_order, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, 0, 1, ?, ?, ?)`,
      ).run(
        id,
        band.minBytesExclusive,
        band.maxBytesInclusive,
        index + 1,
        currentSimulatedTime,
        currentSimulatedTime,
      );
    });
  });

  async function createDraftWithUploadedFile(
    orderId = crypto.randomUUID(),
    rawToken = "token_test_1234567890123456789012345678901234567",
  ) {
    const tokenHash = await hashSessionToken(rawToken);
    const uploadId = crypto.randomUUID();
    const fileId = crypto.randomUUID();

    db.exec(`
      INSERT INTO orders (
        id, customer_name, customer_phone, original_filename, instructions, status,
        source_page_count, selected_pages, copies, paper_size, color_mode, sides,
        printing_amount_paise, service_charge_paise, total_amount_paise, currency,
        draft_token_hash, draft_expires_at_ms, cleanup_state, created_at_ms, updated_at_ms
      ) VALUES (
        '${orderId}', 'Alice Smith', '+919876543210', 'contract.pdf', 'Urgent print', 'PAYMENT_PENDING',
        5, '1-5', 1, 'A4', 'BW', 'SINGLE',
        1000, 0, 1000, 'INR',
        '${tokenHash}', ${currentSimulatedTime + 600000}, 'ACTIVE', ${currentSimulatedTime}, ${currentSimulatedTime}
      );

      INSERT INTO uploads (
        id, order_id, r2_object_key, original_filename, mime_type, expected_size_bytes, size_bytes,
        storage_status, retention_reason, delete_after_ms, created_at_ms, uploaded_at_ms, updated_at_ms
      ) VALUES (
        '${uploadId}', '${orderId}', 'uploads/${uploadId}.pdf', 'contract.pdf', 'application/pdf', 50000, 50000,
        'UPLOADED', 'UNPAID', ${currentSimulatedTime + 600000}, ${currentSimulatedTime}, ${currentSimulatedTime}, ${currentSimulatedTime}
      );

      INSERT INTO order_files (
        id, order_id, position, r2_object_key, original_filename,
        expected_size_bytes, size_bytes, source_page_count, selected_pages, selected_page_count,
        copies, paper_size, color_mode, sides, printing_amount_paise, service_charge_paise,
        upload_status, print_status, uploaded_at_ms, created_at_ms, updated_at_ms
      ) VALUES (
        '${fileId}', '${orderId}', 1, 'uploads/${uploadId}.pdf', 'contract.pdf',
        50000, 50000, 5, '1-5', 5,
        1, 'A4', 'BW', 'SINGLE', 1000, 0,
        'UPLOADED', 'PENDING', ${currentSimulatedTime}, ${currentSimulatedTime}, ${currentSimulatedTime}
      );
    `);

    return { orderId, rawToken, tokenHash };
  }

  it("BUG 1 & 2 FIX: When two concurrent requests finalize the same payment, payment stays PAID and is NEVER marked DUPLICATE_CAPTURED", async () => {
    const { orderId } = await createDraftWithUploadedFile();

    const paymentId = crypto.randomUUID();
    const providerOrderId = "order_rzp_test_concurrent_1";
    const providerPaymentId = "pay_rzp_test_concurrent_1";

    // Reserve and activate payment
    await paymentRepo.reservePayment({
      paymentId,
      orderId,
      temporaryProviderOrderId: `local_${paymentId}`,
      amountPaise: 1000,
      nowMs: currentSimulatedTime,
    });
    await paymentRepo.activatePayment({
      paymentId,
      providerOrderId,
      nowMs: currentSimulatedTime + 100,
    });

    // Request 1 (e.g. Webhook) finalizes payment
    const firstFinalized = await paymentRepo.finalizePaid({
      paymentId,
      providerPaymentId,
      jobCode: "PG-FIRST1",
      nowMs: currentSimulatedTime + 200,
      actorType: "PAYMENT_PROVIDER",
    });

    expect(firstFinalized.status).toBe("PAID");
    expect(firstFinalized.publicJobCode).toBe("PG-FIRST1");

    // Request 2 (Customer verify or duplicate webhook) calls finalizePaid with a different candidate jobCode
    const secondFinalized = await paymentRepo.finalizePaid({
      paymentId,
      providerPaymentId,
      jobCode: "PG-SECOND",
      nowMs: currentSimulatedTime + 300,
      actorType: "CUSTOMER",
    });

    // Critical invariant: second call MUST return the existing PAID record, NOT DUPLICATE_CAPTURED!
    expect(secondFinalized.status).toBe("PAID");
    expect(secondFinalized.publicJobCode).toBe("PG-FIRST1");

    // Inspect database row directly
    const row = db
      .prepare(
        "SELECT p.status, o.public_job_code FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.id = ?",
      )
      .get(paymentId) as { status: string; public_job_code: string };
    expect(row.status).toBe("PAID");
    expect(row.public_job_code).toBe("PG-FIRST1");

    // Verify NO duplicate captured event was recorded
    const duplicateEvents = db
      .prepare(
        "SELECT * FROM order_events WHERE order_id = ? AND event_type = 'PAYMENT_DUPLICATE_CAPTURED'",
      )
      .all(orderId);
    expect(duplicateEvents).toHaveLength(0);
  });

  it("BUG 1 FIX: Customer verify returns tracking data when webhook has already transitioned order to QUEUED", async () => {
    const { rawToken } = await createDraftWithUploadedFile();

    const paymentService = new PaymentService(
      paymentRepo,
      customerRepo,
      {
        head: () =>
          Promise.resolve({
            size: 50000,
            sizeBytes: 50000,
            etag: "pdf",
          } as unknown as R2Object),
      },
      {
        check: () =>
          Promise.resolve({ ready: true, source: "DEVELOPMENT_BYPASS" }),
      },
      {
        createOrder: () =>
          Promise.resolve({
            id: "order_rzp_mock_1",
            amount: 1000,
            currency: "INR",
            status: "created",
          }),
        fetchPayment: () =>
          Promise.resolve({
            id: "pay_rzp_mock_1",
            orderId: "order_rzp_mock_1",
            amount: 1000,
            currency: "INR",
            status: "captured",
          }),
      },
      { keyId: "rzp_key_test", keySecret: RZP_KEY_SECRET },
      {
        attachToVerifiedOrder: (_orderId: string, rawTrackingToken: string) =>
          Promise.resolve({
            rawToken: rawTrackingToken,
            expiresAt: new Date(currentSimulatedTime + 86400000).toISOString(),
          }),
      },
      () => currentSimulatedTime,
    );

    const checkout = await paymentService.createCheckout(rawToken, 1000);
    expect(checkout.status).toBe("CHECKOUT_READY");

    const payment =
      await paymentRepo.findPaymentByProviderOrderId("order_rzp_mock_1");
    expect(payment).not.toBeNull();

    // Webhook completes finalization first
    await paymentService.acceptCapturedWebhook(payment!, {
      id: "pay_rzp_mock_1",
      orderId: "order_rzp_mock_1",
      amount: 1000,
      currency: "INR",
      status: "captured",
    });

    // Compute valid HMAC signature
    const signature = await hmacSha256Hex(
      "order_rzp_mock_1|pay_rzp_mock_1",
      RZP_KEY_SECRET,
    );

    // Customer verify runs 300ms later: MUST SUCCEED with tracking data, NOT throw PAYMENT_STATE_INVALID
    const result = await paymentService.verify(rawToken, {
      razorpayOrderId: "order_rzp_mock_1",
      razorpayPaymentId: "pay_rzp_mock_1",
      razorpaySignature: signature,
      trackingToken: "T".repeat(43),
    });

    expect(result.status).toBe("QUEUED");
    expect(result.jobCode).toMatch(/^PG-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
    expect(result.trackingToken).toBe("T".repeat(43));
  });

  it("SAFETY INVARIANT: Customer verify on a DUPLICATE_CAPTURED payment rejects with PAYMENT_STATE_INVALID and NEVER returns tracking data", async () => {
    const { orderId, rawToken } = await createDraftWithUploadedFile();

    const paymentId = crypto.randomUUID();
    const providerOrderId = "order_rzp_dup_verify_1";
    const providerPaymentId = "pay_rzp_dup_verify_1";

    db.prepare(
      `UPDATE orders SET status = 'QUEUED', public_job_code = 'PG-JOB999', pickup_code = 'PA-123',
         paid_at_ms = ?, queued_at_ms = ?, updated_at_ms = ?
       WHERE id = ?`,
    ).run(
      currentSimulatedTime,
      currentSimulatedTime,
      currentSimulatedTime,
      orderId,
    );

    db.prepare(
      `INSERT INTO payments (id, order_id, provider, provider_order_id, provider_payment_id, amount_paise, currency, status, created_at_ms, updated_at_ms, verified_at_ms)
       VALUES (?, ?, 'RAZORPAY', ?, ?, 1000, 'INR', 'DUPLICATE_CAPTURED', ?, ?, ?)`,
    ).run(
      paymentId,
      orderId,
      providerOrderId,
      providerPaymentId,
      currentSimulatedTime,
      currentSimulatedTime,
      currentSimulatedTime,
    );

    const paymentService = new PaymentService(
      paymentRepo,
      customerRepo,
      {
        head: () =>
          Promise.resolve({
            size: 50000,
            sizeBytes: 50000,
            etag: "pdf",
          } as unknown as R2Object),
      },
      {
        check: () =>
          Promise.resolve({ ready: true, source: "DEVELOPMENT_BYPASS" }),
      },
      {
        createOrder: () => Promise.reject(new Error("not called")),
        fetchPayment: () => Promise.reject(new Error("not called")),
      },
      { keyId: "rzp_key_test", keySecret: RZP_KEY_SECRET },
      {
        attachToVerifiedOrder: (_orderId: string, rawTrackingToken: string) =>
          Promise.resolve({
            rawToken: rawTrackingToken,
            expiresAt: new Date(currentSimulatedTime + 86400000).toISOString(),
          }),
      },
      () => currentSimulatedTime,
    );

    const signature = await hmacSha256Hex(
      `${providerOrderId}|${providerPaymentId}`,
      RZP_KEY_SECRET,
    );

    // Critical Invariant: Customer verify MUST reject DUPLICATE_CAPTURED and not bypass payment check
    await expect(
      paymentService.verify(rawToken, {
        razorpayOrderId: providerOrderId,
        razorpayPaymentId: providerPaymentId,
        razorpaySignature: signature,
        trackingToken: "T".repeat(43),
      }),
    ).rejects.toThrow("PAYMENT_STATE_INVALID");
  });

  it("SAFETY INVARIANT: Customer verify with forged/mismatched razorpayPaymentId throws PAYMENT_ORDER_MISMATCH even if order is QUEUED", async () => {
    const { orderId, rawToken } = await createDraftWithUploadedFile();

    const paymentId = crypto.randomUUID();
    const providerOrderId = "order_rzp_mismatch_1";
    const realPaymentId = "pay_rzp_legit_1";
    const forgedPaymentId = "pay_rzp_forged_999";

    db.prepare(
      `UPDATE orders SET status = 'QUEUED', public_job_code = 'PG-FORGE1', pickup_code = 'PA-123',
         paid_at_ms = ?, queued_at_ms = ?, updated_at_ms = ?
       WHERE id = ?`,
    ).run(
      currentSimulatedTime,
      currentSimulatedTime,
      currentSimulatedTime,
      orderId,
    );

    db.prepare(
      `INSERT INTO payments (id, order_id, provider, provider_order_id, provider_payment_id, amount_paise, currency, status, created_at_ms, updated_at_ms, verified_at_ms)
       VALUES (?, ?, 'RAZORPAY', ?, ?, 1000, 'INR', 'PAID', ?, ?, ?)`,
    ).run(
      paymentId,
      orderId,
      providerOrderId,
      realPaymentId,
      currentSimulatedTime,
      currentSimulatedTime,
      currentSimulatedTime,
    );

    const paymentService = new PaymentService(
      paymentRepo,
      customerRepo,
      {
        head: () =>
          Promise.resolve({
            size: 50000,
            sizeBytes: 50000,
            etag: "pdf",
          } as unknown as R2Object),
      },
      {
        check: () =>
          Promise.resolve({ ready: true, source: "DEVELOPMENT_BYPASS" }),
      },
      {
        createOrder: () => Promise.reject(new Error("not called")),
        fetchPayment: () => Promise.reject(new Error("not called")),
      },
      { keyId: "rzp_key_test", keySecret: RZP_KEY_SECRET },
      {
        attachToVerifiedOrder: (_orderId: string, rawTrackingToken: string) =>
          Promise.resolve({
            rawToken: rawTrackingToken,
            expiresAt: new Date(currentSimulatedTime + 86400000).toISOString(),
          }),
      },
      () => currentSimulatedTime,
    );

    const forgedSignature = await hmacSha256Hex(
      `${providerOrderId}|${forgedPaymentId}`,
      RZP_KEY_SECRET,
    );

    await expect(
      paymentService.verify(rawToken, {
        razorpayOrderId: providerOrderId,
        razorpayPaymentId: forgedPaymentId,
        razorpaySignature: forgedSignature,
        trackingToken: "T".repeat(43),
      }),
    ).rejects.toThrow("PAYMENT_ORDER_MISMATCH");
  });

  it("SAFETY INVARIANT: Customer verify with invalid HMAC signature throws PAYMENT_SIGNATURE_INVALID", async () => {
    const { orderId, rawToken } = await createDraftWithUploadedFile();

    const paymentId = crypto.randomUUID();
    const providerOrderId = "order_rzp_sig_invalid";
    const paymentProviderId = "pay_rzp_sig_invalid";

    db.prepare(
      `INSERT INTO payments (id, order_id, provider, provider_order_id, provider_payment_id, amount_paise, currency, status, created_at_ms, updated_at_ms)
       VALUES (?, ?, 'RAZORPAY', ?, ?, 1000, 'INR', 'PENDING', ?, ?)`,
    ).run(
      paymentId,
      orderId,
      providerOrderId,
      paymentProviderId,
      currentSimulatedTime,
      currentSimulatedTime,
    );

    const paymentService = new PaymentService(
      paymentRepo,
      customerRepo,
      {
        head: () =>
          Promise.resolve({
            size: 50000,
            sizeBytes: 50000,
            etag: "pdf",
          } as unknown as R2Object),
      },
      {
        check: () =>
          Promise.resolve({ ready: true, source: "DEVELOPMENT_BYPASS" }),
      },
      {
        createOrder: () => Promise.reject(new Error("not called")),
        fetchPayment: () => Promise.reject(new Error("not called")),
      },
      { keyId: "rzp_key_test", keySecret: RZP_KEY_SECRET },
      {
        attachToVerifiedOrder: (_orderId: string, rawTrackingToken: string) =>
          Promise.resolve({
            rawToken: rawTrackingToken,
            expiresAt: new Date(currentSimulatedTime + 86400000).toISOString(),
          }),
      },
      () => currentSimulatedTime,
    );

    await expect(
      paymentService.verify(rawToken, {
        razorpayOrderId: providerOrderId,
        razorpayPaymentId: paymentProviderId,
        razorpaySignature: "invalid_hmac_hex_signature",
        trackingToken: "T".repeat(43),
      }),
    ).rejects.toThrow("PAYMENT_SIGNATURE_INVALID");
  });

  it("PRINT QUEUE PURITY: claimOrRenewAll requires pay.status = 'PAID' and strictly ignores orders with DUPLICATE_CAPTURED payments", async () => {
    const { orderId } = await createDraftWithUploadedFile();

    const paymentId = crypto.randomUUID();
    const providerOrderId = "order_rzp_unreconciled_1";
    const providerPaymentId = "pay_rzp_unreconciled_1";

    db.prepare(
      `UPDATE orders SET status = 'QUEUED', public_job_code = 'PG-UNREC1', pickup_code = 'PA-777',
         paid_at_ms = ?, queued_at_ms = ?, updated_at_ms = ?
       WHERE id = ?`,
    ).run(
      currentSimulatedTime,
      currentSimulatedTime,
      currentSimulatedTime,
      orderId,
    );

    db.prepare(
      `INSERT INTO payments (id, order_id, provider, provider_order_id, provider_payment_id, amount_paise, currency, status, created_at_ms, updated_at_ms, verified_at_ms)
       VALUES (?, ?, 'RAZORPAY', ?, ?, 1000, 'INR', 'DUPLICATE_CAPTURED', ?, ?, ?)`,
    ).run(
      paymentId,
      orderId,
      providerOrderId,
      providerPaymentId,
      currentSimulatedTime,
      currentSimulatedTime,
      currentSimulatedTime,
    );

    // Agent polls for print jobs: MUST return 0 claimed jobs because status is DUPLICATE_CAPTURED!
    const claimedJobs = await printingRepo.claimOrRenewAll(
      AGENT_ID,
      currentSimulatedTime + 5000,
    );
    expect(claimedJobs).toHaveLength(0);
  });

  it("PHASE 7 INVARIANT: Genuine duplicate charge (Cash confirmed first, then online captures) safely marks online payment DUPLICATE_CAPTURED", async () => {
    const { orderId } = await createDraftWithUploadedFile();

    const cashPaymentId = crypto.randomUUID();
    const onlinePaymentId = crypto.randomUUID();

    // 1. Admin confirms Cash first
    db.prepare(
      `INSERT INTO payments (id, order_id, provider, provider_order_id, provider_payment_id, amount_paise, currency, status, created_at_ms, updated_at_ms, verified_at_ms)
       VALUES (?, ?, 'CASH', 'cash_ord_1', 'cash_pay_1', 1000, 'INR', 'PAID', ?, ?, ?)`,
    ).run(
      cashPaymentId,
      orderId,
      currentSimulatedTime,
      currentSimulatedTime,
      currentSimulatedTime,
    );

    db.prepare(
      `UPDATE orders SET status = 'QUEUED', public_job_code = 'PG-CASH01', pickup_code = 'PA-CASH',
         paid_at_ms = ?, queued_at_ms = ?, updated_at_ms = ?
       WHERE id = ?`,
    ).run(
      currentSimulatedTime,
      currentSimulatedTime,
      currentSimulatedTime,
      orderId,
    );

    // 2. Online payment row was CREATED/PENDING
    db.prepare(
      `INSERT INTO payments (id, order_id, provider, provider_order_id, provider_payment_id, amount_paise, currency, status, created_at_ms, updated_at_ms)
       VALUES (?, ?, 'RAZORPAY', 'order_rzp_race_genuine', NULL, 1000, 'INR', 'PENDING', ?, ?)`,
    ).run(onlinePaymentId, orderId, currentSimulatedTime, currentSimulatedTime);

    // 3. Online payment finalizes concurrently
    const finalizedOnline = await paymentRepo.finalizePaid({
      paymentId: onlinePaymentId,
      providerPaymentId: "pay_rzp_race_genuine",
      jobCode: "PG-ONLINE99",
      nowMs: currentSimulatedTime + 5000,
      actorType: "CUSTOMER",
    });

    // Invariant: genuine second payment on order MUST be DUPLICATE_CAPTURED
    expect(finalizedOnline.status).toBe("DUPLICATE_CAPTURED");

    // Cash payment must remain PAID
    const cashRow = db
      .prepare("SELECT status FROM payments WHERE id = ?")
      .get(cashPaymentId) as { status: string };
    expect(cashRow.status).toBe("PAID");

    // Duplicate captured event MUST be recorded
    const event = db
      .prepare(
        "SELECT event_type FROM order_events WHERE order_id = ? AND event_type = 'PAYMENT_DUPLICATE_CAPTURED'",
      )
      .get(orderId) as { event_type: string };
    expect(event.event_type).toBe("PAYMENT_DUPLICATE_CAPTURED");
  });

  it("MIGRATION 0032: Safely reconciles order PA-123 corrupted payment to PAID and enables agent claim, while ignoring genuine duplicates", async () => {
    // 1. Setup Order PA-123 (exact corrupted production state)
    const orderIdIncident = "8b0b0b38-df3f-4289-9af1-a43d55dec67b";
    const paymentIdIncident = "7f6aebb9-b9ad-482c-97f3-8c4ce4b0be14";
    const { orderId: order123 } = await createDraftWithUploadedFile(
      orderIdIncident,
      "token_for_pa_123_incident_test_1234567890123",
    );
    expect(order123).toBe(orderIdIncident);

    db.prepare(
      `UPDATE orders SET status = 'QUEUED', public_job_code = 'PG-87DX5G', pickup_code = 'PA-123',
         payment_method = 'ONLINE', is_priority = 1, paid_at_ms = 1791719209281, queued_at_ms = 1791719200000, updated_at_ms = 1791719209281
       WHERE id = ?`,
    ).run(orderIdIncident);

    db.prepare(
      `INSERT INTO payments (id, order_id, provider, provider_order_id, provider_payment_id, amount_paise, currency, status, created_at_ms, updated_at_ms, verified_at_ms)
       VALUES (?, ?, 'RAZORPAY', 'order_TmacBHq2TOE3Zl', 'pay_Tmacbq7KBPvhrh', 1000, 'INR', 'DUPLICATE_CAPTURED', 1791719209281, 1791719209603, 1791719209281)`,
    ).run(paymentIdIncident, orderIdIncident);

    // Record verified event as happened in production
    db.prepare(
      `INSERT INTO order_events (id, order_id, event_type, from_status, to_status, actor_type, details_json, created_at_ms)
       VALUES (?, ?, 'PAYMENT_VERIFIED', 'PAYMENT_PENDING', 'PAID', 'PAYMENT_PROVIDER', ?, 1791719209281)`,
    ).run(
      crypto.randomUUID(),
      orderIdIncident,
      JSON.stringify({ paymentId: paymentIdIncident }),
    );

    // 2. Setup a GENUINE duplicate payment on a DIFFERENT order (e.g. Cash + Online)
    const { orderId: cashOrderId } = await createDraftWithUploadedFile();
    const genuineDupPaymentId = crypto.randomUUID();
    const cashPaymentId = crypto.randomUUID();
    db.prepare(
      `UPDATE orders SET status = 'QUEUED', public_job_code = 'PG-GENUINE', pickup_code = 'PA-CASH2',
         payment_method = 'CASH', paid_at_ms = 1791719209281, queued_at_ms = 1791719209281
       WHERE id = ?`,
    ).run(cashOrderId);
    // Two payments: Cash (PAID) and Online (DUPLICATE_CAPTURED)
    db.prepare(
      `INSERT INTO payments (id, order_id, provider, provider_order_id, provider_payment_id, amount_paise, currency, status, created_at_ms, updated_at_ms, verified_at_ms)
       VALUES (?, ?, 'CASH', 'ord-c', 'pay-c', 1000, 'INR', 'PAID', 1791719209281, 1791719209281, 1791719209281)`,
    ).run(cashPaymentId, cashOrderId);
    db.prepare(
      `INSERT INTO payments (id, order_id, provider, provider_order_id, provider_payment_id, amount_paise, currency, status, created_at_ms, updated_at_ms, verified_at_ms)
       VALUES (?, ?, 'RAZORPAY', 'ord-rzp-dup', 'pay-rzp-dup', 1000, 'INR', 'DUPLICATE_CAPTURED', 1791719209281, 1791719209281, 1791719209281)`,
    ).run(genuineDupPaymentId, cashOrderId);

    // 3. Apply Migration 0032
    const migration0032Sql = readFileSync(
      "database/migrations/0032_reconcile_corrupted_webhook_payment.sql",
      "utf8",
    );
    db.exec(migration0032Sql);

    // 4. Verify PA-123 payment was restored to PAID
    const incidentPaymentRow = db
      .prepare("SELECT status FROM payments WHERE id = ?")
      .get(paymentIdIncident) as { status: string };
    expect(incidentPaymentRow.status).toBe("PAID");

    // 5. Verify the genuine duplicate charge on the Cash order was UNTOUCHED (remains DUPLICATE_CAPTURED!)
    const genuineDupRow = db
      .prepare("SELECT status FROM payments WHERE id = ?")
      .get(genuineDupPaymentId) as { status: string };
    expect(genuineDupRow.status).toBe("DUPLICATE_CAPTURED");

    // 6. Verify Agent claimOrRenewAll now successfully claims order PA-123 for printing!
    db.prepare("UPDATE agents SET last_heartbeat_at_ms = ? WHERE id = ?").run(
      1791719300000,
      AGENT_ID,
    );
    const claimedJobs = await printingRepo.claimOrRenewAll(
      AGENT_ID,
      1791719300000,
    );
    expect(claimedJobs.some((j) => j.orderId === orderIdIncident)).toBe(true);
  });
});
