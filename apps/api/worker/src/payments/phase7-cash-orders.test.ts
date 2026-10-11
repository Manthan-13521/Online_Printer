import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";

import { hashSessionToken } from "@printgo/auth";
import {
  CASH_MAX_PENDING_MS,
  CASH_PAYMENT_WINDOW_MS,
  FILE_SIZE_SERVICE_CHARGE_BANDS,
} from "@printgo/domain";
import { D1ConfigurationRepository } from "../config/repository.js";
import { D1CustomerRepository } from "../customer/repository.js";
import { CustomerError, CustomerService } from "../customer/service.js";
import { D1PaymentRepository } from "./repository.js";
import { PaymentService } from "./service.js";
import { D1PrintingRepository } from "../printing/repository.js";

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
    const result = this.db.prepare(this.sql).run(...this.bindings);
    const changes = Number(result.changes);
    this.metrics.changedRows += changes;
    return Promise.resolve({
      success: true,
      meta: { changes },
      results: [],
    } as unknown as D1Result);
  }
}

function createInstrumentedD1(
  db: DatabaseSync,
  metrics: QueryMetrics,
): D1Database {
  let batchLock: Promise<void> = Promise.resolve();
  return {
    prepare: (sql: string) =>
      new InstrumentedStatementWrapper(db, sql, metrics),
    async batch(statements: InstrumentedStatementWrapper[]) {
      const previous = batchLock;
      let release!: () => void;
      batchLock = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      db.exec("BEGIN");
      try {
        const results = [];
        for (const s of statements) {
          if (s.sql.trim().toUpperCase().startsWith("SELECT")) {
            results.push(await s.all());
          } else {
            results.push(await s.run());
          }
        }
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      } finally {
        release();
      }
    },
    exec: (sql: string) => {
      metrics.statements++;
      db.exec(sql);
      return Promise.resolve({ count: 1, duration: 0 });
    },
  } as unknown as D1Database;
}

describe("PRINTGO — PHASE 7 ACCEPTANCE TEST SUITE: CASH ORDERS & SMART PAYMENT UX", () => {
  let db: DatabaseSync;
  let d1: D1Database;
  let metrics: QueryMetrics;

  let configRepo: D1ConfigurationRepository;
  let customerRepo: D1CustomerRepository;
  let customerService: CustomerService;
  let paymentRepo: D1PaymentRepository;
  let printingRepo: D1PrintingRepository;

  const initialNowMs = 1_700_000_000_000;
  let currentSimulatedTime = initialNowMs;

  beforeEach(() => {
    currentSimulatedTime = initialNowMs;
    db = new DatabaseSync(":memory:");
    metrics = { statements: 0, returnedRows: 0, changedRows: 0 };

    const migrationDir = new URL(
      "../../../../../database/migrations",
      import.meta.url,
    );
    const files = readdirSync(migrationDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const file of files) {
      const sql = readFileSync(
        new URL(`../../../../../database/migrations/${file}`, import.meta.url),
        "utf8",
      );
      db.exec(sql);
    }

    d1 = createInstrumentedD1(db, metrics);
    configRepo = new D1ConfigurationRepository(d1);
    customerRepo = new D1CustomerRepository(d1);
    paymentRepo = new D1PaymentRepository(d1);
    printingRepo = new D1PrintingRepository(d1);

    customerService = new CustomerService(
      customerRepo,
      {
        createUploadAuthorization: () =>
          Promise.resolve({
            uploadUrl: "https://upload.test",
            method: "PUT",
            headers: {},
            requiredHeaders: {},
            expiresAt: new Date(currentSimulatedTime + 600000).toISOString(),
          }),
      },
      {
        head: () =>
          Promise.resolve({
            size: 1024,
            sizeBytes: 1024,
            etag: "test",
          } as unknown as R2Object),
        readPrefix: () => Promise.resolve(null),
        delete: () => Promise.resolve(),
      },
      () => currentSimulatedTime,
    );

    // Initial base configuration
    db.exec(`
      INSERT INTO installation (
        id, shop_name, contact_phone, address, customer_notice,
        online_printing_enabled, cash_orders_enabled, max_pdf_size_bytes, max_order_upload_bytes,
        identification_sheet_enabled, default_production_printer_id,
        created_at_ms, updated_at_ms
      ) VALUES (
        1, 'PrintGo Test Shop', '+919876543210', '123 Market St', 'Welcome',
        1, 0, 26214400, 104857600,
        0, NULL,
        ${initialNowMs}, ${initialNowMs}
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
          ).run(id, paperSize, colorMode, sides, initialNowMs, initialNowMs);
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
        initialNowMs,
        initialNowMs,
      );
    });
  });

  async function createDraftWithFile(
    orderId = "10000000-0000-4000-8000-000000000001",
    rawToken = "token_test_1234567890123456789012345678901234567",
  ) {
    const tokenHash = await hashSessionToken(rawToken);
    const uploadId = "20000000-0000-4000-8000-000000000001";
    const fileId = "30000000-0000-4000-8000-000000000001";

    db.exec(`
      INSERT INTO orders (
        id, customer_name, customer_phone, original_filename, instructions, status,
        source_page_count, selected_pages, copies, paper_size, color_mode, sides,
        printing_amount_paise, service_charge_paise, total_amount_paise, currency,
        draft_token_hash, draft_expires_at_ms, cleanup_state, created_at_ms, updated_at_ms
      ) VALUES (
        '${orderId}', 'Rohan Sharma', '+919999988888', 'document.pdf', 'Urgent print', 'UPLOADED',
        5, '1-5', 1, 'A4', 'BW', 'SINGLE',
        1000, 0, 1000, 'INR',
        '${tokenHash}', ${currentSimulatedTime + 600000}, 'ACTIVE', ${currentSimulatedTime}, ${currentSimulatedTime}
      );

      INSERT INTO uploads (
        id, order_id, r2_object_key, original_filename, mime_type, expected_size_bytes, size_bytes,
        storage_status, retention_reason, delete_after_ms, created_at_ms, uploaded_at_ms, updated_at_ms
      ) VALUES (
        '${uploadId}', '${orderId}', 'uploads/test.pdf', 'document.pdf', 'application/pdf', 50000, 50000,
        'UPLOADED', 'UNPAID', ${currentSimulatedTime + 600000}, ${currentSimulatedTime}, ${currentSimulatedTime}, ${currentSimulatedTime}
      );

      INSERT INTO order_files (
        id, order_id, position, r2_object_key, original_filename,
        expected_size_bytes, size_bytes, source_page_count, selected_pages, selected_page_count,
        copies, paper_size, color_mode, sides, printing_amount_paise, service_charge_paise,
        upload_status, print_status, uploaded_at_ms, created_at_ms, updated_at_ms
      ) VALUES (
        '${fileId}', '${orderId}', 1, 'uploads/test.pdf', 'document.pdf',
        50000, 50000, 5, '1-5', 5,
        1, 'A4', 'BW', 'SINGLE', 1000, 0,
        'UPLOADED', 'PENDING', ${currentSimulatedTime}, ${currentSimulatedTime}, ${currentSimulatedTime}
      );
    `);

    return { orderId, rawToken, tokenHash };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 1: Toggle OFF by default & Direct API request rejection
  // ──────────────────────────────────────────────────────────────────────────
  it("Scenario 1: cash_orders_enabled is OFF by default and rejects customer selectCashPayment with 403 CASH_ORDERS_DISABLED", async () => {
    const config = await customerRepo.getPublicConfig();
    expect(config).not.toBeNull();
    expect(config?.cashOrdersEnabled).toBe(false);

    const { rawToken } = await createDraftWithFile();

    await expect(
      customerService.selectCashPayment(rawToken),
    ).rejects.toThrowError(new CustomerError("CASH_ORDERS_DISABLED"));
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 2: Toggle ON via Shop Settings
  // ──────────────────────────────────────────────────────────────────────────
  it("Scenario 2: Admin can toggle cash_orders_enabled ON via settings update", async () => {
    const settings = await configRepo.getSettings();
    expect(settings).not.toBeNull();
    expect(settings?.cashOrdersEnabled).toBe(false);

    await configRepo.updateSettings({
      settings: { ...settings!, cashOrdersEnabled: true },
      previousOnlinePrintingEnabled: true,
      adminId: "admin-1",
      nowMs: currentSimulatedTime,
    });

    const updatedConfig = await customerRepo.getPublicConfig();
    expect(updatedConfig?.cashOrdersEnabled).toBe(true);

    const updatedSettings = await configRepo.getSettings();
    expect(updatedSettings?.cashOrdersEnabled).toBe(true);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 3: Toggling OFF does not cancel existing pending cash orders
  // ──────────────────────────────────────────────────────────────────────────
  it("Scenario 3: Toggling cash_orders_enabled OFF does not cancel existing pending cash orders", async () => {
    // 1. Turn ON
    const settings = await configRepo.getSettings();
    await configRepo.updateSettings({
      settings: { ...settings!, cashOrdersEnabled: true },
      previousOnlinePrintingEnabled: true,
      adminId: "admin-1",
      nowMs: currentSimulatedTime,
    });

    // 2. Customer selects cash
    const { orderId, rawToken } = await createDraftWithFile();
    const cashSelection = await customerService.selectCashPayment(rawToken);
    expect(cashSelection.orderId).toBe(orderId);

    // 3. Admin turns toggle OFF
    await configRepo.updateSettings({
      settings: { ...settings!, cashOrdersEnabled: false },
      previousOnlinePrintingEnabled: true,
      adminId: "admin-1",
      nowMs: currentSimulatedTime + 1000,
    });

    // 4. Verify existing cash order is STILL actionable and visible to admin
    const pendingCash = await paymentRepo.listPendingCashOrders(
      currentSimulatedTime + 2000,
    );
    expect(pendingCash).toHaveLength(1);
    expect(pendingCash[0]?.orderId).toBe(orderId);

    // 5. Admin can confirm it even when toggle is now OFF
    const confirmed = await paymentRepo.confirmCashPayment({
      orderId,
      adminId: "admin-1",
      nowMs: currentSimulatedTime + 3000,
    });
    expect(confirmed.status).toBe("QUEUED");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 4: Cash selection sets timestamps, draft expiry, and upload retention
  // ──────────────────────────────────────────────────────────────────────────
  it("Scenario 4: Customer selecting cash sets 10m client window, 12m grace window, and extends draft/upload retention to 12m", async () => {
    const settings = await configRepo.getSettings();
    await configRepo.updateSettings({
      settings: { ...settings!, cashOrdersEnabled: true },
      previousOnlinePrintingEnabled: true,
      adminId: "admin-1",
      nowMs: currentSimulatedTime,
    });

    const { orderId, rawToken } = await createDraftWithFile();
    const cashSelection = await customerService.selectCashPayment(rawToken);

    expect(cashSelection.cashExpiresAtMs).toBe(
      currentSimulatedTime + CASH_PAYMENT_WINDOW_MS,
    );
    expect(cashSelection.cashGraceUntilMs).toBe(
      currentSimulatedTime + CASH_MAX_PENDING_MS,
    );

    // Inspect database state
    const orderRow = db
      .prepare(
        "SELECT payment_method, status, cash_selected_at_ms, cash_expires_at_ms, cash_grace_until_ms, draft_expires_at_ms FROM orders WHERE id = ?",
      )
      .get(orderId) as Record<string, unknown>;
    expect(orderRow.payment_method).toBe("CASH");
    expect(orderRow.status).toBe("PAYMENT_PENDING");
    expect(orderRow.cash_selected_at_ms).toBe(currentSimulatedTime);
    expect(orderRow.cash_expires_at_ms).toBe(
      currentSimulatedTime + CASH_PAYMENT_WINDOW_MS,
    );
    expect(orderRow.cash_grace_until_ms).toBe(
      currentSimulatedTime + CASH_MAX_PENDING_MS,
    );
    expect(orderRow.draft_expires_at_ms).toBe(
      currentSimulatedTime + CASH_MAX_PENDING_MS,
    );

    const uploadRow = db
      .prepare("SELECT delete_after_ms FROM uploads WHERE order_id = ?")
      .get(orderId) as Record<string, unknown>;
    expect(uploadRow.delete_after_ms).toBe(
      currentSimulatedTime + CASH_MAX_PENDING_MS,
    );

    // Inspect order event
    const event = db
      .prepare(
        "SELECT event_type, from_status, to_status FROM order_events WHERE order_id = ? AND event_type = 'CASH_PAYMENT_SELECTED'",
      )
      .get(orderId) as Record<string, unknown>;
    expect(event).not.toBeNull();
    expect(event.from_status).toBe("UPLOADED");
    expect(event.to_status).toBe("PAYMENT_PENDING");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 5: Customer draft status endpoint
  // ──────────────────────────────────────────────────────────────────────────
  it("Scenario 5: Customer getDraftStatus returns live status, timestamps, and order references", async () => {
    const settings = await configRepo.getSettings();
    await configRepo.updateSettings({
      settings: { ...settings!, cashOrdersEnabled: true },
      previousOnlinePrintingEnabled: true,
      adminId: "admin-1",
      nowMs: currentSimulatedTime,
    });

    const { orderId, rawToken } = await createDraftWithFile();
    await customerService.selectCashPayment(rawToken);

    const status = await customerService.getDraftStatus(rawToken);
    expect(status.orderId).toBe(orderId);
    expect(status.status).toBe("PAYMENT_PENDING");
    expect(status.paymentMethod).toBe("CASH");
    expect(status.cashExpiresAtMs).toBe(
      currentSimulatedTime + CASH_PAYMENT_WINDOW_MS,
    );
    expect(status.cashGraceUntilMs).toBe(
      currentSimulatedTime + CASH_MAX_PENDING_MS,
    );
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 6: Admin confirms cash received
  // ──────────────────────────────────────────────────────────────────────────
  it("Scenario 6: Admin confirms cash received; order queues, payment record created, and audit log emitted", async () => {
    const settings = await configRepo.getSettings();
    await configRepo.updateSettings({
      settings: { ...settings!, cashOrdersEnabled: true },
      previousOnlinePrintingEnabled: true,
      adminId: "admin-1",
      nowMs: currentSimulatedTime,
    });

    const { orderId, rawToken } = await createDraftWithFile();
    await customerService.selectCashPayment(rawToken);

    const confirmTime = currentSimulatedTime + 5 * 60 * 1000; // 5 mins in
    const confirmed = await paymentRepo.confirmCashPayment({
      orderId,
      adminId: "admin-user-42",
      nowMs: confirmTime,
    });

    expect(confirmed.orderId).toBe(orderId);
    expect(confirmed.status).toBe("QUEUED");
    expect(confirmed.publicJobCode).toMatch(/^(PG-[A-Z0-9]{6}|CASH-\d{3,5})$/);

    // Verify order in D1
    const order = db
      .prepare(
        "SELECT status, public_job_code, pickup_code, cash_confirmed_at_ms, cash_confirmed_by_admin_id FROM orders WHERE id = ?",
      )
      .get(orderId) as Record<string, unknown>;
    expect(order.status).toBe("QUEUED");
    expect(order.cash_confirmed_at_ms).toBe(confirmTime);
    expect(order.cash_confirmed_by_admin_id).toBe("admin-user-42");

    // Verify payments row
    const payment = db
      .prepare(
        "SELECT provider, status, amount_paise FROM payments WHERE order_id = ?",
      )
      .get(orderId) as Record<string, unknown>;
    expect(payment.provider).toBe("CASH");
    expect(payment.status).toBe("PAID");
    expect(payment.amount_paise).toBe(1000);

    // Verify audit log
    const audit = db
      .prepare(
        "SELECT action, actor_id, entity_id FROM audit_logs WHERE action = 'CONFIRM_CASH_PAYMENT'",
      )
      .get() as Record<string, unknown>;
    expect(audit.actor_id).toBe("admin-user-42");
    expect(audit.entity_id).toBe(orderId);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 7: Admin Grace Period (between 10m and 12m)
  // ──────────────────────────────────────────────────────────────────────────
  it("Scenario 7: Order in 2-minute Grace Period (11 minutes elapsed) is still actionable and confirmable", async () => {
    const settings = await configRepo.getSettings();
    await configRepo.updateSettings({
      settings: { ...settings!, cashOrdersEnabled: true },
      previousOnlinePrintingEnabled: true,
      adminId: "admin-1",
      nowMs: currentSimulatedTime,
    });

    const { orderId, rawToken } = await createDraftWithFile();
    await customerService.selectCashPayment(rawToken);

    // 11 minutes elapsed (past 10m client countdown, inside 2m grace period)
    const graceTime = currentSimulatedTime + 11 * 60 * 1000;
    const pendingOrders = await paymentRepo.listPendingCashOrders(graceTime);
    expect(pendingOrders).toHaveLength(1);
    expect(pendingOrders[0]?.orderId).toBe(orderId);

    const confirmed = await paymentRepo.confirmCashPayment({
      orderId,
      adminId: "admin-grace-tester",
      nowMs: graceTime,
    });
    expect(confirmed.status).toBe("QUEUED");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 8: Strict 12-minute Expiry Boundary
  // ──────────────────────────────────────────────────────────────────────────
  it("Scenario 8: After strict 12-minute window expires, order is excluded from actionable list and rejected on confirmation", async () => {
    const settings = await configRepo.getSettings();
    await configRepo.updateSettings({
      settings: { ...settings!, cashOrdersEnabled: true },
      previousOnlinePrintingEnabled: true,
      adminId: "admin-1",
      nowMs: currentSimulatedTime,
    });

    const { orderId, rawToken } = await createDraftWithFile();
    await customerService.selectCashPayment(rawToken);

    // Exactly 12 minutes and 1 millisecond
    const expiredTime = currentSimulatedTime + 12 * 60 * 1000 + 1;

    const pendingOrders = await paymentRepo.listPendingCashOrders(expiredTime);
    expect(pendingOrders).toHaveLength(0); // Excluded from actionable list!

    await expect(
      paymentRepo.confirmCashPayment({
        orderId,
        adminId: "admin-late",
        nowMs: expiredTime,
      }),
    ).rejects.toThrowError("CASH_ORDER_EXPIRED");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 9: Customer switches to Pay Online Instead
  // ──────────────────────────────────────────────────────────────────────────
  it("Scenario 9: Customer selects cash, then switches to Pay Online using the exact same order and files", async () => {
    const settings = await configRepo.getSettings();
    await configRepo.updateSettings({
      settings: { ...settings!, cashOrdersEnabled: true },
      previousOnlinePrintingEnabled: true,
      adminId: "admin-1",
      nowMs: currentSimulatedTime,
    });

    const { orderId, rawToken } = await createDraftWithFile();
    await customerService.selectCashPayment(rawToken);

    // Order is currently in PAYMENT_PENDING with payment_method = 'CASH'
    const draftBefore = await customerService.getDraft(rawToken);
    expect(draftBefore.paymentMethod).toBe("CASH");

    // Customer decides to pay online instead
    // Payment service creates checkout
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
            id: "order_rzp_online_999",
            amount: 1000,
            currency: "INR",
            status: "created",
          }),
        fetchPayment: () =>
          Promise.resolve({
            id: "pay_rzp_online_999",
            orderId: "order_rzp_online_999",
            amount: 1000,
            currency: "INR",
            status: "captured",
          }),
      },
      { keyId: "rzp_test_key", keySecret: "rzp_test_secret" },
      {
        attachToVerifiedOrder: (_orderId: string, rawTrackingToken: string) =>
          Promise.resolve({
            rawToken: rawTrackingToken,
            expiresAt: new Date(currentSimulatedTime + 86400000).toISOString(),
          }),
      },
      () => currentSimulatedTime + 60000,
    );

    const checkout = await paymentService.createCheckout(rawToken, 1000);
    expect(checkout.status).toBe("CHECKOUT_READY");
    if (checkout.status === "CHECKOUT_READY") {
      expect(checkout.razorpayOrderId).toBe("order_rzp_online_999");
    }

    // Customer completes online payment
    const verified = await paymentService.verify(rawToken, {
      razorpayOrderId: "order_rzp_online_999",
      razorpayPaymentId: "pay_rzp_online_999",
      razorpaySignature:
        "92441c449008ec49444c2f94812d847357f38f5e0e38b64474e572dcafab13de", // HMAC-SHA256 of "order_rzp_online_999|pay_rzp_online_999" with "rzp_test_secret"
      trackingToken: "track_token_test_abc",
    });

    expect(verified.status).toBe("QUEUED");
    expect(verified.jobCode).toMatch(/^(PG-[A-Z0-9]{6}|CASH-\d{3,5})$/);

    const orderRow = db
      .prepare("SELECT status FROM orders WHERE id = ?")
      .get(orderId) as Record<string, unknown>;
    expect(orderRow.status).toBe("QUEUED");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 10: Cash vs Online Race — Admin Confirms Cash First (Online is DUPLICATE_CAPTURED)
  // ──────────────────────────────────────────────────────────────────────────
  it("Scenario 10: When Admin confirms cash first and online payment captures concurrently, online payment is safely marked DUPLICATE_CAPTURED without double queuing", async () => {
    const settings = await configRepo.getSettings();
    await configRepo.updateSettings({
      settings: { ...settings!, cashOrdersEnabled: true },
      previousOnlinePrintingEnabled: true,
      adminId: "admin-1",
      nowMs: currentSimulatedTime,
    });

    const { orderId, rawToken } = await createDraftWithFile();
    await customerService.selectCashPayment(rawToken);

    // Customer opens checkout online
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
            id: "order_rzp_race_10",
            amount: 1000,
            currency: "INR",
            status: "created",
          }),
        fetchPayment: () =>
          Promise.resolve({
            id: "pay_rzp_race_10",
            orderId: "order_rzp_race_10",
            amount: 1000,
            currency: "INR",
            status: "captured",
          }),
      },
      { keyId: "rzp_test_key", keySecret: "rzp_test_secret" },
      {
        attachToVerifiedOrder: (_orderId: string, rawTrackingToken: string) =>
          Promise.resolve({
            rawToken: rawTrackingToken,
            expiresAt: new Date(currentSimulatedTime + 86400000).toISOString(),
          }),
      },
      () => currentSimulatedTime + 60000,
    );

    await paymentService.createCheckout(rawToken, 1000);

    // 1. Admin confirms CASH FIRST
    const cashConfirmed = await paymentRepo.confirmCashPayment({
      orderId,
      adminId: "admin-speedy",
      nowMs: currentSimulatedTime + 70000,
    });
    expect(cashConfirmed.status).toBe("QUEUED");

    // 2. Online verification arrives right after
    const onlinePaymentRecord =
      await paymentRepo.findPaymentByProviderOrderId("order_rzp_race_10");
    expect(onlinePaymentRecord).not.toBeNull();

    const finalized = await paymentRepo.finalizePaid({
      paymentId: onlinePaymentRecord!.id,
      providerPaymentId: "pay_rzp_race_10",
      jobCode: "PG-ONLINE1",
      nowMs: currentSimulatedTime + 75000,
      actorType: "CUSTOMER",
    });

    // 3. Must be safely recorded as DUPLICATE_CAPTURED
    expect(finalized.status).toBe("DUPLICATE_CAPTURED");

    // Check payments table
    const payments = db
      .prepare(
        "SELECT provider, status FROM payments WHERE order_id = ? ORDER BY created_at_ms ASC",
      )
      .all(orderId) as Array<Record<string, unknown>>;
    expect(payments).toHaveLength(2);
    expect(payments[0]?.provider).toBe("RAZORPAY");
    expect(payments[0]?.status).toBe("DUPLICATE_CAPTURED");
    expect(payments[1]?.provider).toBe("CASH");
    expect(payments[1]?.status).toBe("PAID");

    // Check order event
    const duplicateEvent = db
      .prepare(
        "SELECT event_type FROM order_events WHERE order_id = ? AND event_type = 'PAYMENT_DUPLICATE_CAPTURED'",
      )
      .get(orderId) as Record<string, unknown>;
    expect(duplicateEvent).not.toBeNull();

    // Verify order remained QUEUED with the cash job code, not overridden
    const orderFinal = db
      .prepare("SELECT status, public_job_code FROM orders WHERE id = ?")
      .get(orderId) as Record<string, unknown>;
    expect(orderFinal.status).toBe("QUEUED");
    expect(orderFinal.public_job_code).toBe(cashConfirmed.publicJobCode);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 11: Online vs Cash Race — Online Wins First (Admin Cash Rejected)
  // ──────────────────────────────────────────────────────────────────────────
  it("Scenario 11: When online payment wins first, Admin attempting to confirm cash is rejected with ALREADY_PAID_ONLINE", async () => {
    const settings = await configRepo.getSettings();
    await configRepo.updateSettings({
      settings: { ...settings!, cashOrdersEnabled: true },
      previousOnlinePrintingEnabled: true,
      adminId: "admin-1",
      nowMs: currentSimulatedTime,
    });

    const { orderId, rawToken } = await createDraftWithFile();
    await customerService.selectCashPayment(rawToken);

    // 1. Online payment finalizes first
    const paymentId = "40000000-0000-4000-8000-000000000001";
    db.exec(`
      INSERT INTO payments (
        id, order_id, provider, provider_order_id, provider_payment_id,
        amount_paise, currency, status, verified_at_ms, created_at_ms, updated_at_ms
      ) VALUES (
        '${paymentId}', '${orderId}', 'RAZORPAY', 'order_rzp_first_11', 'pay_rzp_first_11',
        1000, 'INR', 'CREATED', NULL, ${currentSimulatedTime}, ${currentSimulatedTime}
      );
    `);

    await paymentRepo.finalizePaid({
      paymentId,
      providerPaymentId: "pay_rzp_first_11",
      jobCode: "PG-ONLINEWIN",
      nowMs: currentSimulatedTime + 30000,
      actorType: "CUSTOMER",
    });

    // 2. Admin now clicks "Confirm Cash Received"
    await expect(
      paymentRepo.confirmCashPayment({
        orderId,
        adminId: "admin-too-late",
        nowMs: currentSimulatedTime + 40000,
      }),
    ).rejects.toThrowError("ALREADY_PAID_ONLINE");

    // Verify only 1 payment row exists and it is the online payment
    const paymentRows = db
      .prepare("SELECT provider, status FROM payments WHERE order_id = ?")
      .all(orderId) as Array<Record<string, unknown>>;
    expect(paymentRows).toHaveLength(1);
    expect(paymentRows[0]?.provider).toBe("RAZORPAY");
    expect(paymentRows[0]?.status).toBe("PAID");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 12: Dual Admin Confirmation Race
  // ──────────────────────────────────────────────────────────────────────────
  it("Scenario 12: Simultaneous dual admin confirmation results in exactly one winner", async () => {
    const settings = await configRepo.getSettings();
    await configRepo.updateSettings({
      settings: { ...settings!, cashOrdersEnabled: true },
      previousOnlinePrintingEnabled: true,
      adminId: "admin-1",
      nowMs: currentSimulatedTime,
    });

    const { orderId, rawToken } = await createDraftWithFile();
    await customerService.selectCashPayment(rawToken);

    // Admin 1 confirms
    const winner = await paymentRepo.confirmCashPayment({
      orderId,
      adminId: "admin-tab-1",
      nowMs: currentSimulatedTime + 10000,
    });
    expect(winner.status).toBe("QUEUED");

    // Admin 2 confirms concurrently
    await expect(
      paymentRepo.confirmCashPayment({
        orderId,
        adminId: "admin-tab-2",
        nowMs: currentSimulatedTime + 10000,
      }),
    ).rejects.toThrowError("ORDER_NOT_ELIGIBLE");

    // Exactly 1 cash payment recorded
    const payments = db
      .prepare(
        "SELECT id FROM payments WHERE order_id = ? AND provider = 'CASH'",
      )
      .all(orderId);
    expect(payments).toHaveLength(1);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 13: Single Paid-Print Pipeline Parity
  // ──────────────────────────────────────────────────────────────────────────
  it("Scenario 13: Cash-confirmed orders enter the exact same print claiming queue and route to printers identically", async () => {
    const settings = await configRepo.getSettings();
    await configRepo.updateSettings({
      settings: { ...settings!, cashOrdersEnabled: true },
      previousOnlinePrintingEnabled: true,
      adminId: "admin-1",
      nowMs: currentSimulatedTime,
    });

    const agentId = "40000000-0000-4000-8000-000000000001";
    const printerId = "50000000-0000-4000-8000-000000000001";

    // Register agent
    db.exec(`
      INSERT INTO agents (
        id, display_name, credential_hash, is_active, paired_at_ms,
        last_heartbeat_at_ms, created_at_ms, updated_at_ms
      ) VALUES (
        '${agentId}', 'Shop Agent', 'hash-test', 1, ${initialNowMs},
        ${initialNowMs + 100000}, ${initialNowMs}, ${initialNowMs}
      );
    `);

    // Register active printer
    db.exec(`
      INSERT INTO printers (
        id, agent_id, display_name, windows_printer_name, enabled, status,
        is_production_eligible, is_virtual, priority,
        capabilities_json, verified_capabilities_json, enabled_services_json,
        last_status_at_ms, created_at_ms, updated_at_ms
      ) VALUES (
        '${printerId}', '${agentId}', 'Front Counter Laser', 'HP_Laser_136w', 1, 'ONLINE',
        1, 0, 10,
        '{"colour":false,"duplex":true,"paperSizes":["A4"]}',
        '{"verified":{"bw":1,"color":0,"duplex":1,"a4":1,"a3":0}}',
        '{"bw":1,"color":0,"duplex":1,"a4":1,"a3":0}',
        ${initialNowMs}, ${initialNowMs}, ${initialNowMs}
      );
    `);

    const { orderId, rawToken } = await createDraftWithFile();
    await customerService.selectCashPayment(rawToken);

    // Admin confirms cash
    await paymentRepo.confirmCashPayment({
      orderId,
      adminId: "admin-counter",
      nowMs: currentSimulatedTime + 20000,
    });

    // Agent queries next print job via printing repository
    const claim = await printingRepo.claimOrRenew(
      agentId,
      currentSimulatedTime + 25000,
    );

    expect(claim).not.toBeNull();
    expect(claim?.orderId).toBe(orderId);
    expect(claim?.printerId).toBe(printerId);
    expect(claim?.copies).toBe(1);
    expect(claim?.paperSize).toBe("A4");
    expect(claim?.colorMode).toBe("BW");
  });

  it("Scenario 14: CASH-123 reference code format, reuse on repeat selection, and collision avoidance", async () => {
    const settings = await configRepo.getSettings();
    await configRepo.updateSettings({
      settings: { ...settings!, cashOrdersEnabled: true },
      previousOnlinePrintingEnabled: true,
      adminId: "admin-1",
      nowMs: currentSimulatedTime,
    });

    const { orderId, rawToken } = await createDraftWithFile();
    const result = await customerService.selectCashPayment(rawToken);

    // 1. Must match CASH- followed by 3-5 digits
    expect(result.publicJobCode).toMatch(/^CASH-\d{3,5}$/);

    // 2. Calling selectCashPayment again must reuse the same CASH- reference
    const repeatResult = await customerService.selectCashPayment(rawToken);
    expect(repeatResult.publicJobCode).toBe(result.publicJobCode);

    // 3. Verify order in D1
    const order = db
      .prepare("SELECT public_job_code FROM orders WHERE id = ?")
      .get(orderId) as { public_job_code: string };
    expect(order.public_job_code).toBe(result.publicJobCode);
  });
});
