import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";

import { D1PrintingRepository } from "../printing/repository.js";
import { D1PaymentReadiness } from "./readiness.js";
import {
  validateAndNormalizePrintSettings,
  UnsupportedPrintSettingError,
} from "../../../../agent/windows/src/printing/print-settings.js";

const migrationFiles = [
  "0001_initial_schema.sql",
  "0002_customer_draft_upload.sql",
  "0003_payment_idempotency.sql",
  "0004_customer_tracking.sql",
  "0005_printer_test_commands.sql",
  "0006_paid_print_execution.sql",
  "0007_performance_optimization_indexes.sql",
  "0008_production_printer_reliability.sql",
  "0009_retention_and_pii_purge.sql",
  "0010_efficiency_and_branding.sql",
  "0011_retention_retry_schedule.sql",
  "0012_multi_file_cleanup_and_app_branding.sql",
  "0013_d1_usage_optimization.sql",
  "0014_addon_services.sql",
  "0015_phase3_priority_tracking_discounts.sql",
  "0016_phase4_failure_recovery_and_pause.sql",
  "0017_phase5_fallback_and_reprint_protection.sql",
  "0018_phase6_history_cleanup.sql",
  "0020_order_retention_duration.sql",
  "0023_identification_sheet_conditions.sql",
  "0024_printer_priority.sql",
  "0025_verified_printer_capabilities.sql",
  "0026_phase4_fallback_recovery.sql",
  "0027_parallel_physical_printer_locks.sql",
];

const migrations = migrationFiles.map((name) =>
  readFileSync(
    new URL(`../../../../../database/migrations/${name}`, import.meta.url),
    "utf8",
  ),
);

class Statement {
  private values: SQLInputValue[] = [];
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
  ) {}
  bind(...values: unknown[]) {
    this.values = values as SQLInputValue[];
    return this;
  }
  run(): Promise<D1Result> {
    const result = this.db.prepare(this.sql).run(...this.values);
    return Promise.resolve({
      success: true,
      meta: { changes: Number(result.changes) },
      results: [],
    } as unknown as D1Result);
  }
  first<T>(): Promise<T | null> {
    return Promise.resolve(
      (this.db.prepare(this.sql).get(...this.values) as T | undefined) ?? null,
    );
  }
  all<T>(): Promise<D1Result<T>> {
    return Promise.resolve({
      success: true,
      meta: { changes: 0 },
      results: this.db.prepare(this.sql).all(...this.values) as T[],
    } as unknown as D1Result<T>);
  }
}

function asD1(db: DatabaseSync): D1Database {
  let batchLock: Promise<void> = Promise.resolve();
  return {
    prepare: (sql: string) => new Statement(db, sql),
    async batch(statements: Statement[]) {
      const previous = batchLock;
      let release!: () => void;
      batchLock = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      db.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
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
  printerMono: "50000000-0000-4000-8000-000000000001",
  printerColor: "50000000-0000-4000-8000-000000000002",
  order: "10000000-0000-4000-8000-000000000001",
  file1: "20000000-0000-4000-8000-000000000001",
  file2: "20000000-0000-4000-8000-000000000002",
  upload: "30000000-0000-4000-8000-000000000001",
  upload2: "30000000-0000-4000-8000-000000000002",
  payment: "60000000-0000-4000-8000-000000000001",
};

describe("Payment-to-Print Capability & Claim Parity Integration Suite", () => {
  let db: DatabaseSync;
  let d1: D1Database;
  let readiness: D1PaymentReadiness;
  let printRepo: D1PrintingRepository;
  const nowMs = 1_000_000;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    for (const sql of migrations) {
      db.exec(sql);
    }
    d1 = asD1(db);
    readiness = new D1PaymentReadiness(
      d1,
      { APP_ENV: "production", PAYMENT_READINESS_DEV_BYPASS: "false" },
      () => nowMs,
    );
    printRepo = new D1PrintingRepository(d1);

    // Baseline installation setup
    db.prepare(
      `
      INSERT INTO installation (
        id, shop_name, online_printing_enabled, default_production_printer_id,
        identification_sheet_enabled, created_at_ms, updated_at_ms
      ) VALUES (1, 'PrintGo Test Shop', 1, ?, 0, ?, ?)
    `,
    ).run(ids.printerMono, nowMs, nowMs);

    // Active connected Agent
    db.prepare(
      `
      INSERT INTO agents (
        id, display_name, credential_hash, is_active, paired_at_ms,
        last_heartbeat_at_ms, created_at_ms, updated_at_ms
      ) VALUES (?, 'Shop Agent', 'hash-test', 1, ?, ?, ?, ?)
    `,
    ).run(ids.agent, nowMs, nowMs, nowMs, nowMs);
  });

  function seedPrinters(
    options: {
      monoStatus?: "ONLINE" | "OFFLINE";
      monoFallbackEnabled?: boolean;
      monoFallbackId?: string | null;
      colorStatus?: "ONLINE" | "OFFLINE";
    } = {},
  ) {
    // Printer A: Mono Laser (Default)
    db.prepare(
      `
      INSERT INTO printers (
        id, agent_id, display_name, windows_printer_name, enabled, status,
        is_production_eligible, is_virtual, auto_fallback_enabled, fallback_printer_id,
        capabilities_json, verified_capabilities_json, enabled_services_json,
        last_status_at_ms, created_at_ms, updated_at_ms
      ) VALUES (?, ?, 'HP LaserJet (Mono)', 'HP LaserJet Pro', 1, ?, 1, 0, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      ids.printerMono,
      ids.agent,
      options.monoStatus ?? "ONLINE",
      options.monoFallbackEnabled ? 1 : 0,
      options.monoFallbackId ?? null,
      JSON.stringify({ colour: false, duplex: true, paperSizes: ["A4"] }),
      JSON.stringify({
        verified: { bw: true, color: false, duplex: true, a4: true, a3: false },
        enabled: { bw: true, color: false, duplex: true, a4: true, a3: false },
        requiresReview: false,
      }),
      JSON.stringify({
        bw: true,
        color: false,
        duplex: true,
        a4: true,
        a3: false,
      }),
      nowMs,
      nowMs,
      nowMs,
    );

    // Printer B: Color Multi-function
    db.prepare(
      `
      INSERT INTO printers (
        id, agent_id, display_name, windows_printer_name, enabled, status,
        is_production_eligible, is_virtual, auto_fallback_enabled, fallback_printer_id,
        capabilities_json, verified_capabilities_json, enabled_services_json,
        last_status_at_ms, created_at_ms, updated_at_ms
      ) VALUES (?, ?, 'Epson Color MFP', 'Epson EcoTank', 1, ?, 1, 0, 0, NULL, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      ids.printerColor,
      ids.agent,
      options.colorStatus ?? "ONLINE",
      JSON.stringify({ colour: true, duplex: false, paperSizes: ["A4", "A3"] }),
      JSON.stringify({
        verified: { bw: true, color: true, duplex: false, a4: true, a3: true },
        enabled: { bw: true, color: true, duplex: false, a4: true, a3: true },
        requiresReview: false,
      }),
      JSON.stringify({
        bw: true,
        color: true,
        duplex: false,
        a4: true,
        a3: true,
      }),
      nowMs,
      nowMs,
      nowMs,
    );
  }

  function seedOrder(options: {
    colorMode: "BW" | "COLOR";
    sides: "SINGLE" | "DOUBLE";
    paperSize: "A4" | "A3";
  }) {
    db.prepare(
      `
      INSERT INTO orders (
        id, public_job_code, customer_name, customer_phone, original_filename,
        selected_pages, source_page_count, copies, color_mode, paper_size, sides,
        total_amount_paise, printing_amount_paise, status, cleanup_state,
        created_at_ms, updated_at_ms, paid_at_ms, queued_at_ms
      ) VALUES (?, 'PG-PARITY01', 'Test Customer', '+919876543210', 'doc.pdf',
        '1', 1, 1, ?, ?, ?, 1000, 1000, 'QUEUED', 'ACTIVE', ?, ?, ?, ?)
    `,
    ).run(
      ids.order,
      options.colorMode,
      options.paperSize,
      options.sides,
      nowMs,
      nowMs,
      nowMs,
      nowMs,
    );

    db.prepare(
      `
      INSERT INTO uploads (
        id, order_id, r2_object_key, original_filename, size_bytes, mime_type,
        storage_status, created_at_ms, uploaded_at_ms, updated_at_ms, expected_size_bytes
      ) VALUES (?, ?, 'uploads/doc.pdf', 'doc.pdf', 1024, 'application/pdf', 'UPLOADED', ?, ?, ?, 1024)
    `,
    ).run(ids.upload, ids.order, nowMs, nowMs, nowMs);

    db.prepare(
      `
      INSERT INTO order_files (
        id, order_id, position, original_filename, r2_object_key, expected_size_bytes,
        size_bytes, mime_type, source_page_count, selected_pages, selected_page_count,
        copies, paper_size, color_mode, sides, printing_amount_paise, service_charge_paise,
        upload_status, print_status, uploaded_at_ms, created_at_ms, updated_at_ms
      ) VALUES (?, ?, 1, 'doc.pdf', 'uploads/doc.pdf', 1024, 1024, 'application/pdf',
        1, '1', 1, 1, ?, ?, ?, 1000, 0, 'UPLOADED', 'PENDING', ?, ?, ?)
    `,
    ).run(
      ids.file1,
      ids.order,
      options.paperSize,
      options.colorMode,
      options.sides,
      nowMs,
      nowMs,
      nowMs,
    );

    db.prepare(
      `
      INSERT INTO payments (
        id, order_id, provider_order_id, provider_payment_id, amount_paise,
        currency, status, verified_at_ms, created_at_ms, updated_at_ms
      ) VALUES (?, ?, 'order_razor_test', 'pay_razor_test', 1000, 'INR', 'PAID', ?, ?, ?)
    `,
    ).run(ids.payment, ids.order, nowMs, nowMs, nowMs);
  }

  it("PARITY TEST 1: Default mono printer online, color printer online -> Phase 3 smart capability routing routes color order to color printer; fails closed when color printer offline", async () => {
    seedPrinters({ monoStatus: "ONLINE", colorStatus: "ONLINE" });
    seedOrder({ colorMode: "COLOR", sides: "SINGLE", paperSize: "A4" });

    // 1. Checkout readiness routes Color order to capable secondary color printer
    const readinessResult = await readiness.check({
      colorMode: "COLOR",
      sides: "SINGLE",
      paperSize: "A4",
    });
    expect(readinessResult.ready).toBe(true);
    if (readinessResult.ready) {
      expect(readinessResult.printerId).toBe(ids.printerColor);
    }

    // 2. Claiming query claims on capable secondary color printer
    const claimedJob = await printRepo.claimOrRenew(ids.agent, nowMs);
    expect(claimedJob).not.toBeNull();
    expect(claimedJob?.printerId).toBe(ids.printerColor);

    // 3. When color printer is OFFLINE, both checkout readiness and claim fail closed
    db.prepare(`UPDATE printers SET status = 'OFFLINE' WHERE id = ?`).run(
      ids.printerColor,
    );
    db.prepare(
      `UPDATE orders SET status = 'QUEUED', claimed_by_agent_id = NULL, claim_id = NULL, claim_expires_at_ms = NULL, claimed_at_ms = NULL, printer_id = NULL WHERE id = ?`,
    ).run(ids.order);

    const offlineReadiness = await readiness.check({
      colorMode: "COLOR",
      sides: "SINGLE",
      paperSize: "A4",
    });
    expect(offlineReadiness.ready).toBe(false);
    if (!offlineReadiness.ready) {
      expect(offlineReadiness.reason).toBe("COLOR_MODE_UNSUPPORTED");
    }

    const offlineClaim = await printRepo.claimOrRenew(ids.agent, nowMs);
    expect(offlineClaim).toBeNull();
  });

  it("PARITY TEST 2: Default mono printer offline with NO fallback, color order rejected at checkout and claim", async () => {
    seedPrinters({
      monoStatus: "OFFLINE",
      monoFallbackEnabled: false,
      colorStatus: "ONLINE",
    });
    seedOrder({ colorMode: "COLOR", sides: "SINGLE", paperSize: "A4" });

    // Checkout must NOT accept color order just because secondary printer is online
    const readinessResult = await readiness.check({
      colorMode: "COLOR",
      sides: "SINGLE",
      paperSize: "A4",
    });
    expect(readinessResult.ready).toBe(false);
    if (!readinessResult.ready) {
      expect(readinessResult.reason).toBe("PRINTER_UNAVAILABLE");
    }

    const claimedJob = await printRepo.claimOrRenew(ids.agent, nowMs);
    expect(claimedJob).toBeNull();
  });

  it("PARITY TEST 3: Default mono printer offline with VALID fallback to color printer -> approved at checkout and claimed on fallback", async () => {
    seedPrinters({
      monoStatus: "OFFLINE",
      monoFallbackEnabled: true,
      monoFallbackId: ids.printerColor,
      colorStatus: "ONLINE",
    });
    seedOrder({ colorMode: "COLOR", sides: "SINGLE", paperSize: "A4" });

    // 1. Readiness approves on fallback printer
    const readinessResult = await readiness.check({
      colorMode: "COLOR",
      sides: "SINGLE",
      paperSize: "A4",
    });
    expect(readinessResult.ready).toBe(true);
    if (readinessResult.ready) {
      expect(readinessResult.printerId).toBe(ids.printerColor);
    }

    // 2. Claiming successfully dispatches to fallback printer
    const claimedJob = await printRepo.claimOrRenew(ids.agent, nowMs);
    expect(claimedJob).not.toBeNull();
    expect(claimedJob?.printerId).toBe(ids.printerColor);
  });

  it("PARITY TEST 4: Duplex order on printer where duplex is false/0/disabled -> rejected at checkout and claim", async () => {
    // Both printers online, but color printer has duplex: false. Fallback pointing to color printer.
    seedPrinters({
      monoStatus: "OFFLINE",
      monoFallbackEnabled: true,
      monoFallbackId: ids.printerColor,
      colorStatus: "ONLINE",
    });
    seedOrder({ colorMode: "COLOR", sides: "DOUBLE", paperSize: "A4" });

    // Readiness rejects duplex
    const readinessResult = await readiness.check({
      colorMode: "COLOR",
      sides: "DOUBLE",
      paperSize: "A4",
    });
    expect(readinessResult.ready).toBe(false);
    if (!readinessResult.ready) {
      expect(readinessResult.reason).toBe("SIDES_MODE_UNSUPPORTED");
    }

    // Claim rejects duplex
    const claimedJob = await printRepo.claimOrRenew(ids.agent, nowMs);
    expect(claimedJob).toBeNull();
  });

  it("PARITY TEST 5: Printer with requiresReview=true -> rejected at checkout and claim", async () => {
    seedPrinters({ monoStatus: "ONLINE" });
    // Simulate fingerprint change
    db.prepare(
      `
      UPDATE printers SET
        verified_capabilities_json = json_set(verified_capabilities_json, '$.requiresReview', 1)
      WHERE id = ?
    `,
    ).run(ids.printerMono);
    seedOrder({ colorMode: "BW", sides: "SINGLE", paperSize: "A4" });

    const readinessResult = await readiness.check({
      colorMode: "BW",
      sides: "SINGLE",
      paperSize: "A4",
    });
    expect(readinessResult.ready).toBe(false);
    if (!readinessResult.ready) {
      expect(readinessResult.reason).toBe("PRINTER_UNAVAILABLE");
    }

    const claimedJob = await printRepo.claimOrRenew(ids.agent, nowMs);
    expect(claimedJob).toBeNull();
  });

  it("PARITY TEST 6: Compatible order on default printer -> approved at checkout and claimed on default", async () => {
    seedPrinters({ monoStatus: "ONLINE" });
    seedOrder({ colorMode: "BW", sides: "SINGLE", paperSize: "A4" });

    const readinessResult = await readiness.check({
      colorMode: "BW",
      sides: "SINGLE",
      paperSize: "A4",
    });
    expect(readinessResult.ready).toBe(true);
    expect((readinessResult as { printerId: string }).printerId).toBe(
      ids.printerMono,
    );

    const claimedJob = await printRepo.claimOrRenew(ids.agent, nowMs);
    expect(claimedJob).not.toBeNull();
    expect(claimedJob?.printerId).toBe(ids.printerMono);
  });

  it("PARITY TEST 7: Preflight WMI UNKNOWN with verified capabilities -> approved at checkout, claimed with verifiedFeatures, authorized for SumatraPDF options, and fails closed when unverified", async () => {
    // 1. Seed printer with WMI capabilities: colour: 'UNKNOWN', duplex: 'UNKNOWN'
    // but physically verified and enabled by Admin in D1
    db.prepare(
      `
      INSERT INTO printers (
        id, agent_id, display_name, windows_printer_name, enabled, status,
        is_production_eligible, is_virtual, auto_fallback_enabled, fallback_printer_id,
        capabilities_json, verified_capabilities_json, enabled_services_json,
        last_status_at_ms, created_at_ms, updated_at_ms
      ) VALUES (?, ?, 'Konica Minolta Bizhub', 'Konica_Bizhub_C250i', 1, 'ONLINE', 1, 0, 0, NULL, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      "50000000-0000-4000-8000-000000000099",
      ids.agent,
      JSON.stringify({
        colour: "UNKNOWN",
        duplex: "UNKNOWN",
        paperSizes: ["A4"],
      }),
      JSON.stringify({
        verified: { bw: true, color: true, duplex: true, a4: true, a3: false },
        enabled: { bw: true, color: true, duplex: true, a4: true, a3: false },
        requiresReview: false,
      }),
      JSON.stringify({
        bw: true,
        color: true,
        duplex: true,
        a4: true,
        a3: false,
      }),
      nowMs,
      nowMs,
      nowMs,
    );

    // Set as default production printer
    db.prepare(
      `UPDATE installation SET default_production_printer_id = ? WHERE id = 1`,
    ).run("50000000-0000-4000-8000-000000000099");

    // 2. Checkout readiness check for Color + Duplex (Double-sided) on A4
    const readinessResult = await readiness.check({
      colorMode: "COLOR",
      sides: "DOUBLE",
      paperSize: "A4",
    });
    expect(readinessResult.ready).toBe(true);
    if (readinessResult.ready) {
      expect(readinessResult.printerId).toBe(
        "50000000-0000-4000-8000-000000000099",
      );
    }

    // 3. Seed paid order requesting Color + Duplex
    seedOrder({ colorMode: "COLOR", sides: "DOUBLE", paperSize: "A4" });

    // 4. Claim job in repository
    const claimedJob = await printRepo.claimOrRenew(ids.agent, nowMs);
    expect(claimedJob).not.toBeNull();
    expect(claimedJob?.printerId).toBe("50000000-0000-4000-8000-000000000099");
    expect(claimedJob?.windowsPrinterName).toBe("Konica_Bizhub_C250i");

    // Authoritative verified features passed to agent
    expect(claimedJob?.verifiedFeatures).toEqual({
      bw: true,
      color: true,
      duplex: true,
      a4: true,
      a3: false,
    });

    // 5. Windows Agent: Validate print settings using verifiedFeatures against WMI UNKNOWN capabilities
    const normalized = validateAndNormalizePrintSettings(
      {
        printerId: claimedJob!.windowsPrinterName,
        localPdfPath: "C:\\printgo\\jobs\\order-doc.pdf",
        copies: claimedJob!.copies,
        settings: {
          printerName: claimedJob!.windowsPrinterName,
          paperSize: claimedJob!.paperSize,
          colorMode:
            claimedJob!.colorMode === "COLOR" ? "COLOUR" : "BLACK_AND_WHITE",
          sides:
            claimedJob!.sides === "DOUBLE" ? "TWO_SIDED_LONG" : "ONE_SIDED",
          copies: claimedJob!.copies,
        },
        verifiedCapabilities: claimedJob!.verifiedFeatures,
      },
      {
        colour: "UNKNOWN",
        duplex: "UNKNOWN",
        paperSizes: ["A4"],
      },
    );

    expect(normalized.colorMode).toBe("COLOUR");
    expect(normalized.sides).toBe("TWO_SIDED_LONG");
    expect(normalized.paperSize).toBe("A4");

    // SumatraPDF print settings argument construction
    const sumatraParts = [
      `${normalized.copies}x`,
      `paper=${normalized.paperSize}`,
      normalized.colorMode === "COLOUR" ? "color" : "monochrome",
      normalized.sides === "TWO_SIDED_LONG" ? "duplexlong" : "simplex",
      "fit",
    ];
    const sumatraString = sumatraParts.join(",");
    expect(sumatraString).toBe("1x,paper=A4,color,duplexlong,fit");

    // 6. Fail-closed verification:
    // If verifiedCapabilities is missing on unverified printer with WMI UNKNOWN, fails closed
    expect(() =>
      validateAndNormalizePrintSettings(
        {
          printerId: claimedJob!.windowsPrinterName,
          localPdfPath: "C:\\printgo\\jobs\\order-doc.pdf",
          copies: claimedJob!.copies,
          settings: {
            printerName: claimedJob!.windowsPrinterName,
            paperSize: "A4",
            colorMode: "COLOUR",
            sides: "TWO_SIDED_LONG",
            copies: 1,
          },
        },
        {
          colour: "UNKNOWN",
          duplex: "UNKNOWN",
          paperSizes: ["A4"],
        },
      ),
    ).toThrow(UnsupportedPrintSettingError);

    // If verifiedCapabilities has color: false, fails closed
    expect(() =>
      validateAndNormalizePrintSettings(
        {
          printerId: claimedJob!.windowsPrinterName,
          localPdfPath: "C:\\printgo\\jobs\\order-doc.pdf",
          copies: claimedJob!.copies,
          settings: {
            printerName: claimedJob!.windowsPrinterName,
            paperSize: "A4",
            colorMode: "COLOUR",
            sides: "TWO_SIDED_LONG",
            copies: 1,
          },
          verifiedCapabilities: {
            bw: true,
            color: false,
            duplex: true,
            a4: true,
            a3: false,
          },
        },
        {
          colour: "UNKNOWN",
          duplex: "UNKNOWN",
          paperSizes: ["A4"],
        },
      ),
    ).toThrow(/does not support colour printing/i);

    // If verifiedCapabilities has duplex: false, fails closed
    expect(() =>
      validateAndNormalizePrintSettings(
        {
          printerId: claimedJob!.windowsPrinterName,
          localPdfPath: "C:\\printgo\\jobs\\order-doc.pdf",
          copies: claimedJob!.copies,
          settings: {
            printerName: claimedJob!.windowsPrinterName,
            paperSize: "A4",
            colorMode: "COLOUR",
            sides: "TWO_SIDED_LONG",
            copies: 1,
          },
          verifiedCapabilities: {
            bw: true,
            color: true,
            duplex: false,
            a4: true,
            a3: false,
          },
        },
        {
          colour: "UNKNOWN",
          duplex: "UNKNOWN",
          paperSizes: ["A4"],
        },
      ),
    ).toThrow(/does not support double-sided/i);
  });

  it("PARITY TEST 8: Priority selection and deterministic tie-breaking among multiple capable secondary printers", async () => {
    // Default mono printer with priority 0
    seedPrinters({ monoStatus: "ONLINE" });
    db.prepare(`UPDATE printers SET priority = 0 WHERE id = ?`).run(
      ids.printerMono,
    );

    // Secondary Color printer 1: Epson (priority 10)
    db.prepare(`UPDATE printers SET priority = 10 WHERE id = ?`).run(
      ids.printerColor,
    );

    // Secondary Color printer 2: Canon (priority 50)
    const printerCanonId = "50000000-0000-4000-8000-000000000050";
    db.prepare(
      `
      INSERT INTO printers (
        id, agent_id, display_name, windows_printer_name, enabled, status,
        is_production_eligible, is_virtual, auto_fallback_enabled, fallback_printer_id, priority,
        capabilities_json, verified_capabilities_json, enabled_services_json,
        last_status_at_ms, created_at_ms, updated_at_ms
      ) VALUES (?, ?, 'Canon Color High-Speed', 'Canon_Color_50', 1, 'ONLINE', 1, 0, 0, NULL, 50, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      printerCanonId,
      ids.agent,
      JSON.stringify({ colour: true, duplex: false, paperSizes: ["A4"] }),
      JSON.stringify({
        verified: { bw: true, color: true, duplex: false, a4: true, a3: false },
        enabled: { bw: true, color: true, duplex: false, a4: true, a3: false },
        requiresReview: false,
      }),
      JSON.stringify({
        bw: true,
        color: true,
        duplex: false,
        a4: true,
        a3: false,
      }),
      nowMs,
      nowMs,
      nowMs,
    );

    // 1. Checkout readiness MUST pick highest priority printer (Canon, priority 50)
    const readinessResult = await readiness.check({
      colorMode: "COLOR",
      sides: "SINGLE",
      paperSize: "A4",
    });
    expect(readinessResult.ready).toBe(true);
    if (readinessResult.ready) {
      expect(readinessResult.printerId).toBe(printerCanonId);
    }

    // 2. Claim query MUST pick Canon (priority 50)
    seedOrder({ colorMode: "COLOR", sides: "SINGLE", paperSize: "A4" });
    const claimedJob = await printRepo.claimOrRenew(ids.agent, nowMs);
    expect(claimedJob).not.toBeNull();
    expect(claimedJob?.printerId).toBe(printerCanonId);

    // 3. Tie-breaking check: Set Canon priority to 10 (same as Epson)
    // Epson id is ...0002, Canon id is ...0050. Epson has smaller ID alphabetically -> id ASC chooses Epson!
    db.prepare(`UPDATE printers SET priority = 10 WHERE id = ?`).run(
      printerCanonId,
    );
    db.prepare(`DELETE FROM print_attempt_steps WHERE order_id = ?`).run(
      ids.order,
    );
    db.prepare(`DELETE FROM print_attempts WHERE order_id = ?`).run(ids.order);
    db.prepare(
      `UPDATE orders SET status = 'QUEUED', claimed_by_agent_id = NULL, claim_id = NULL, claim_expires_at_ms = NULL, claimed_at_ms = NULL, printer_id = NULL WHERE id = ?`,
    ).run(ids.order);

    const tieReadiness = await readiness.check({
      colorMode: "COLOR",
      sides: "SINGLE",
      paperSize: "A4",
    });
    expect(tieReadiness.ready).toBe(true);
    if (tieReadiness.ready) {
      expect(tieReadiness.printerId).toBe(ids.printerColor);
    }

    const tieClaim = await printRepo.claimOrRenew(ids.agent, nowMs);
    expect(tieClaim).not.toBeNull();
    expect(tieClaim?.printerId).toBe(ids.printerColor);
  });

  it("PARITY TEST 9: A3 paper capability routing and fail-closed when offline", async () => {
    // Default mono printer is A4 only; secondary color printer supports A3 + A4
    seedPrinters({ monoStatus: "ONLINE", colorStatus: "ONLINE" });

    // Customer orders A3 B&W
    const readinessResult = await readiness.check({
      colorMode: "BW",
      sides: "SINGLE",
      paperSize: "A3",
    });
    expect(readinessResult.ready).toBe(true);
    if (readinessResult.ready) {
      expect(readinessResult.printerId).toBe(ids.printerColor);
    }

    seedOrder({ colorMode: "BW", sides: "SINGLE", paperSize: "A3" });
    const claimedJob = await printRepo.claimOrRenew(ids.agent, nowMs);
    expect(claimedJob).not.toBeNull();
    expect(claimedJob?.printerId).toBe(ids.printerColor);
    expect(claimedJob?.paperSize).toBe("A3");

    // When the A3-capable printer is OFFLINE:
    db.prepare(`UPDATE printers SET status = 'OFFLINE' WHERE id = ?`).run(
      ids.printerColor,
    );
    db.prepare(
      `UPDATE orders SET status = 'QUEUED', claimed_by_agent_id = NULL, claim_id = NULL, claim_expires_at_ms = NULL, claimed_at_ms = NULL, printer_id = NULL WHERE id = ?`,
    ).run(ids.order);

    const offlineReadiness = await readiness.check({
      colorMode: "BW",
      sides: "SINGLE",
      paperSize: "A3",
    });
    expect(offlineReadiness.ready).toBe(false);
    if (!offlineReadiness.ready) {
      expect(offlineReadiness.reason).toBe("PAPER_SIZE_UNSUPPORTED");
    }

    const offlineClaim = await printRepo.claimOrRenew(ids.agent, nowMs);
    expect(offlineClaim).toBeNull();
  });

  it("PARITY TEST 10: Multi-file order capability-aware routing across files", async () => {
    seedPrinters({ monoStatus: "ONLINE", colorStatus: "ONLINE" });

    // Seed order with 2 files: File 1 is B&W, File 2 is Color
    db.prepare(
      `
      INSERT INTO orders (
        id, public_job_code, customer_name, customer_phone, original_filename,
        selected_pages, source_page_count, copies, color_mode, paper_size, sides,
        total_amount_paise, printing_amount_paise, status, cleanup_state,
        created_at_ms, updated_at_ms, paid_at_ms, queued_at_ms
      ) VALUES (?, 'PG-MULTIFILE01', 'Multi Test', '+919876543210', 'doc1.pdf',
        '1', 1, 1, 'BW', 'A4', 'SINGLE', 2000, 2000, 'QUEUED', 'ACTIVE', ?, ?, ?, ?)
    `,
    ).run(ids.order, nowMs, nowMs, nowMs, nowMs);

    // File 1: BW A4
    db.prepare(
      `
      INSERT INTO order_files (
        id, order_id, position, original_filename, r2_object_key, expected_size_bytes,
        size_bytes, mime_type, source_page_count, selected_pages, selected_page_count,
        copies, paper_size, color_mode, sides, printing_amount_paise, service_charge_paise,
        upload_status, print_status, uploaded_at_ms, created_at_ms, updated_at_ms
      ) VALUES (?, ?, 1, 'doc1.pdf', 'uploads/doc1.pdf', 1024, 1024, 'application/pdf',
        1, '1', 1, 1, 'A4', 'BW', 'SINGLE', 1000, 0, 'UPLOADED', 'PENDING', ?, ?, ?)
    `,
    ).run(ids.file1, ids.order, nowMs, nowMs, nowMs);

    // File 2: COLOR A4
    db.prepare(
      `
      INSERT INTO order_files (
        id, order_id, position, original_filename, r2_object_key, expected_size_bytes,
        size_bytes, mime_type, source_page_count, selected_pages, selected_page_count,
        copies, paper_size, color_mode, sides, printing_amount_paise, service_charge_paise,
        upload_status, print_status, uploaded_at_ms, created_at_ms, updated_at_ms
      ) VALUES (?, ?, 2, 'doc2.pdf', 'uploads/doc2.pdf', 1024, 1024, 'application/pdf',
        1, '1', 1, 1, 'A4', 'COLOR', 'SINGLE', 1000, 0, 'UPLOADED', 'PENDING', ?, ?, ?)
    `,
    ).run(ids.file2, ids.order, nowMs, nowMs, nowMs);

    db.prepare(
      `
      INSERT INTO uploads (
        id, order_id, r2_object_key, original_filename, size_bytes, mime_type,
        storage_status, created_at_ms, uploaded_at_ms, updated_at_ms, expected_size_bytes
      ) VALUES (?, ?, 'uploads/doc1.pdf', 'doc1.pdf', 1024, 'application/pdf', 'UPLOADED', ?, ?, ?, 1024)
    `,
    ).run(ids.upload, ids.order, nowMs, nowMs, nowMs);

    db.prepare(
      `
      INSERT INTO payments (
        id, order_id, provider_order_id, provider_payment_id, amount_paise,
        currency, status, verified_at_ms, created_at_ms, updated_at_ms
      ) VALUES (?, ?, 'order_razor_test', 'pay_razor_test', 2000, 'INR', 'PAID', ?, ?, ?)
    `,
    ).run(ids.payment, ids.order, nowMs, nowMs, nowMs);

    // 1. Claim File 1 (BW) -> claims on default Mono printer
    const claim1 = await printRepo.claimOrRenew(ids.agent, nowMs);
    expect(claim1).not.toBeNull();
    expect(claim1?.fileId).toBe(ids.file1);
    expect(claim1?.printerId).toBe(ids.printerMono);

    // 2. Simulate File 1 printed, order returns to QUEUED for remaining files
    db.prepare(
      `UPDATE order_files SET print_status = 'PRINTED' WHERE id = ?`,
    ).run(ids.file1);
    db.prepare(
      `UPDATE print_attempt_steps SET status = 'SUCCEEDED' WHERE id = ?`,
    ).run(claim1!.currentStep.stepId);
    db.prepare(
      `UPDATE print_attempts SET status = 'SUCCEEDED' WHERE id = ?`,
    ).run(claim1!.attemptId);
    db.prepare(
      `UPDATE orders SET status = 'QUEUED', claimed_by_agent_id = NULL, claim_id = NULL, claim_expires_at_ms = NULL, claimed_at_ms = NULL, printer_id = NULL WHERE id = ?`,
    ).run(ids.order);

    // 3. Claim File 2 (Color) -> claims on secondary Color printer
    const claim2 = await printRepo.claimOrRenew(ids.agent, nowMs + 1000);
    expect(claim2).not.toBeNull();
    expect(claim2?.fileId).toBe(ids.file2);
    expect(claim2?.printerId).toBe(ids.printerColor);
  });

  it("PARITY TEST 11: Config/status race condition fail-safe", async () => {
    seedPrinters({ monoStatus: "ONLINE" });
    seedOrder({ colorMode: "BW", sides: "SINGLE", paperSize: "A4" });

    // Simulate printer paused right before claim
    db.prepare(`UPDATE printers SET is_paused = 1 WHERE id = ?`).run(
      ids.printerMono,
    );

    const readinessResult = await readiness.check({
      colorMode: "BW",
      sides: "SINGLE",
      paperSize: "A4",
    });
    expect(readinessResult.ready).toBe(false);
    if (!readinessResult.ready) {
      expect(readinessResult.reason).toBe("PRINTER_UNAVAILABLE");
    }

    const claimedJob = await printRepo.claimOrRenew(ids.agent, nowMs);
    expect(claimedJob).toBeNull();
  });

  it("PARITY TEST 12: Existing single-printer installations backward compatibility", async () => {
    // Delete secondary printer to simulate existing single-printer shop
    db.prepare(`DELETE FROM printers WHERE id = ?`).run(ids.printerColor);
    seedPrinters({ monoStatus: "ONLINE" });
    // Remove printerColor again
    db.prepare(`DELETE FROM printers WHERE id = ?`).run(ids.printerColor);

    // B&W order succeeds
    const bwReadiness = await readiness.check({
      colorMode: "BW",
      sides: "SINGLE",
      paperSize: "A4",
    });
    expect(bwReadiness.ready).toBe(true);
    if (bwReadiness.ready) {
      expect(bwReadiness.printerId).toBe(ids.printerMono);
    }

    seedOrder({ colorMode: "BW", sides: "SINGLE", paperSize: "A4" });
    const claimedJob = await printRepo.claimOrRenew(ids.agent, nowMs);
    expect(claimedJob).not.toBeNull();
    expect(claimedJob?.printerId).toBe(ids.printerMono);

    // Color order on single-printer mono shop fails closed cleanly
    const colorReadiness = await readiness.check({
      colorMode: "COLOR",
      sides: "SINGLE",
      paperSize: "A4",
    });
    expect(colorReadiness.ready).toBe(false);
    if (!colorReadiness.ready) {
      expect(colorReadiness.reason).toBe("COLOR_MODE_UNSUPPORTED");
    }
  });
});
