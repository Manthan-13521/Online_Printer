import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";

import type { WorkerEnv } from "../env.js";
import { D1PaymentReadiness } from "../payments/readiness.js";
import { D1PrintingRepository } from "./repository.js";

// Statement wrapper for node:sqlite DatabaseSync to match Cloudflare D1
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

const AGENT_ID = "40000000-0000-4000-8000-000000000001";
const PRINTER_A_ID = "10000000-0000-4000-8000-00000000000A"; // HP Laser MFP 136w TEST
const PRINTER_B_ID = "20000000-0000-4000-8000-00000000000B"; // PrintGo Simulated Printer B

describe("TEST 3A: Intelligent Printer Priority Routing (Phase 3)", () => {
  let db: DatabaseSync;
  let d1: D1Database;
  let repo: D1PrintingRepository;
  let readiness: D1PaymentReadiness;

  const nowMs = 1_700_000_000_000;
  const env: WorkerEnv = {
    APP_ENV: "production",
    PAYMENT_READINESS_DEV_BYPASS: "false",
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
    repo = new D1PrintingRepository(d1);
    readiness = new D1PaymentReadiness(d1, env, () => nowMs);
  });

  function seedAgentAndPrinters(opts?: {
    printerAPriority?: number;
    printerBPriority?: number;
    printerAEnabled?: number;
    printerBEnabled?: number;
    printerAStatus?: string;
    printerBStatus?: string;
    printerAPaused?: number;
    printerBPaused?: number;
    printerARequiresReview?: number;
    defaultPrinterId?: string | null;
    autoFallbackEnabled?: number;
    fallbackPrinterId?: string | null;
    printerAPhysicalDeviceId?: string | null;
    printerBPhysicalDeviceId?: string | null;
  }) {
    // 1. Installation
    const defaultPrinter =
      opts?.defaultPrinterId !== undefined
        ? opts.defaultPrinterId
        : PRINTER_A_ID;

    db.prepare(
      `INSERT INTO installation (
        id, app_name, shop_name, contact_phone, address, customer_notice,
        online_printing_enabled, default_production_printer_id,
        max_pdf_size_bytes, max_order_upload_bytes,
        identification_sheet_enabled, identification_sheet_placement,
        created_at_ms, updated_at_ms
      ) VALUES (1, 'PrintGo', 'PrintGo Routing Lab', '+919876543210', 'Shop 12', 'Test Mode', 1, ?, 26214400, 52428800, 0, 'LAST', ?, ?)`,
    ).run(defaultPrinter, nowMs, nowMs);

    // 2. Active Agent
    db.prepare(
      `INSERT INTO agents (
        id, display_name, credential_hash, is_active, paired_at_ms,
        last_heartbeat_at_ms, created_at_ms, updated_at_ms
      ) VALUES (?, 'HP Windows Agent', 'hash-test', 1, ?, ?, ?, ?)`,
    ).run(AGENT_ID, nowMs, nowMs, nowMs, nowMs);

    // 3. Printer A: HP Laser MFP 136w TEST (A4, B&W, Single-sided ONLY)
    const pAPriority = opts?.printerAPriority ?? 10;
    const pAEnabled = opts?.printerAEnabled ?? 1;
    const pAStatus = opts?.printerAStatus ?? "ONLINE";
    const pAPaused = opts?.printerAPaused ?? 0;
    const pAReqReview = opts?.printerARequiresReview ?? 0;
    const pAFallback =
      opts?.fallbackPrinterId !== undefined
        ? opts.fallbackPrinterId
        : PRINTER_B_ID;
    const pAAutoFallback = opts?.autoFallbackEnabled ?? 1;
    const pAPhysicalDev =
      opts?.printerAPhysicalDeviceId !== undefined
        ? opts.printerAPhysicalDeviceId
        : "HP_PHYSICAL_DEVICE_136W";

    db.prepare(
      `INSERT INTO printers (
        id, agent_id, display_name, windows_printer_name, enabled, status,
        is_paused, paused_reason, is_production_eligible, is_virtual, priority,
        physical_device_id, fallback_printer_id, auto_fallback_enabled,
        capabilities_json, verified_capabilities_json, enabled_services_json,
        last_status_at_ms, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      PRINTER_A_ID,
      AGENT_ID,
      "HP Laser MFP 136w TEST",
      "HP Laser MFP 136w",
      pAEnabled,
      pAStatus,
      pAPaused,
      pAPaused ? "PAPER_JAM" : null,
      pAPriority,
      pAPhysicalDev,
      pAFallback,
      pAAutoFallback,
      JSON.stringify({ colour: false, duplex: false, paperSizes: ["A4"] }),
      JSON.stringify({
        verified: { bw: 1, color: 0, duplex: 0, a4: 1, a3: 0 },
        enabled: { bw: 1, color: 0, duplex: 0, a4: 1, a3: 0 },
        requiresReview: pAReqReview,
      }),
      JSON.stringify({ bw: 1, color: 0, duplex: 0, a4: 1, a3: 0 }),
      nowMs,
      nowMs,
      nowMs,
    );

    // 4. Printer B: PrintGo Simulated Printer B (A4, A3, Color, Duplex supported)
    const pBPriority = opts?.printerBPriority ?? 5;
    const pBEnabled = opts?.printerBEnabled ?? 1;
    const pBStatus = opts?.printerBStatus ?? "ONLINE";
    const pBPaused = opts?.printerBPaused ?? 0;
    const pBPhysicalDev =
      opts?.printerBPhysicalDeviceId !== undefined
        ? opts.printerBPhysicalDeviceId
        : "SIMULATED_PHYSICAL_DEVICE_B";

    db.prepare(
      `INSERT INTO printers (
        id, agent_id, display_name, windows_printer_name, enabled, status,
        is_paused, paused_reason, is_production_eligible, is_virtual, priority,
        physical_device_id, fallback_printer_id, auto_fallback_enabled,
        capabilities_json, verified_capabilities_json, enabled_services_json,
        last_status_at_ms, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, NULL, 0, ?, ?, ?, ?, ?, ?)`,
    ).run(
      PRINTER_B_ID,
      AGENT_ID,
      "PrintGo Simulated Printer B",
      "PrintGo Simulated B",
      pBEnabled,
      pBStatus,
      pBPaused,
      pBPaused ? "PAUSED_BY_USER" : null,
      pBPriority,
      pBPhysicalDev,
      JSON.stringify({ colour: true, duplex: true, paperSizes: ["A4", "A3"] }),
      JSON.stringify({
        verified: { bw: 1, color: 1, duplex: 1, a4: 1, a3: 1 },
        enabled: { bw: 1, color: 1, duplex: 1, a4: 1, a3: 1 },
        requiresReview: 0,
      }),
      JSON.stringify({ bw: 1, color: 1, duplex: 1, a4: 1, a3: 1 }),
      nowMs,
      nowMs,
      nowMs,
    );
  }

  function seedPaidOrder(
    orderId: string,
    opts?: {
      colorMode?: "BW" | "COLOR";
      sides?: "SINGLE" | "DOUBLE";
      paperSize?: "A4" | "A3";
      printerId?: string | null;
      queuedAtMs?: number;
      isPriority?: boolean;
    },
  ) {
    const colorMode = opts?.colorMode ?? "BW";
    const sides = opts?.sides ?? "SINGLE";
    const paperSize = opts?.paperSize ?? "A4";
    const queuedAt = opts?.queuedAtMs ?? nowMs;
    const isPriority = opts?.isPriority ? 1 : 0;
    const assignedPrinterId = opts?.printerId ?? null;
    const fileId = crypto.randomUUID();
    const upId = crypto.randomUUID();
    const payId = crypto.randomUUID();

    db.prepare(
      `INSERT INTO orders (
        id, public_job_code, pickup_code, customer_name, customer_phone,
        original_filename, color_mode, paper_size, sides,
        printing_amount_paise, service_charge_paise, total_amount_paise,
        status, cleanup_state, is_priority, printer_id,
        created_at_ms, updated_at_ms, paid_at_ms, queued_at_ms
      ) VALUES (
        ?, ?, ?, 'Test Customer', '9876543210',
        'sample.pdf', ?, ?, ?,
        1000, 0, 1000,
        'QUEUED', 'ACTIVE', ?, ?,
        ?, ?, ?, ?
      )`,
    ).run(
      orderId,
      `JOB-${orderId.slice(-6)}`,
      `PU-${orderId.slice(-6)}`,
      colorMode,
      paperSize,
      sides,
      isPriority,
      assignedPrinterId,
      queuedAt,
      queuedAt,
      queuedAt,
      queuedAt,
    );

    db.prepare(
      `INSERT INTO order_files (
        id, order_id, position, original_filename, r2_object_key,
        expected_size_bytes, size_bytes, uploaded_at_ms, source_page_count, selected_pages, copies,
        color_mode, paper_size, sides, upload_status, created_at_ms, updated_at_ms
      ) VALUES (
        ?, ?, 1, 'sample.pdf', ?,
        1024, 1024, ?, 1, 'ALL', 1,
        ?, ?, ?, 'UPLOADED', ?, ?
      )`,
    ).run(
      fileId,
      orderId,
      `uploads/${orderId}/sample.pdf`,
      queuedAt,
      colorMode,
      paperSize,
      sides,
      queuedAt,
      queuedAt,
    );

    db.prepare(
      `INSERT INTO uploads (
        id, order_id, r2_object_key, original_filename, mime_type,
        size_bytes, storage_status, created_at_ms, uploaded_at_ms, updated_at_ms, expected_size_bytes
      ) VALUES (
        ?, ?, ?, 'sample.pdf', 'application/pdf',
        1024, 'UPLOADED', ?, ?, ?, 1024
      )`,
    ).run(
      upId,
      orderId,
      `uploads/${orderId}/sample.pdf`,
      queuedAt,
      queuedAt,
      queuedAt,
    );

    db.prepare(
      `INSERT INTO payments (
        id, order_id, amount_paise, currency, status,
        provider, provider_order_id, provider_payment_id,
        created_at_ms, updated_at_ms, verified_at_ms
      ) VALUES (
        ?, ?, 1000, 'INR', 'PAID',
        'RAZORPAY', ?, ?,
        ?, ?, ?
      )`,
    ).run(
      payId,
      orderId,
      `order_rzp_${orderId.slice(-8)}`,
      `pay_rzp_${orderId.slice(-8)}`,
      queuedAt,
      queuedAt,
      queuedAt,
    );
  }

  // --------------------------------------------------------------------------
  // TEST 3A.1: Higher priority wins
  // Printer A (priority 10) vs Printer B (priority 5) -> Printer A selected
  // --------------------------------------------------------------------------
  it("3A.1 — Higher priority wins: Printer A (10) vs Printer B (5) selects Printer A", async () => {
    seedAgentAndPrinters({
      printerAPriority: 10,
      printerBPriority: 5,
      defaultPrinterId: null, // Test pure priority resolution
    });

    const orderId = "30000000-0000-4000-8000-000000000001";
    seedPaidOrder(orderId, { colorMode: "BW", sides: "SINGLE" });

    const claim = await repo.claimOrRenew(AGENT_ID, nowMs);
    expect(claim).not.toBeNull();
    expect(claim?.orderId).toBe(orderId);
    expect(claim?.printerId).toBe(PRINTER_A_ID);
  });

  // --------------------------------------------------------------------------
  // TEST 3A.2: Reverse priority
  // Printer A (priority 5) vs Printer B (priority 10) -> Printer B selected
  // --------------------------------------------------------------------------
  it("3A.2 — Reverse priority: Printer A (5) vs Printer B (10) selects Printer B", async () => {
    seedAgentAndPrinters({
      printerAPriority: 5,
      printerBPriority: 10,
      defaultPrinterId: null, // Pure priority selection
    });

    const orderId = "30000000-0000-4000-8000-000000000002";
    seedPaidOrder(orderId, { colorMode: "BW", sides: "SINGLE" });

    const claim = await repo.claimOrRenew(AGENT_ID, nowMs);
    expect(claim).not.toBeNull();
    expect(claim?.orderId).toBe(orderId);
    expect(claim?.printerId).toBe(PRINTER_B_ID);
  });

  // --------------------------------------------------------------------------
  // TEST 3A.3: Preferred printer disabled
  // Printer A (priority 10, enabled=0) vs Printer B (priority 5, enabled=1) -> Printer B selected
  // --------------------------------------------------------------------------
  it("3A.3 — Preferred printer disabled: skips disabled Printer A and routes to Printer B", async () => {
    seedAgentAndPrinters({
      printerAPriority: 10,
      printerAEnabled: 0, // Disabled
      printerBPriority: 5,
      printerBEnabled: 1,
      defaultPrinterId: null,
    });

    const orderId = "30000000-0000-4000-8000-000000000003";
    seedPaidOrder(orderId, { colorMode: "BW", sides: "SINGLE" });

    const claim = await repo.claimOrRenew(AGENT_ID, nowMs);
    expect(claim).not.toBeNull();
    expect(claim?.orderId).toBe(orderId);
    expect(claim?.printerId).toBe(PRINTER_B_ID);
  });

  // --------------------------------------------------------------------------
  // TEST 3A.4: Preferred printer offline
  // Printer A (priority 10, OFFLINE) with auto-fallback -> Printer B selected
  // Without auto-fallback -> Claim fails closed
  // --------------------------------------------------------------------------
  it("3A.4 — Preferred printer offline: routes to Printer B via fallback; fails closed without fallback", async () => {
    // Case 1: Primary Printer A is default and OFFLINE, with auto-fallback to Printer B
    seedAgentAndPrinters({
      printerAPriority: 10,
      printerAStatus: "OFFLINE",
      printerBPriority: 5,
      printerBStatus: "ONLINE",
      defaultPrinterId: PRINTER_A_ID,
      autoFallbackEnabled: 1,
      fallbackPrinterId: PRINTER_B_ID,
    });

    const orderId = "30000000-0000-4000-8000-000000000004";
    seedPaidOrder(orderId, { colorMode: "BW", sides: "SINGLE" });

    // Payment preflight readiness check verifies fallback target
    const readinessResult = await readiness.check({
      paperSize: "A4",
      colorMode: "BW",
      sides: "SINGLE",
    });
    expect(readinessResult).toEqual({
      ready: true,
      source: "LIVE_AGENT",
      printerId: PRINTER_B_ID,
    });

    // Worker claim routing verifies fallback assignment
    const claim = await repo.claimOrRenew(AGENT_ID, nowMs);
    expect(claim).not.toBeNull();
    expect(claim?.printerId).toBe(PRINTER_B_ID);

    // Complete first order so agent is free for the unassigned claim check
    db.prepare(
      `UPDATE orders SET status = 'COMPLETED', claimed_by_agent_id = NULL, claim_id = NULL, claim_expires_at_ms = NULL WHERE id = ?`,
    ).run(orderId);

    // Case 2: Primary Printer A is OFFLINE and auto-fallback is disabled -> fails closed
    db.prepare(
      `UPDATE printers SET auto_fallback_enabled = 0 WHERE id = ?`,
    ).run(PRINTER_A_ID);
    const unassignedOrderId = "30000000-0000-4000-8000-00000000004B";
    seedPaidOrder(unassignedOrderId, { colorMode: "BW", sides: "SINGLE" });

    const unassignedClaim = await repo.claimOrRenew(AGENT_ID, nowMs + 1000);
    // Cannot claim on offline printer with fallback disabled
    expect(unassignedClaim).toBeNull();
  });

  // --------------------------------------------------------------------------
  // TEST 3A.5: Preferred printer paused
  // Printer A (priority 10, is_paused=1) with auto-fallback -> Printer B selected
  // --------------------------------------------------------------------------
  it("3A.5 — Preferred printer paused: routes to Printer B when primary is paused", async () => {
    seedAgentAndPrinters({
      printerAPriority: 10,
      printerAStatus: "ONLINE",
      printerAPaused: 1, // Paused (paper jam)
      printerBPriority: 5,
      printerBStatus: "ONLINE",
      printerBPaused: 0,
      defaultPrinterId: PRINTER_A_ID,
      autoFallbackEnabled: 1,
      fallbackPrinterId: PRINTER_B_ID,
    });

    const orderId = "30000000-0000-4000-8000-000000000005";
    seedPaidOrder(orderId, { colorMode: "BW", sides: "SINGLE" });

    // Readiness verifies fallback
    const readinessResult = await readiness.check({
      paperSize: "A4",
      colorMode: "BW",
      sides: "SINGLE",
    });
    expect(readinessResult).toEqual({
      ready: true,
      source: "LIVE_AGENT",
      printerId: PRINTER_B_ID,
    });

    // Claim engine claims Printer B
    const claim = await repo.claimOrRenew(AGENT_ID, nowMs);
    expect(claim).not.toBeNull();
    expect(claim?.printerId).toBe(PRINTER_B_ID);
  });

  // --------------------------------------------------------------------------
  // TEST 3A.6: Preferred printer incompatible
  // Order requires COLOR, Printer A (mono only) -> Smart capability routing selects Printer B
  // --------------------------------------------------------------------------
  it("3A.6 — Preferred printer incompatible: skips mono Printer A and selects color-capable Printer B", async () => {
    seedAgentAndPrinters({
      printerAPriority: 10, // Higher priority but MONO only
      printerBPriority: 5, // Lower priority but COLOR capable
      defaultPrinterId: PRINTER_A_ID,
    });

    const orderId = "30000000-0000-4000-8000-000000000006";
    // Color order
    seedPaidOrder(orderId, { colorMode: "COLOR", sides: "SINGLE" });

    // Readiness preflight checks capability routing
    const readinessResult = await readiness.check({
      paperSize: "A4",
      colorMode: "COLOR",
      sides: "SINGLE",
    });
    expect(readinessResult).toEqual({
      ready: true,
      source: "LIVE_AGENT",
      printerId: PRINTER_B_ID,
    });

    // Subcase B1 capability routing in claim engine selects Printer B
    const claim = await repo.claimOrRenew(AGENT_ID, nowMs);
    expect(claim).not.toBeNull();
    expect(claim?.orderId).toBe(orderId);
    expect(claim?.printerId).toBe(PRINTER_B_ID);
  });

  // --------------------------------------------------------------------------
  // TEST 3A.7: Both printers unavailable
  // Both offline / disabled / paused -> Fails closed, claim is null
  // --------------------------------------------------------------------------
  it("3A.7 — Both printers unavailable: fails closed with no claim and PRINTER_UNAVAILABLE", async () => {
    seedAgentAndPrinters({
      printerAPriority: 10,
      printerAStatus: "OFFLINE",
      printerBPriority: 5,
      printerBStatus: "OFFLINE",
      defaultPrinterId: PRINTER_A_ID,
    });

    const orderId = "30000000-0000-4000-8000-000000000007";
    seedPaidOrder(orderId, { colorMode: "BW", sides: "SINGLE" });

    // Readiness returns failure
    const readinessResult = await readiness.check({
      paperSize: "A4",
      colorMode: "BW",
      sides: "SINGLE",
    });
    expect(readinessResult.ready).toBe(false);
    if (!readinessResult.ready) {
      expect(readinessResult.reason).toBe("PRINTER_UNAVAILABLE");
    }

    // Claim returns null
    const claim = await repo.claimOrRenew(AGENT_ID, nowMs);
    expect(claim).toBeNull();
  });

  // --------------------------------------------------------------------------
  // TEST 3A.8: Equal priority deterministic tie-breaking
  // Printer A (priority 10) vs Printer B (priority 10) -> Deterministic tie-break by id ASC
  // --------------------------------------------------------------------------
  it("3A.8 — Equal priority: resolves deterministically using id ASC", async () => {
    seedAgentAndPrinters({
      printerAPriority: 10,
      printerBPriority: 10,
      defaultPrinterId: null, // Pure priority and tie-breaking test
    });

    const orderId = "30000000-0000-4000-8000-000000000008";
    seedPaidOrder(orderId, { colorMode: "BW", sides: "SINGLE" });

    // PRINTER_A_ID ("1000...") < PRINTER_B_ID ("2000...")
    const claim = await repo.claimOrRenew(AGENT_ID, nowMs);
    expect(claim).not.toBeNull();
    expect(claim?.printerId).toBe(PRINTER_A_ID);
  });

  // --------------------------------------------------------------------------
  // TEST 3A.9: Stale / unverified capabilities
  // Printer A (priority 10, requiresReview=1) -> Skipped, Printer B (priority 5) selected
  // --------------------------------------------------------------------------
  it("3A.9 — Stale capabilities: rejects printer with requiresReview=1 and routes to verified Printer B", async () => {
    seedAgentAndPrinters({
      printerAPriority: 10,
      printerARequiresReview: 1, // Stale capabilities flag set
      printerBPriority: 5,
      defaultPrinterId: null,
    });

    const orderId = "30000000-0000-4000-8000-000000000009";
    seedPaidOrder(orderId, { colorMode: "BW", sides: "SINGLE" });

    const claim = await repo.claimOrRenew(AGENT_ID, nowMs);
    expect(claim).not.toBeNull();
    expect(claim?.orderId).toBe(orderId);
    // Printer A rejected by requiresReview NOT IN (1, 'true'), Printer B selected
    expect(claim?.printerId).toBe(PRINTER_B_ID);
  });

  // --------------------------------------------------------------------------
  // TEST 3A.10: Repeated routing determinism
  // Repeated claim/renew calls remain strictly deterministic with zero duplicate claims
  // --------------------------------------------------------------------------
  it("3A.10 — Repeated routing: identical inputs produce deterministic claim renewal with zero duplicates", async () => {
    seedAgentAndPrinters({
      printerAPriority: 10,
      printerBPriority: 5,
      defaultPrinterId: null,
    });

    const orderId = "30000000-0000-4000-8000-000000000010";
    seedPaidOrder(orderId, { colorMode: "BW", sides: "SINGLE" });

    // First claim
    const firstClaim = await repo.claimOrRenew(AGENT_ID, nowMs);
    expect(firstClaim).not.toBeNull();
    expect(firstClaim?.orderId).toBe(orderId);
    expect(firstClaim?.printerId).toBe(PRINTER_A_ID);
    const initialClaimId = firstClaim?.claimId;

    // Subsequent claim pulse from same agent (within lease window) renews the exact same order
    const secondClaim = await repo.claimOrRenew(AGENT_ID, nowMs + 20_000);
    expect(secondClaim).not.toBeNull();
    expect(secondClaim?.orderId).toBe(orderId);
    expect(secondClaim?.printerId).toBe(PRINTER_A_ID);
    expect(secondClaim?.claimId).toBe(initialClaimId);

    // Verify order count in database: exactly 1 order, status is CLAIMED
    const orderRows = db
      .prepare(`SELECT status, claim_id FROM orders WHERE id = ?`)
      .all(orderId) as Array<{ status: string; claim_id: string }>;
    expect(orderRows.length).toBe(1);
    expect(orderRows[0]?.status).toBe("CLAIMED");
  });

  // --------------------------------------------------------------------------
  // TEST 3A.11: Concurrent claim race
  // Two parallel claim attempts on the same queued order -> Exactly one succeeds, zero duplicate prints
  // --------------------------------------------------------------------------
  it("3A.11 — Concurrent claim race: atomic claim ensures exactly one valid claim and zero duplicates", async () => {
    seedAgentAndPrinters({
      printerAPriority: 10,
      printerBPriority: 5,
      defaultPrinterId: null,
    });

    const orderId = "30000000-0000-4000-8000-000000000011";
    seedPaidOrder(orderId, { colorMode: "BW", sides: "SINGLE" });

    // Execute two concurrent claimOrRenew calls
    const [claim1, claim2] = await Promise.all([
      repo.claimOrRenew(AGENT_ID, nowMs),
      repo.claimOrRenew(AGENT_ID, nowMs),
    ]);

    // Both promises resolve, but exactly one unique order lease was created
    expect(claim1).not.toBeNull();
    expect(claim1?.orderId).toBe(orderId);

    // Second call either renewed the exact same claim or returned the same active claim
    if (claim2) {
      expect(claim2.orderId).toBe(orderId);
      expect(claim2.claimId).toBe(claim1?.claimId);
    }

    // Verify print_attempts table: exactly 1 attempt record created for this claim
    const attempts = db
      .prepare(
        `SELECT id, attempt_number FROM print_attempts WHERE order_id = ?`,
      )
      .all(orderId) as Array<{ id: string; attempt_number: number }>;
    expect(attempts.length).toBe(1);
    expect(attempts[0]?.attempt_number).toBe(1);
  });

  // --------------------------------------------------------------------------
  // TEST 3A.12: Shared physical-device lock serialization
  // Two logical printers sharing physical_device_id cannot print concurrently
  // --------------------------------------------------------------------------
  it("3A.12 — Shared physical-device lock: serializes execution when two printers share hardware ID", async () => {
    const SHARED_HARDWARE_ID = "PHYSICAL_HW_HP_SHARED_01";
    seedAgentAndPrinters({
      printerAPriority: 10,
      printerBPriority: 5,
      defaultPrinterId: null,
      printerAPhysicalDeviceId: SHARED_HARDWARE_ID,
      printerBPhysicalDeviceId: SHARED_HARDWARE_ID, // Both map to the same physical hardware!
    });

    const order1 = "30000000-0000-4000-8000-000000000012";
    const order2 = "30000000-0000-4000-8000-000000000013";
    seedPaidOrder(order1, { colorMode: "BW", queuedAtMs: nowMs - 5000 });
    seedPaidOrder(order2, { colorMode: "BW", queuedAtMs: nowMs });

    // 1. Attempt to claim all jobs for the agent:
    // Because both Printer A and Printer B share SHARED_HARDWARE_ID,
    // exactly 1 job (Order 1 on highest priority Printer A) is claimed.
    // Order 2 cannot be claimed concurrently because the physical device lock is active!
    const activeJobs = await repo.claimOrRenewAll(AGENT_ID, nowMs);
    expect(activeJobs).toHaveLength(1);
    expect(activeJobs[0]?.orderId).toBe(order1);
    expect(activeJobs[0]?.printerId).toBe(PRINTER_A_ID);
    expect(activeJobs[0]?.physicalDeviceId).toBe(SHARED_HARDWARE_ID);

    // 2. Order 2 remains safely queued (blocked by physical device lock)
    const ord2Row = db
      .prepare(`SELECT status FROM orders WHERE id = ?`)
      .get(order2) as { status: string } | undefined;
    expect(ord2Row?.status).toBe("QUEUED");

    // 3. Mark Order 1 completed, releasing the physical hardware lock
    db.prepare(
      `UPDATE orders SET status = 'COMPLETED', claimed_by_agent_id = NULL, claim_id = NULL, claim_expires_at_ms = NULL WHERE id = ?`,
    ).run(order1);

    // 4. Next pulse claims Order 2 now that the physical device is unlocked
    const nextJobs = await repo.claimOrRenewAll(AGENT_ID, nowMs + 2000);
    expect(nextJobs).toHaveLength(1);
    expect(nextJobs[0]?.orderId).toBe(order2);
    expect(nextJobs[0]?.printerId).toBe(PRINTER_A_ID);
  });
});
