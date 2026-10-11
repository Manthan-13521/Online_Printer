import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";

import { hashSessionToken } from "@printgo/auth";
import { CASH_PAYMENT_WINDOW_MS } from "@printgo/domain";
import { D1CustomerRepository } from "../customer/repository.js";
import { CustomerService } from "../customer/service.js";
import { D1PaymentReadiness } from "./readiness.js";
import { D1PrintingRepository } from "../printing/repository.js";
import type { WorkerEnv } from "../env.js";

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

function createD1(db: DatabaseSync): D1Database {
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
    exec: (sql: string) => {
      db.exec(sql);
      return Promise.resolve({ count: 1, duration: 0 });
    },
  } as unknown as D1Database;
}

describe("PRINTGO — CAPABILITY ENFORCEMENT, GETPUBLICCONFIG FILTERING & STALL DETECTION", () => {
  let db: DatabaseSync;
  let d1: D1Database;
  let customerRepo: D1CustomerRepository;
  let customerService: CustomerService;
  let readiness: D1PaymentReadiness;
  let printingRepo: D1PrintingRepository;

  const initialNowMs = 1_700_000_000_000;
  let currentSimulatedTime = initialNowMs;
  const AGENT_ID = "00000000-0000-4000-8000-000000000001";
  const HP_PRINTER_ID = "00000000-0000-4000-8000-000000000002";
  const XPRINTER_ID = "00000000-0000-4000-8000-000000000003";
  const STALLED_ORDER_ID = "40000000-0000-4000-8000-000000000001";
  const ADMIN_ID = "50000000-0000-4000-8000-000000000001";

  beforeEach(() => {
    currentSimulatedTime = initialNowMs;
    db = new DatabaseSync(":memory:");

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

    d1 = createD1(db);
    customerRepo = new D1CustomerRepository(d1, () => currentSimulatedTime);
    const env: WorkerEnv = {
      APP_ENV: "production",
      PAYMENT_READINESS_DEV_BYPASS: "false",
    } as unknown as WorkerEnv;
    readiness = new D1PaymentReadiness(d1, env, () => currentSimulatedTime);
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
      readiness,
      () => currentSimulatedTime,
    );

    // Seed installation
    db.exec(`
      INSERT INTO installation (
        id, shop_name, contact_phone, address, customer_notice,
        online_printing_enabled, cash_orders_enabled, max_pdf_size_bytes, max_order_upload_bytes,
        identification_sheet_enabled, default_production_printer_id,
        created_at_ms, updated_at_ms
      ) VALUES (
        1, 'PrintGo Test Shop', '+919876543210', '123 Market St', 'Welcome',
        1, 1, 26214400, 104857600,
        0, '${HP_PRINTER_ID}',
        ${initialNowMs}, ${initialNowMs}
      );
    `);

    // Seed print rates (A4/A3, BW/COLOR, SINGLE/DOUBLE)
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

    // Seed Agent (online)
    db.exec(`
      INSERT INTO agents (id, display_name, is_active, last_heartbeat_at_ms, created_at_ms, updated_at_ms)
      VALUES ('${AGENT_ID}', 'Main Shop Agent', 1, ${initialNowMs}, ${initialNowMs}, ${initialNowMs});
    `);

    // Seed HP Printer: Only B&W, Simplex, A4
    const hpCaps = JSON.stringify({
      verified: { bw: true, color: false, duplex: false, a4: true, a3: false },
      enabled: { bw: true, color: false, duplex: false, a4: true, a3: false },
      requiresReview: false,
    });
    db.prepare(
      `
      INSERT INTO printers (
        id, agent_id, display_name, windows_printer_name, status,
        enabled, is_production_eligible, is_virtual, is_paused, priority,
        verified_capabilities_json, enabled_services_json,
        created_at_ms, updated_at_ms
      ) VALUES (
        '${HP_PRINTER_ID}', '${AGENT_ID}', 'HP LaserJet MFP 135', 'HP LaserJet', 'ONLINE',
        1, 1, 0, 0, 100,
        ?, ?,
        ?, ?
      )
    `,
    ).run(
      hpCaps,
      JSON.stringify({
        bw: true,
        color: false,
        duplex: false,
        a4: true,
        a3: false,
      }),
      initialNowMs,
      initialNowMs,
    );

    // Seed Xprinter: Disabled
    db.prepare(
      `
      INSERT INTO printers (
        id, agent_id, display_name, windows_printer_name, status,
        enabled, is_production_eligible, is_virtual, is_paused, priority,
        capabilities_json,
        created_at_ms, updated_at_ms
      ) VALUES (
        '${XPRINTER_ID}', '${AGENT_ID}', 'XP-420B', 'Xprinter', 'ONLINE',
        0, 1, 0, 0, 50,
        '{"colour":false,"duplex":false,"paperSizes":["A4"]}',
        ?, ?
      )
    `,
    ).run(initialNowMs, initialNowMs);
  });

  async function createDraft(
    paperSize: "A4" | "A3",
    colorMode: "BW" | "COLOR",
    sides: "SINGLE" | "DOUBLE",
    rawToken = "token_test_1234567890123456789012345678901234567",
    orderId = "10000000-0000-4000-8000-000000000001",
  ) {
    const tokenHash = await hashSessionToken(rawToken);
    const fileId = "30000000-0000-4000-8000-000000000001";

    db.exec(`
      INSERT INTO orders (
        id, customer_name, customer_phone, original_filename, instructions, status,
        source_page_count, selected_pages, copies, paper_size, color_mode, sides,
        printing_amount_paise, service_charge_paise, total_amount_paise, currency,
        draft_token_hash, draft_expires_at_ms, cleanup_state, created_at_ms, updated_at_ms
      ) VALUES (
        '${orderId}', 'Rahul', '+919876543210', 'document.pdf', NULL, 'UPLOADED',
        2, '1-2', 1, '${paperSize}', '${colorMode}', '${sides}',
        400, 0, 400, 'INR',
        '${tokenHash}', ${currentSimulatedTime + 600000}, 'ACTIVE', ${currentSimulatedTime}, ${currentSimulatedTime}
      );

      INSERT INTO order_files (
        id, order_id, position, original_filename, r2_object_key,
        expected_size_bytes, size_bytes, source_page_count, selected_pages,
        copies, paper_size, color_mode, sides, printing_amount_paise, service_charge_paise,
        upload_status, print_status, uploaded_at_ms, created_at_ms, updated_at_ms
      ) VALUES (
        '${fileId}', '${orderId}', 1, 'document.pdf', 'uploads/${orderId}/${fileId}.pdf',
        1024, 1024, 2, '1-2',
        1, '${paperSize}', '${colorMode}', '${sides}', 400, 0,
        'UPLOADED', 'PENDING', ${currentSimulatedTime}, ${currentSimulatedTime}, ${currentSimulatedTime}
      );
    `);
    return { orderId, rawToken };
  }

  it("1. getPublicConfig strictly filters available options to only what online verified printers support", async () => {
    const config = await customerRepo.getPublicConfig();
    expect(config).not.toBeNull();
    // Only A4 BW SINGLE should be present because HP printer does not support COLOR, DOUBLE, or A3
    expect(config!.availablePrintOptions).toEqual([
      {
        paperSize: "A4",
        colorMode: "BW",
        sides: "SINGLE",
        pricePerPagePaise: 200,
      },
    ]);
  });

  it("2. When the online printer goes offline or is paused, availablePrintOptions becomes empty", async () => {
    db.exec(
      `UPDATE printers SET status = 'OFFLINE' WHERE id = '${HP_PRINTER_ID}';`,
    );
    const config = await customerRepo.getPublicConfig();
    expect(config).not.toBeNull();
    expect(config!.availablePrintOptions).toEqual([]);
  });

  it("3. Disabled printers (e.g. Xprinter enabled=0) never authorize unsupported options", async () => {
    // Enable color on disabled Xprinter
    db.exec(`
      UPDATE printers
      SET capabilities_json = '{"colour":true,"duplex":true,"paperSizes":["A4","A3"]}'
      WHERE id = '${XPRINTER_ID}';
    `);
    const config = await customerRepo.getPublicConfig();
    // Still only A4 BW SINGLE should be returned because Xprinter is enabled=0
    expect(config!.availablePrintOptions).toEqual([
      {
        paperSize: "A4",
        colorMode: "BW",
        sides: "SINGLE",
        pricePerPagePaise: 200,
      },
    ]);
  });

  it("3b. When duplex is supported by an online printer, getPublicConfig orders SINGLE before DOUBLE", async () => {
    db.exec(`
      UPDATE printers
      SET capabilities_json = '{"colour":false,"duplex":true,"paperSizes":["A4"]}',
          verified_capabilities_json = '{"duplex":true,"color":false,"a4":true,"a3":false,"bw":true}'
      WHERE id = '${HP_PRINTER_ID}';
    `);
    const config = await customerRepo.getPublicConfig();
    expect(config).not.toBeNull();
    const sidesList = config!.availablePrintOptions.map((o) => o.sides);
    expect(sidesList).toEqual(["SINGLE", "DOUBLE"]);
  });

  it("4. selectCashPayment rejects unsupported settings (Colour) with PRINTER_NOT_READY", async () => {
    const { rawToken } = await createDraft("A4", "COLOR", "SINGLE");
    await expect(customerService.selectCashPayment(rawToken)).rejects.toThrow(
      "Colour printing is currently unavailable on connected printers.",
    );
  });

  it("5. selectCashPayment rejects unsupported settings (Duplex) with PRINTER_NOT_READY", async () => {
    const { rawToken } = await createDraft("A4", "BW", "DOUBLE");
    await expect(customerService.selectCashPayment(rawToken)).rejects.toThrow(
      "Double-sided printing is currently unavailable on connected printers.",
    );
  });

  it("6. selectCashPayment rejects unsupported settings (A3) with PRINTER_NOT_READY", async () => {
    const { rawToken } = await createDraft("A3", "BW", "SINGLE");
    await expect(customerService.selectCashPayment(rawToken)).rejects.toThrow(
      "A3 paper printing is currently unavailable.",
    );
  });

  it("7. selectCashPayment accepts supported settings (A4 BW Single) and transitions to PAYMENT_PENDING", async () => {
    const { rawToken } = await createDraft("A4", "BW", "SINGLE");
    const result = await customerService.selectCashPayment(rawToken);
    expect(result.payableAmountPaise).toBe(400);
    expect(result.cashExpiresAtMs).toBe(
      currentSimulatedTime + CASH_PAYMENT_WINDOW_MS,
    );
  });

  it("8. Stall detection flags an unassigned paid order that has been queued for 5+ minutes", async () => {
    const fiveMinutesAgo = currentSimulatedTime - 310_000;
    db.exec(`
      INSERT INTO orders (
        id, customer_name, customer_phone, original_filename, status,
        source_page_count, selected_pages, copies, paper_size, color_mode, sides,
        printing_amount_paise, service_charge_paise, total_amount_paise, currency,
        draft_token_hash, queued_at_ms, printer_id, cleanup_state, created_at_ms, updated_at_ms
      ) VALUES (
        '${STALLED_ORDER_ID}', 'Rahul', '+919876543210', 'doc.pdf', 'QUEUED',
        1, '1', 1, 'A4', 'BW', 'SINGLE',
        200, 0, 200, 'INR',
        'hash123', ${fiveMinutesAgo}, NULL, 'ACTIVE', ${fiveMinutesAgo}, ${fiveMinutesAgo}
      );
    `);

    const stall = await printingRepo.getQueueStallDetails(currentSimulatedTime);
    expect(stall.isStalled).toBe(true);
    expect(stall.stalledOrderId).toBe(STALLED_ORDER_ID);
    expect(stall.reason).toContain("over 5 minutes");
  });

  it("9. recoverQueue returns honest message when no orders or locks were changed", async () => {
    const rec = await printingRepo.recoverQueue({
      adminId: ADMIN_ID,
      nowMs: currentSimulatedTime,
    });
    expect(rec.recoveredOrdersCount).toBe(0);
    expect(rec.uncertainOrdersCount).toBe(0);
    expect(rec.message).toContain(
      "Print Recovery checked: No stalled in-flight orders or stale locks found",
    );
  });
});
