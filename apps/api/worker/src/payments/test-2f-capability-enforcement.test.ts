import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it, vi, beforeEach } from "vitest";

/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- Test file inspecting mock methods and Response json bodies */

import type { CustomerActions } from "../customer/routes.js";
import { handleCustomerRequest } from "../customer/routes.js";
import { CustomerService } from "../customer/service.js";
import { D1CustomerRepository } from "../customer/repository.js";
import type { UploadSigner } from "../storage/r2-upload-signer.js";
import type { WorkerEnv } from "../env.js";
import type { PrivateObjectStore } from "../storage/r2-verification.js";
import { TrackingService } from "../tracking/service.js";
import { D1TrackingRepository } from "../tracking/repository.js";
import { D1PaymentRepository } from "./repository.js";
import { D1PaymentReadiness } from "./readiness.js";
import { PaymentService } from "./service.js";
import type { RazorpayClient, RazorpayOrder } from "./razorpay.js";
import { D1PrintingRepository } from "../printing/repository.js";
import {
  validateAndNormalizePrintSettings,
  UnsupportedPrintSettingError,
} from "../../../../agent/windows/src/printing/print-settings.js";

// Database Statement wrapper for node:sqlite DatabaseSync to match Cloudflare D1
class StatementWrapper {
  private bindings: SQLInputValue[] = [];
  constructor(
    private readonly db: DatabaseSync,
    readonly sql: string,
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
    const row = this.db.prepare(this.sql).get(...this.bindings) as
      T | undefined;
    return Promise.resolve(row ?? null);
  }

  all<T>(): Promise<D1Result<T>> {
    const results = this.db.prepare(this.sql).all(...this.bindings) as T[];
    return Promise.resolve({
      success: true,
      meta: { changes: 0 },
      results,
    } as unknown as D1Result<T>);
  }

  run(): Promise<D1Result> {
    const result = this.db.prepare(this.sql).run(...this.bindings);
    return Promise.resolve({
      success: true,
      meta: { changes: Number(result.changes) },
      results: [],
    } as unknown as D1Result);
  }
}

function asD1(db: DatabaseSync): D1Database {
  let batchLock: Promise<void> = Promise.resolve();
  return {
    prepare: (sql: string) => new StatementWrapper(db, sql),
    async batch(statements: StatementWrapper[]) {
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
  } as unknown as D1Database;
}

const ids = {
  agent: "40000000-0000-4000-8000-000000000001",
  printerHp: "50000000-0000-4000-8000-000000000001",
  order: "10000000-0000-4000-8000-000000000001",
  file1: "20000000-0000-4000-8000-000000000001",
};

describe("TEST 2F: Server-Side Printer Capability Enforcement", () => {
  let db: DatabaseSync;
  let d1: D1Database;
  let customerRepo: D1CustomerRepository;
  let paymentRepo: D1PaymentRepository;
  let trackingRepo: D1TrackingRepository;
  let printRepo: D1PrintingRepository;
  let readiness: D1PaymentReadiness;
  let paymentService: PaymentService;
  let customerService: CustomerService;
  let customActions: CustomerActions;
  let mockRazorpayClient: RazorpayClient;
  let mockObjectStore: PrivateObjectStore;
  let mockSigner: UploadSigner;

  const origin = "https://printgo.shop.test";
  const nowMs = 1_700_000_000_000;
  const validPdfBytes = new TextEncoder().encode(
    "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF",
  );

  const env: WorkerEnv = {
    APP_ENV: "production",
    CUSTOMER_ALLOWED_ORIGIN: origin,
    PAYMENT_READINESS_DEV_BYPASS: "false",
    RAZORPAY_KEY_ID: "rzp_test_key_isolated",
    RAZORPAY_KEY_SECRET: "test_secret_isolated_1234567890",
  } as unknown as WorkerEnv;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    // Apply all 28 migrations dynamically in order
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

    d1 = asD1(db);

    // 1. Seed installation: online printing enabled, single default printer = HP LaserJet
    db.prepare(
      `INSERT INTO installation (
        id, app_name, shop_name, contact_phone, address, customer_notice,
        online_printing_enabled, default_production_printer_id,
        max_pdf_size_bytes, max_order_upload_bytes,
        identification_sheet_enabled, identification_sheet_placement,
        created_at_ms, updated_at_ms
      ) VALUES (1, 'PrintGo', 'PrintGo HP Test Shop', '+919876543210', 'Shop 12', 'Test Mode', 1, ?, 26214400, 52428800, 0, 'LAST', ?, ?)`,
    ).run(ids.printerHp, nowMs, nowMs);

    // 2. Seed active Agent with fresh heartbeat
    db.prepare(
      `INSERT INTO agents (
        id, display_name, credential_hash, is_active, paired_at_ms,
        last_heartbeat_at_ms, created_at_ms, updated_at_ms
      ) VALUES (?, 'HP Windows Agent', 'hash-test', 1, ?, ?, ?, ?)`,
    ).run(ids.agent, nowMs, nowMs, nowMs, nowMs);

    // 3. Seed ONLY ONE printer: Real HP Laser MFP hardware profile
    // SUPPORTS ONLY: A4, B&W, Single-sided
    // REJECTS: Color (false), Duplex (false), A3 (false)
    db.prepare(
      `INSERT INTO printers (
        id, agent_id, display_name, windows_printer_name, enabled, status,
        is_production_eligible, is_virtual, auto_fallback_enabled, fallback_printer_id, priority,
        capabilities_json, verified_capabilities_json, enabled_services_json,
        last_status_at_ms, created_at_ms, updated_at_ms
      ) VALUES (?, ?, 'HP Laser MFP 136w', 'HP Laser MFP 136w', 1, 'ONLINE', 1, 0, 0, NULL, 100, ?, ?, ?, ?, ?, ?)`,
    ).run(
      ids.printerHp,
      ids.agent,
      JSON.stringify({ colour: false, duplex: false, paperSizes: ["A4"] }),
      JSON.stringify({
        verified: {
          bw: true,
          color: false,
          duplex: false,
          a4: true,
          a3: false,
        },
        enabled: { bw: true, color: false, duplex: false, a4: true, a3: false },
        requiresReview: false,
      }),
      JSON.stringify({
        bw: true,
        color: false,
        duplex: false,
        a4: true,
        a3: false,
      }),
      nowMs,
      nowMs,
      nowMs,
    );

    // 4. Seed all 8 combinations of print rates so engine validation passes
    const rates = [
      {
        id: "10000000-0000-4000-8000-000000000001",
        size: "A4",
        color: "BW",
        sides: "SINGLE",
        price: 200,
      },
      {
        id: "10000000-0000-4000-8000-000000000002",
        size: "A4",
        color: "BW",
        sides: "DOUBLE",
        price: 300,
      },
      {
        id: "10000000-0000-4000-8000-000000000003",
        size: "A4",
        color: "COLOR",
        sides: "SINGLE",
        price: 1000,
      },
      {
        id: "10000000-0000-4000-8000-000000000004",
        size: "A4",
        color: "COLOR",
        sides: "DOUBLE",
        price: 1800,
      },
      {
        id: "10000000-0000-4000-8000-000000000005",
        size: "A3",
        color: "BW",
        sides: "SINGLE",
        price: 500,
      },
      {
        id: "10000000-0000-4000-8000-000000000006",
        size: "A3",
        color: "BW",
        sides: "DOUBLE",
        price: 800,
      },
      {
        id: "10000000-0000-4000-8000-000000000007",
        size: "A3",
        color: "COLOR",
        sides: "SINGLE",
        price: 2000,
      },
      {
        id: "10000000-0000-4000-8000-000000000008",
        size: "A3",
        color: "COLOR",
        sides: "DOUBLE",
        price: 3500,
      },
    ];
    for (const r of rates) {
      db.prepare(
        `INSERT INTO print_rates (id, paper_size, color_mode, sides, price_per_page_paise, enabled, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      ).run(r.id, r.size, r.color, r.sides, r.price, nowMs, nowMs);
    }

    // 5. Seed exact 4 file size service charge bands defined in domain
    const bands = [
      { min: 0, max: 2097152, sort: 1 },
      { min: 2097152, max: 5242880, sort: 2 },
      { min: 5242880, max: 10485760, sort: 3 },
      { min: 10485760, max: 26214400, sort: 4 },
    ];
    for (const b of bands) {
      db.prepare(
        `INSERT INTO file_size_service_charges (id, min_bytes_exclusive, max_bytes_inclusive, charge_paise, enabled, sort_order, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, 100, 1, ?, ?, ?)`,
      ).run(crypto.randomUUID(), b.min, b.max, b.sort, nowMs, nowMs);
    }

    // Mock storage & signer
    mockObjectStore = {
      head: vi.fn(() => Promise.resolve({ size: validPdfBytes.byteLength })),
      readPrefix: vi.fn(() =>
        Promise.resolve(validPdfBytes.buffer.slice(0, 1024) as ArrayBuffer),
      ),
      readSuffix: vi.fn(() =>
        Promise.resolve(validPdfBytes.buffer.slice(-2048) as ArrayBuffer),
      ),
      delete: vi.fn(() => Promise.resolve()),
    };
    mockSigner = {
      createUploadAuthorization: vi.fn((key: string) =>
        Promise.resolve({
          uploadUrl: `https://mock-r2.test/${key}`,
          expiresAt: "2026-10-10T12:00:00.000Z",
          requiredHeaders: {},
        }),
      ),
    };

    // Mock Razorpay provider
    mockRazorpayClient = {
      createOrder: vi.fn(
        (params: {
          amountPaise: number;
          currency: string;
          receipt: string;
        }): Promise<RazorpayOrder> => {
          return Promise.resolve({
            id: `order_mock_${Date.now()}`,
            amount: params.amountPaise,
            currency: "INR" as const,
            status: "created" as const,
            receipt: params.receipt,
          });
        },
      ),
      fetchPayment: vi.fn(),
    };

    customerRepo = new D1CustomerRepository(d1);
    paymentRepo = new D1PaymentRepository(d1);
    trackingRepo = new D1TrackingRepository(d1);
    printRepo = new D1PrintingRepository(d1);

    readiness = new D1PaymentReadiness(
      d1,
      { APP_ENV: "production", PAYMENT_READINESS_DEV_BYPASS: "false" },
      () => nowMs,
    );

    const trackingService = new TrackingService(trackingRepo);
    customerService = new CustomerService(
      customerRepo,
      mockSigner,
      mockObjectStore,
      () => nowMs,
    );

    paymentService = new PaymentService(
      paymentRepo,
      customerRepo,
      mockObjectStore,
      readiness,
      mockRazorpayClient,
      {
        keyId: "rzp_test_key_isolated",
        keySecret: "test_secret_isolated_1234567890",
      },
      trackingService,
      () => nowMs,
    );

    customActions = {
      getConfig: () => customerRepo.getPublicConfig(),
      createDraft: (input) => customerService.createDraft(input),
      authorizeUpload: (token, fileId) =>
        customerService.authorizeUpload(token, fileId),
      completeUpload: (token, fileId) =>
        customerService.completeUpload(token, fileId),
      addFile: (token, input) => customerService.addFile(token, input),
      removeFile: (token, fileId) => customerService.removeFile(token, fileId),
      getDraft: (token) => customerService.getDraft(token),
      getDraftStatus: (token) => customerService.getDraftStatus(token),
      selectCashPayment: (token) => customerService.selectCashPayment(token),
      quote: (token, input) => customerService.quote(token, input),
      quoteOrder: (token, input) => customerService.quoteOrder(token, input),
      previewQuoteOrder: (token, input) =>
        customerService.previewQuoteOrder(token, input),
      createPayment: (token, input) =>
        paymentService.createCheckout(token, input.acknowledgedTotalPaise),
      verifyPayment: async (token, input) =>
        paymentService.verify(token, input),
      cancelPayment: (token, input) =>
        paymentService.cancel(token, input.razorpayOrderId),
      tracking: (jobCode, token) => trackingService.get(jobCode, token),
      trackPublicOrder: (pickupCode) =>
        customerService.trackPublicOrder(pickupCode),
    };
  });

  async function jsonOf(res: Response): Promise<any> {
    return (await res.json()) as any;
  }

  // Helper to create an uploaded draft ready for settings/payment
  async function createUploadedDraft(): Promise<{
    token: string;
    fileId: string;
  }> {
    const draftRes = await handleCustomerRequest(
      new Request("https://api.test/api/customer/drafts", {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({
          customerName: "Alice Customer",
          customerPhone: "+919876543210",
          instructions: null,
          originalFilename: "lecture-notes.pdf",
          expectedSizeBytes: validPdfBytes.byteLength,
          sourcePageCount: 5,
        }),
      }),
      env,
      customActions,
    );
    expect(draftRes.status).toBe(201);
    const draftJson = await jsonOf(draftRes);
    const token = draftJson.data.draftToken;
    const fileId = draftJson.data.fileId;

    // Complete upload
    const completeRes = await handleCustomerRequest(
      new Request("https://api.test/api/customer/uploads/complete", {
        method: "POST",
        headers: {
          Origin: origin,
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ fileId }),
      }),
      env,
      customActions,
    );
    expect(completeRes.status).toBe(200);

    return { token, fileId };
  }

  // Helper to submit print settings directly to API
  async function submitSettings(
    token: string,
    settings: {
      fileId?: string;
      paperSize: string;
      colorMode: string;
      sides: string;
      selectedPages?: string;
      copies?: number;
    },
  ) {
    const payload = settings.fileId
      ? {
          files: [
            {
              fileId: settings.fileId,
              selectedPages: settings.selectedPages ?? "1",
              copies: settings.copies ?? 1,
              paperSize: settings.paperSize,
              colorMode: settings.colorMode,
              sides: settings.sides,
            },
          ],
        }
      : {
          selectedPages: settings.selectedPages ?? "1",
          copies: settings.copies ?? 1,
          paperSize: settings.paperSize,
          colorMode: settings.colorMode,
          sides: settings.sides,
        };
    return handleCustomerRequest(
      new Request("https://api.test/api/customer/draft/print-settings", {
        method: "PUT",
        headers: {
          Origin: origin,
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      }),
      env,
      customActions,
    );
  }

  // Helper to attempt checkout creation directly to API
  async function attemptCheckout(token: string, totalPaise: number) {
    return handleCustomerRequest(
      new Request("https://api.test/api/customer/payments/create", {
        method: "POST",
        headers: {
          Origin: origin,
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          acknowledgedTotalPaise: totalPaise,
        }),
      }),
      env,
      customActions,
    );
  }

  // =========================================================================
  // CASE 1: UNSUPPORTED A4 COLOR PRINTING (DIRECT API SUBMISSION)
  // =========================================================================
  it("Case 1: Direct API submission of A4 Color is strictly rejected before payment creation", async () => {
    const { token, fileId } = await createUploadedDraft();

    // 1. Customer attempts to set A4 COLOR settings directly via API
    const settingsRes = await submitSettings(token, {
      fileId,
      paperSize: "A4",
      colorMode: "COLOR",
      sides: "SINGLE",
      selectedPages: "1",
    });
    expect(settingsRes.status).toBe(200);
    const quote = await jsonOf(settingsRes);
    expect(quote.data.totalAmountPaise).toBeGreaterThan(0);

    // 2. Customer attempts to initiate checkout for unsupported A4 Color
    const payRes = await attemptCheckout(token, quote.data.totalAmountPaise);

    // 3. MUST fail closed with 503 PRINTER_NOT_READY
    expect(payRes.status).toBe(503);
    const payJson = await jsonOf(payRes);
    expect(payJson.ok).toBe(false);
    expect(payJson.error.code).toBe("PRINTER_NOT_READY");
    expect(payJson.error.message).toBe(
      "Colour printing is currently unavailable on connected printers.",
    );

    // 4. Security check: Payment provider must NEVER be contacted
    expect(mockRazorpayClient.createOrder).not.toHaveBeenCalled();

    // 5. Database check: No payment record must be created
    const paymentRows = db.prepare("SELECT * FROM payments").all();
    expect(paymentRows.length).toBe(0);
  });

  // =========================================================================
  // CASE 2: UNSUPPORTED A4 DUPLEX PRINTING (DIRECT API SUBMISSION)
  // =========================================================================
  it("Case 2: Direct API submission of A4 Duplex is strictly rejected before payment creation", async () => {
    const { token, fileId } = await createUploadedDraft();

    // 1. Customer attempts to set A4 DOUBLE-SIDED settings directly via API
    const settingsRes = await submitSettings(token, {
      fileId,
      paperSize: "A4",
      colorMode: "BW",
      sides: "DOUBLE",
      selectedPages: "1",
    });
    expect(settingsRes.status).toBe(200);
    const quote = await jsonOf(settingsRes);

    // 2. Customer attempts to initiate checkout for unsupported A4 Duplex
    const payRes = await attemptCheckout(token, quote.data.totalAmountPaise);

    // 3. MUST fail closed with 503 PRINTER_NOT_READY
    expect(payRes.status).toBe(503);
    const payJson = await jsonOf(payRes);
    expect(payJson.ok).toBe(false);
    expect(payJson.error.code).toBe("PRINTER_NOT_READY");
    expect(payJson.error.message).toBe(
      "Double-sided printing is currently unavailable on connected printers.",
    );

    // 4. Security check: Payment provider must NEVER be contacted
    expect(mockRazorpayClient.createOrder).not.toHaveBeenCalled();
    const paymentRows = db.prepare("SELECT * FROM payments").all();
    expect(paymentRows.length).toBe(0);
  });

  // =========================================================================
  // CASE 3: UNSUPPORTED A3 B&W PRINTING (DIRECT API SUBMISSION)
  // =========================================================================
  it("Case 3: Direct API submission of A3 B&W is strictly rejected before payment creation", async () => {
    const { token, fileId } = await createUploadedDraft();

    // 1. Customer attempts to set A3 B&W settings directly via API
    const settingsRes = await submitSettings(token, {
      fileId,
      paperSize: "A3",
      colorMode: "BW",
      sides: "SINGLE",
      selectedPages: "1",
    });
    expect(settingsRes.status).toBe(200);
    const quote = await jsonOf(settingsRes);

    // 2. Customer attempts to initiate checkout for unsupported A3
    const payRes = await attemptCheckout(token, quote.data.totalAmountPaise);

    // 3. MUST fail closed with 503 PRINTER_NOT_READY
    expect(payRes.status).toBe(503);
    const payJson = await jsonOf(payRes);
    expect(payJson.ok).toBe(false);
    expect(payJson.error.code).toBe("PRINTER_NOT_READY");
    expect(payJson.error.message).toBe(
      "A3 paper printing is currently unavailable.",
    );

    // 4. Security check: Payment provider must NEVER be contacted
    expect(mockRazorpayClient.createOrder).not.toHaveBeenCalled();
    const paymentRows = db.prepare("SELECT * FROM payments").all();
    expect(paymentRows.length).toBe(0);
  });

  // =========================================================================
  // CASE 4: UNSUPPORTED A3 COLOR DUPLEX PRINTING (DIRECT API SUBMISSION)
  // =========================================================================
  it("Case 4: Direct API submission of A3 Color Duplex is strictly rejected before payment creation", async () => {
    const { token, fileId } = await createUploadedDraft();

    // 1. Customer attempts to set A3 COLOR DOUBLE-SIDED settings directly via API
    const settingsRes = await submitSettings(token, {
      fileId,
      paperSize: "A3",
      colorMode: "COLOR",
      sides: "DOUBLE",
      selectedPages: "1",
    });
    expect(settingsRes.status).toBe(200);
    const quote = await jsonOf(settingsRes);

    // 2. Customer attempts to initiate checkout for unsupported A3 Color Duplex
    const payRes = await attemptCheckout(token, quote.data.totalAmountPaise);

    // 3. MUST fail closed with 503 PRINTER_NOT_READY
    expect(payRes.status).toBe(503);
    const payJson = await jsonOf(payRes);
    expect(payJson.ok).toBe(false);
    expect(payJson.error.code).toBe("PRINTER_NOT_READY");
    expect([
      "Colour printing is currently unavailable on connected printers.",
      "Double-sided printing is currently unavailable on connected printers.",
      "A3 paper printing is currently unavailable.",
    ]).toContain(payJson.error.message);

    // 4. Security check: Payment provider must NEVER be contacted
    expect(mockRazorpayClient.createOrder).not.toHaveBeenCalled();
    const paymentRows = db.prepare("SELECT * FROM payments").all();
    expect(paymentRows.length).toBe(0);
  });

  // =========================================================================
  // CASE 5: VALID A4 B&W SINGLE-SIDED PRINTING IS ACCEPTED
  // =========================================================================
  it("Case 5: Valid A4 B&W Single-sided request is accepted without real payment or printing", async () => {
    const { token, fileId } = await createUploadedDraft();

    // 1. Customer sets valid A4 B&W Single-sided settings
    const settingsRes = await submitSettings(token, {
      fileId,
      paperSize: "A4",
      colorMode: "BW",
      sides: "SINGLE",
      selectedPages: "1",
    });
    expect(settingsRes.status).toBe(200);
    const quote = await jsonOf(settingsRes);

    // 2. Customer initiates checkout
    const payRes = await attemptCheckout(token, quote.data.totalAmountPaise);

    // 3. Server-side validation MUST succeed
    expect(payRes.status).toBe(200);
    const payJson = await jsonOf(payRes);
    expect(payJson.ok).toBe(true);
    expect(payJson.data.status).toBe("CHECKOUT_READY");
    expect(payJson.data.razorpayOrderId).toMatch(/^order_mock_/);
    expect(payJson.data.amountPaise).toBe(quote.data.totalAmountPaise);

    // 4. Verify mocked provider was called exactly once with exact amount
    expect(mockRazorpayClient.createOrder).toHaveBeenCalledTimes(1);
    expect(mockRazorpayClient.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        amountPaise: quote.data.totalAmountPaise,
        currency: "INR",
      }),
    );

    // 5. CRITICAL INVARIANT: NO PHYSICAL PRINTING HAS OCCURRED
    // Order is in PAYMENT_PENDING state; NOT QUEUED, NOT PRINTED, NO PUBLIC JOB CODE YET
    const order = db
      .prepare("SELECT status, public_job_code FROM orders")
      .get() as {
      status: string;
      public_job_code: string | null;
    };
    expect(order.status).toBe("PAYMENT_PENDING");
    expect(order.public_job_code).toBeNull();
  });

  // =========================================================================
  // CASE 6: PAYLOAD TAMPERING / SCHEMA VALIDATION PROTECTION
  // =========================================================================
  it("Case 6: Malformed payloads, invalid paper sizes, and tampered counts are strictly rejected", async () => {
    const { token, fileId } = await createUploadedDraft();

    // 1. Invalid paper size 'LETTER'
    const invalidPaper = await submitSettings(token, {
      fileId,
      paperSize: "LETTER",
      colorMode: "BW",
      sides: "SINGLE",
    });
    expect(invalidPaper.status).toBe(400);

    // 2. Invalid colorMode 'SEPIA'
    const invalidColor = await submitSettings(token, {
      fileId,
      paperSize: "A4",
      colorMode: "SEPIA",
      sides: "SINGLE",
    });
    expect(invalidColor.status).toBe(400);

    // 3. Invalid sides 'TRIPLEX'
    const invalidSides = await submitSettings(token, {
      fileId,
      paperSize: "A4",
      colorMode: "BW",
      sides: "TRIPLEX",
    });
    expect(invalidSides.status).toBe(400);

    // 4. Invalid copies = 0
    const zeroCopies = await submitSettings(token, {
      fileId,
      paperSize: "A4",
      colorMode: "BW",
      sides: "SINGLE",
      copies: 0,
    });
    expect(zeroCopies.status).toBe(400);

    // 5. Invalid copies = 101 (> 100 limit)
    const overCopies = await submitSettings(token, {
      fileId,
      paperSize: "A4",
      colorMode: "BW",
      sides: "SINGLE",
      copies: 101,
    });
    expect(overCopies.status).toBe(400);

    // 6. Manipulated client selectedPageCount is ignored by server logic
    const manipulated = await handleCustomerRequest(
      new Request("https://api.test/api/customer/draft/print-settings", {
        method: "PUT",
        headers: {
          Origin: origin,
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          files: [
            {
              fileId,
              selectedPages: "1",
              selectedPageCount: 10, // Attacker attempts to forge page count
              copies: 1,
              paperSize: "A4",
              colorMode: "BW",
              sides: "SINGLE",
            },
          ],
        }),
      }),
      env,
      customActions,
    );
    expect(manipulated.status).toBe(200);
    const manipJson = await jsonOf(manipulated);
    expect(manipJson.ok).toBe(true);
    expect(manipJson.data.files[0]!.selectedPageCount).toBe(1); // Authoritative server calculation derived 1 page

    // 7. Manipulated payment amount is rejected with PRICE_CHANGED
    const tamperedPay = await attemptCheckout(token, 1); // Attempting to pay 1 paise
    expect(tamperedPay.status).toBe(200);
    const tamperedJson = await jsonOf(tamperedPay);
    expect(tamperedJson.ok).toBe(true);
    expect(tamperedJson.data.status).toBe("PRICE_CHANGED");
    expect(mockRazorpayClient.createOrder).not.toHaveBeenCalled();
  });

  // =========================================================================
  // CASE 7: STALE CAPABILITIES & ADMINISTRATIVE REVIEW PROTECTION
  // =========================================================================
  it("Case 7: Printer with requiresReview=true cannot bypass validation and fails closed", async () => {
    const { token, fileId } = await createUploadedDraft();

    const settingsRes = await submitSettings(token, {
      fileId,
      paperSize: "A4",
      colorMode: "BW",
      sides: "SINGLE",
      selectedPages: "1",
    });
    expect(settingsRes.status).toBe(200);
    const quote = await jsonOf(settingsRes);

    // Admin or hardware fingerprint mismatch triggers requiresReview: true
    db.prepare(
      `UPDATE printers SET
        verified_capabilities_json = json_set(verified_capabilities_json, '$.requiresReview', 1)
       WHERE id = ?`,
    ).run(ids.printerHp);

    const payRes = await attemptCheckout(token, quote.data.totalAmountPaise);
    expect(payRes.status).toBe(503);
    const payJson = await jsonOf(payRes);
    expect(payJson.ok).toBe(false);
    expect(payJson.error.code).toBe("PRINTER_NOT_READY");
    expect(payJson.error.message).toBe(
      "The target printer configuration requires administrative review.",
    );
    expect(mockRazorpayClient.createOrder).not.toHaveBeenCalled();
  });

  // =========================================================================
  // CASE 8: DISABLED, PAUSED, OR OFFLINE PRINTER PROTECTION
  // =========================================================================
  it("Case 8: Offline, paused, or disabled printers fail closed on payment creation", async () => {
    // 1. Printer is OFFLINE
    db.prepare("UPDATE printers SET status = 'OFFLINE' WHERE id = ?").run(
      ids.printerHp,
    );
    const { token: t1, fileId: f1 } = await createUploadedDraft();
    const set1 = await submitSettings(t1, {
      fileId: f1,
      paperSize: "A4",
      colorMode: "BW",
      sides: "SINGLE",
    });
    expect(set1.status).toBe(200);
    const q1 = await jsonOf(set1);
    const offlineRes = await attemptCheckout(t1, q1.data.totalAmountPaise);
    expect(offlineRes.status).toBe(503);
    expect((await jsonOf(offlineRes)).error.message).toContain("offline");

    // 2. Printer is PAUSED
    db.prepare(
      "UPDATE printers SET status = 'ONLINE', is_paused = 1 WHERE id = ?",
    ).run(ids.printerHp);
    const { token: t2, fileId: f2 } = await createUploadedDraft();
    const set2 = await submitSettings(t2, {
      fileId: f2,
      paperSize: "A4",
      colorMode: "BW",
      sides: "SINGLE",
    });
    expect(set2.status).toBe(200);
    const q2 = await jsonOf(set2);
    const pausedRes = await attemptCheckout(t2, q2.data.totalAmountPaise);
    expect(pausedRes.status).toBe(503);
    expect((await jsonOf(pausedRes)).error.message).toContain(
      "offline, blocked, or in an error state",
    );

    // 3. Printer is DISABLED
    db.prepare(
      "UPDATE printers SET status = 'ONLINE', is_paused = 0, enabled = 0 WHERE id = ?",
    ).run(ids.printerHp);
    const { token: t3, fileId: f3 } = await createUploadedDraft();
    const set3 = await submitSettings(t3, {
      fileId: f3,
      paperSize: "A4",
      colorMode: "BW",
      sides: "SINGLE",
    });
    expect(set3.status).toBe(200);
    const q3 = await jsonOf(set3);
    const disabledRes = await attemptCheckout(t3, q3.data.totalAmountPaise);
    expect(disabledRes.status).toBe(503);
    expect((await jsonOf(disabledRes)).error.message).toContain(
      "No enabled printer",
    );

    // 4. Agent heartbeat expired (> 150s AGENT_HEARTBEAT_TIMEOUT_MS)
    db.prepare("UPDATE printers SET enabled = 1 WHERE id = ?").run(
      ids.printerHp,
    );
    db.prepare(
      "UPDATE agents SET created_at_ms = ?, last_heartbeat_at_ms = ? WHERE id = ?",
    ).run(nowMs - 300_000, nowMs - 180_000, ids.agent);
    const { token: t4, fileId: f4 } = await createUploadedDraft();
    const set4 = await submitSettings(t4, {
      fileId: f4,
      paperSize: "A4",
      colorMode: "BW",
      sides: "SINGLE",
    });
    expect(set4.status).toBe(200);
    const q4 = await jsonOf(set4);
    const agentOfflineRes = await attemptCheckout(t4, q4.data.totalAmountPaise);
    expect(agentOfflineRes.status).toBe(503);
    expect((await jsonOf(agentOfflineRes)).error.message).toContain(
      "agent is currently offline",
    );
  });

  // =========================================================================
  // CASE 9: DIRECT VERIFICATION BYPASS ATTEMPT
  // =========================================================================
  it("Case 9: Direct POST to /payments/verify with fabricated Razorpay tokens is rejected", async () => {
    const { token } = await createUploadedDraft();

    // Attacker tries to bypass checkout and verify a fabricated order directly
    const verifyRes = await handleCustomerRequest(
      new Request("https://api.test/api/customer/payments/verify", {
        method: "POST",
        headers: {
          Origin: origin,
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          razorpayOrderId: "order_attacker_fabricated",
          razorpayPaymentId: "pay_attacker_fabricated",
          razorpaySignature:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          trackingToken: "T".repeat(43),
        }),
      }),
      env,
      customActions,
    );

    // Rejected with 409 PAYMENT_ORDER_MISMATCH
    expect(verifyRes.status).toBe(409);
    const verifyJson = await jsonOf(verifyRes);
    expect(verifyJson.ok).toBe(false);
    expect(verifyJson.error.code).toBe("PAYMENT_ORDER_MISMATCH");
  });

  // =========================================================================
  // CASE 10: DEFENSE-IN-DEPTH: ROUTING & PRINT CLAIM BOUNDARY
  // =========================================================================
  it("Case 10: Direct database injection of unsupported jobs cannot be claimed by the HP printer", async () => {
    function injectQueuedOrder(options: {
      orderId: string;
      colorMode: "BW" | "COLOR";
      sides: "SINGLE" | "DOUBLE";
      paperSize: "A4" | "A3";
    }) {
      const uploadId = crypto.randomUUID();
      const fileId = crypto.randomUUID();
      const jobCode = `PG-INJ${options.orderId.slice(0, 4).toUpperCase()}`;

      db.prepare(
        `INSERT INTO orders (
          id, public_job_code, customer_name, customer_phone, original_filename,
          selected_pages, source_page_count, copies, color_mode, paper_size, sides,
          total_amount_paise, printing_amount_paise, status, cleanup_state,
          created_at_ms, updated_at_ms, paid_at_ms, queued_at_ms
        ) VALUES (?, ?, 'Attacker', '+919876543210', 'doc.pdf',
          '1', 1, 1, ?, ?, ?, 1000, 1000, 'QUEUED', 'ACTIVE', ?, ?, ?, ?)`,
      ).run(
        options.orderId,
        jobCode,
        options.colorMode,
        options.paperSize,
        options.sides,
        nowMs,
        nowMs,
        nowMs,
        nowMs,
      );

      db.prepare(
        `INSERT INTO uploads (
          id, order_id, r2_object_key, original_filename, size_bytes, mime_type,
          storage_status, created_at_ms, uploaded_at_ms, updated_at_ms, expected_size_bytes
        ) VALUES (?, ?, ?, 'doc.pdf', 1024, 'application/pdf', 'UPLOADED', ?, ?, ?, 1024)`,
      ).run(
        uploadId,
        options.orderId,
        `uploads/${options.orderId}.pdf`,
        nowMs,
        nowMs,
        nowMs,
      );

      db.prepare(
        `INSERT INTO order_files (
          id, order_id, position, original_filename, r2_object_key, expected_size_bytes,
          size_bytes, mime_type, source_page_count, selected_pages, selected_page_count,
          copies, paper_size, color_mode, sides, printing_amount_paise, service_charge_paise,
          upload_status, print_status, uploaded_at_ms, created_at_ms, updated_at_ms
        ) VALUES (?, ?, 1, 'doc.pdf', ?, 1024, 1024, 'application/pdf',
          1, '1', 1, 1, ?, ?, ?, 1000, 0, 'UPLOADED', 'PENDING', ?, ?, ?)`,
      ).run(
        fileId,
        options.orderId,
        `uploads/${options.orderId}.pdf`,
        options.paperSize,
        options.colorMode,
        options.sides,
        nowMs,
        nowMs,
        nowMs,
      );

      db.prepare(
        `INSERT INTO payments (
          id, order_id, provider_order_id, provider_payment_id, amount_paise,
          currency, status, verified_at_ms, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, 1000, 'INR', 'PAID', ?, ?, ?)`,
      ).run(
        crypto.randomUUID(),
        options.orderId,
        `order_mock_${options.orderId}`,
        `pay_mock_${options.orderId}`,
        nowMs,
        nowMs,
        nowMs,
      );
    }

    // 1. Color order injected directly into DB
    const colorOrderId = "11111111-1111-4000-8000-000000000001";
    injectQueuedOrder({
      orderId: colorOrderId,
      colorMode: "COLOR",
      sides: "SINGLE",
      paperSize: "A4",
    });
    const claimedColor = await printRepo.claimOrRenew(ids.agent, nowMs);
    expect(claimedColor).toBeNull(); // HP mono printer strictly refuses to claim color order

    // 2. Duplex order injected directly into DB (alongside the color order)
    const duplexOrderId = "22222222-2222-4000-8000-000000000002";
    injectQueuedOrder({
      orderId: duplexOrderId,
      colorMode: "BW",
      sides: "DOUBLE",
      paperSize: "A4",
    });
    const claimedDuplex = await printRepo.claimOrRenew(ids.agent, nowMs);
    expect(claimedDuplex).toBeNull(); // HP single-sided printer strictly refuses to claim duplex order

    // 3. A3 order injected directly into DB (alongside the color and duplex orders)
    const a3OrderId = "33333333-3333-4000-8000-000000000003";
    injectQueuedOrder({
      orderId: a3OrderId,
      colorMode: "BW",
      sides: "SINGLE",
      paperSize: "A3",
    });
    const claimedA3 = await printRepo.claimOrRenew(ids.agent, nowMs);
    expect(claimedA3).toBeNull(); // HP A4 printer strictly refuses to claim A3 order

    // 4. Valid A4 B&W Single-sided order injected into DB
    // The printer MUST claim this order while safely ignoring all 3 incompatible orders in the queue!
    const validOrderId = "44444444-4444-4000-8000-000000000004";
    injectQueuedOrder({
      orderId: validOrderId,
      colorMode: "BW",
      sides: "SINGLE",
      paperSize: "A4",
    });
    const claimedValid = await printRepo.claimOrRenew(ids.agent, nowMs);
    expect(claimedValid).not.toBeNull();
    expect(claimedValid?.orderId).toBe(validOrderId);
    expect(claimedValid?.printerId).toBe(ids.printerHp);
  });

  // =========================================================================
  // CASE 11: DEFENSE-IN-DEPTH: WINDOWS AGENT PRINT SETTINGS BOUNDARY
  // =========================================================================
  it("Case 11: Windows Agent print settings normalizer rejects unsupported options with UnsupportedPrintSettingError", () => {
    const hpCapabilities = {
      colour: false,
      duplex: false,
      paperSizes: ["A4"],
    };

    const hpVerified = {
      bw: true,
      color: false,
      duplex: false,
      a4: true,
      a3: false,
    };

    // Color submission -> throws UnsupportedPrintSettingError (downgrade prohibited)
    expect(() =>
      validateAndNormalizePrintSettings(
        {
          printerId: "HP Laser MFP 136w",
          localPdfPath: "C:\\printgo\\file.pdf",
          settings: {
            printerName: "HP Laser MFP 136w",
            colorMode: "COLOUR",
            paperSize: "A4",
          },
          verifiedCapabilities: hpVerified,
        },
        hpCapabilities,
      ),
    ).toThrow(UnsupportedPrintSettingError);

    // Duplex submission -> throws UnsupportedPrintSettingError (downgrade prohibited)
    expect(() =>
      validateAndNormalizePrintSettings(
        {
          printerId: "HP Laser MFP 136w",
          localPdfPath: "C:\\printgo\\file.pdf",
          settings: {
            printerName: "HP Laser MFP 136w",
            colorMode: "BLACK_AND_WHITE",
            sides: "TWO_SIDED_LONG",
            paperSize: "A4",
          },
          verifiedCapabilities: hpVerified,
        },
        hpCapabilities,
      ),
    ).toThrow(UnsupportedPrintSettingError);

    // A3 submission -> throws UnsupportedPrintSettingError (downgrade prohibited)
    expect(() =>
      validateAndNormalizePrintSettings(
        {
          printerId: "HP Laser MFP 136w",
          localPdfPath: "C:\\printgo\\file.pdf",
          settings: {
            printerName: "HP Laser MFP 136w",
            colorMode: "BLACK_AND_WHITE",
            sides: "ONE_SIDED",
            paperSize: "A3",
          },
          verifiedCapabilities: hpVerified,
        },
        hpCapabilities,
      ),
    ).toThrow(UnsupportedPrintSettingError);

    // Valid A4 B&W Single submission -> successfully normalizes settings
    const normalized = validateAndNormalizePrintSettings(
      {
        printerId: "HP Laser MFP 136w",
        localPdfPath: "C:\\printgo\\file.pdf",
        settings: {
          printerName: "HP Laser MFP 136w",
          colorMode: "BLACK_AND_WHITE",
          sides: "ONE_SIDED",
          paperSize: "A4",
          copies: 3,
        },
        verifiedCapabilities: hpVerified,
      },
      hpCapabilities,
    );
    expect(normalized.printerName).toBe("HP Laser MFP 136w");
    expect(normalized.copies).toBe(3);
    expect(normalized.colorMode).toBe("BLACK_AND_WHITE");
    expect(normalized.sides).toBe("ONE_SIDED");
    expect(normalized.paperSize).toBe("A4");
  });
});
