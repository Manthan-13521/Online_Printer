import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";

import { D1PrintingRepository } from "./repository.js";
import { D1AgentRepository } from "../agent/repository.js";

// Statement wrapper for node:sqlite DatabaseSync to match Cloudflare D1 with query counting
class StatementWrapper {
  private bindings: SQLInputValue[] = [];
  constructor(
    private readonly db: DatabaseSync,
    readonly sql: string,
    private readonly stats?: { reads: number; writes: number; queries: number },
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
    if (this.stats) {
      this.stats.queries++;
      this.stats.reads++;
    }
    const row = this.db.prepare(this.sql).get(...this.bindings) as
      T | undefined;
    return Promise.resolve(row ?? null);
  }

  all<T>(): Promise<D1Result<T>> {
    if (this.stats) {
      this.stats.queries++;
      this.stats.reads++;
    }
    const results = this.db.prepare(this.sql).all(...this.bindings) as T[];
    return Promise.resolve({
      success: true,
      meta: { changes: 0 },
      results,
    } as unknown as D1Result<T>);
  }

  run(): Promise<D1Result> {
    const result = this.db.prepare(this.sql).run(...this.bindings);
    if (this.stats) {
      this.stats.queries++;
      this.stats.writes += Number(result.changes);
    }
    return Promise.resolve({
      success: true,
      meta: { changes: Number(result.changes) },
      results: [],
    } as unknown as D1Result);
  }
}

function asD1(
  db: DatabaseSync,
  stats?: { reads: number; writes: number; queries: number },
): D1Database {
  let batchLock: Promise<void> = Promise.resolve();
  return {
    prepare: (sql: string) => new StatementWrapper(db, sql, stats),
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
const ADMIN_ID = "adm_test_principal_001";

// Five Isolated Virtual Printers
const PRINTER_A_ID = "10000000-0000-4000-8000-00000000000A"; // B&W Simplex
const PRINTER_B_ID = "20000000-0000-4000-8000-00000000000B"; // B&W Duplex
const PRINTER_C_ID = "30000000-0000-4000-8000-00000000000C"; // Color Simplex
const PRINTER_D_ID = "40000000-0000-4000-8000-00000000000D"; // Color Duplex
const PRINTER_E_ID = "50000000-0000-4000-8000-00000000000E"; // Color Duplex All Modes + A3

interface OrderSpec {
  orderId: string;
  colorMode: "BW" | "COLOR";
  sides: "SINGLE" | "DOUBLE";
  paperSize: "A4" | "A3";
  isPriority: boolean;
  copies: number;
  pages: number;
  queuedAtMs: number;
}

describe("PRINTGO V2: 5-Printer Stress, Routing & Reliability Simulation", () => {
  let db: DatabaseSync;
  let d1: D1Database;
  let repo: D1PrintingRepository;
  let agentRepo: D1AgentRepository;
  let d1Stats: { reads: number; writes: number; queries: number };

  const BASE_NOW_MS = 1_700_000_000_000;

  beforeEach(() => {
    d1Stats = { reads: 0, writes: 0, queries: 0 };
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

    d1 = asD1(db, d1Stats);
    repo = new D1PrintingRepository(d1);
    agentRepo = new D1AgentRepository(d1);
  });

  function seedShopAndFivePrinters(opts?: {
    printerAStatus?: string;
    printerBStatus?: string;
    printerCStatus?: string;
    printerDStatus?: string;
    printerEStatus?: string;
    printerAPaused?: number;
    printerBPaused?: number;
    printerCPaused?: number;
    printerDPaused?: number;
    printerEPaused?: number;
    printerAPausedReason?: string | null;
    printerBPausedReason?: string | null;
    agentActive?: number;
    agentLastHeartbeatMs?: number;
  }) {
    const nowMs = BASE_NOW_MS;

    // 1. Installation: Default production printer is Printer A (B&W Simplex)
    db.prepare(
      `INSERT INTO installation (
        id, app_name, shop_name, contact_phone, address, customer_notice,
        online_printing_enabled, default_production_printer_id,
        max_pdf_size_bytes, max_order_upload_bytes,
        identification_sheet_enabled, identification_sheet_placement,
        created_at_ms, updated_at_ms
      ) VALUES (1, 'PrintGo', 'PrintGo 5-Printer Sim Lab', '+919876543210', 'Shop Floor', 'Testing', 1, ?, 26214400, 52428800, 0, 'LAST', ?, ?)`,
    ).run(PRINTER_A_ID, nowMs, nowMs);

    // 2. Windows Agent
    db.prepare(
      `INSERT INTO agents (
        id, display_name, credential_hash, is_active, paired_at_ms,
        last_heartbeat_at_ms, created_at_ms, updated_at_ms
      ) VALUES (?, 'PrintGo Core Agent', 'hash-test', ?, ?, ?, ?, ?)`,
    ).run(
      AGENT_ID,
      opts?.agentActive ?? 1,
      nowMs,
      opts?.agentLastHeartbeatMs ?? nowMs,
      nowMs,
      nowMs,
    );

    // Helper to insert a printer with verified capabilities
    const insertPrinter = (
      id: string,
      name: string,
      winName: string,
      priority: number,
      physDev: string,
      status: string,
      isPaused: number,
      pausedReason: string | null,
      caps: { colour: boolean; duplex: boolean; paperSizes: string[] },
      verified: {
        bw: number;
        color: number;
        duplex: number;
        a4: number;
        a3: number;
      },
    ) => {
      db.prepare(
        `INSERT INTO printers (
          id, agent_id, display_name, windows_printer_name, enabled, status, status_reason,
          is_paused, paused_reason, is_production_eligible, is_virtual, priority,
          physical_device_id, fallback_printer_id, auto_fallback_enabled,
          port_name, driver_name,
          capabilities_json, verified_capabilities_json, enabled_services_json,
          last_status_at_ms, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, 1, 0, ?, ?, NULL, 1, 'USB001', 'Generic', ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        AGENT_ID,
        name,
        winName,
        status,
        pausedReason,
        isPaused,
        pausedReason,
        priority,
        physDev,
        JSON.stringify(caps),
        JSON.stringify({ verified, enabled: verified, requiresReview: false }),
        JSON.stringify(verified),
        nowMs,
        nowMs,
        nowMs,
      );
    };

    // Printer A: B&W Simplex, Priority 50 (simplest)
    insertPrinter(
      PRINTER_A_ID,
      "Printer A (B&W Simplex)",
      "Printer_A_BW_Simplex",
      50,
      "PHYS_DEV_A",
      opts?.printerAStatus ?? "ONLINE",
      opts?.printerAPaused ?? 0,
      opts?.printerAPausedReason ?? null,
      { colour: false, duplex: false, paperSizes: ["A4"] },
      { bw: 1, color: 0, duplex: 0, a4: 1, a3: 0 },
    );

    // Printer B: B&W Duplex, Priority 40
    insertPrinter(
      PRINTER_B_ID,
      "Printer B (B&W Duplex)",
      "Printer_B_BW_Duplex",
      40,
      "PHYS_DEV_B",
      opts?.printerBStatus ?? "ONLINE",
      opts?.printerBPaused ?? 0,
      opts?.printerBPausedReason ?? null,
      { colour: false, duplex: true, paperSizes: ["A4"] },
      { bw: 1, color: 0, duplex: 1, a4: 1, a3: 0 },
    );

    // Printer C: Color Simplex, Priority 30
    insertPrinter(
      PRINTER_C_ID,
      "Printer C (Color Simplex)",
      "Printer_C_Color_Simplex",
      30,
      "PHYS_DEV_C",
      opts?.printerCStatus ?? "ONLINE",
      opts?.printerCPaused ?? 0,
      null,
      { colour: true, duplex: false, paperSizes: ["A4"] },
      { bw: 1, color: 1, duplex: 0, a4: 1, a3: 0 },
    );

    // Printer D: Color Duplex, Priority 20
    insertPrinter(
      PRINTER_D_ID,
      "Printer D (Color Duplex)",
      "Printer_D_Color_Duplex",
      20,
      "PHYS_DEV_D",
      opts?.printerDStatus ?? "ONLINE",
      opts?.printerDPaused ?? 0,
      null,
      { colour: true, duplex: true, paperSizes: ["A4"] },
      { bw: 1, color: 1, duplex: 1, a4: 1, a3: 0 },
    );

    // Printer E: Color Duplex All Modes + A3, Priority 10
    insertPrinter(
      PRINTER_E_ID,
      "Printer E (All Modes + A3)",
      "Printer_E_All_Modes_A3",
      10,
      "PHYS_DEV_E",
      opts?.printerEStatus ?? "ONLINE",
      opts?.printerEPaused ?? 0,
      null,
      { colour: true, duplex: true, paperSizes: ["A4", "A3"] },
      { bw: 1, color: 1, duplex: 1, a4: 1, a3: 1 },
    );
  }

  function seedPaidOrder(spec: OrderSpec) {
    db.prepare(
      `INSERT INTO orders (
        id, public_job_code, pickup_code, customer_name, customer_phone,
        original_filename, color_mode, paper_size, sides,
        printing_amount_paise, service_charge_paise, total_amount_paise,
        status, cleanup_state, is_priority, printer_id,
        created_at_ms, updated_at_ms, paid_at_ms, queued_at_ms
      ) VALUES (
        ?, ?, ?, 'Customer', '9876543210',
        'doc.pdf', ?, ?, ?,
        1000, 0, 1000,
        'QUEUED', 'ACTIVE', ?, NULL,
        ?, ?, ?, ?
      )`,
    ).run(
      spec.orderId,
      `JOB-${spec.orderId.slice(-6)}`,
      `PU-${spec.orderId.slice(-6)}`,
      spec.colorMode,
      spec.paperSize,
      spec.sides,
      spec.isPriority ? 1 : 0,
      spec.queuedAtMs,
      spec.queuedAtMs,
      spec.queuedAtMs,
      spec.queuedAtMs,
    );

    const fileId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO order_files (
        id, order_id, position, original_filename, r2_object_key,
        expected_size_bytes, size_bytes, uploaded_at_ms, source_page_count, selected_pages, copies,
        color_mode, paper_size, sides, upload_status, print_status, created_at_ms, updated_at_ms
      ) VALUES (
        ?, ?, 1, 'doc.pdf', ?,
        1024, 1024, ?, ?, 'ALL', ?,
        ?, ?, ?, 'UPLOADED', 'PENDING', ?, ?
      )`,
    ).run(
      fileId,
      spec.orderId,
      `uploads/${spec.orderId}/file-1.pdf`,
      spec.queuedAtMs,
      spec.pages,
      spec.copies,
      spec.colorMode,
      spec.paperSize,
      spec.sides,
      spec.queuedAtMs,
      spec.queuedAtMs,
    );

    db.prepare(
      `INSERT INTO uploads (
        id, order_id, r2_object_key, original_filename, mime_type,
        size_bytes, storage_status, created_at_ms, uploaded_at_ms, updated_at_ms, expected_size_bytes
      ) VALUES (
        ?, ?, ?, 'doc.pdf', 'application/pdf',
        1024, 'UPLOADED', ?, ?, ?, 1024
      )`,
    ).run(
      crypto.randomUUID(),
      spec.orderId,
      `uploads/${spec.orderId}/file-1.pdf`,
      spec.queuedAtMs,
      spec.queuedAtMs,
      spec.queuedAtMs,
    );

    db.prepare(
      `INSERT INTO payments (
        id, order_id, provider, provider_order_id, provider_payment_id, amount_paise,
        currency, status, verified_at_ms, created_at_ms, updated_at_ms
      ) VALUES (
        ?, ?, 'CASH', ?, ?, 1000,
        'INR', 'PAID', ?, ?, ?
      )`,
    ).run(
      crypto.randomUUID(),
      spec.orderId,
      `order_${spec.orderId.slice(-8)}`,
      `cash_${spec.orderId.slice(-8)}`,
      spec.queuedAtMs,
      spec.queuedAtMs,
      spec.queuedAtMs,
    );
  }

  // Generate 50 realistic mixed orders
  function generate50Orders(): OrderSpec[] {
    const orders: OrderSpec[] = [];
    const combos: Array<{
      color: "BW" | "COLOR";
      sides: "SINGLE" | "DOUBLE";
      paper: "A4" | "A3";
    }> = [
      { color: "BW", sides: "SINGLE", paper: "A4" }, // Capable: A, B, C, D, E (Best-fit: A)
      { color: "BW", sides: "DOUBLE", paper: "A4" }, // Capable: B, D, E (Best-fit: B)
      { color: "COLOR", sides: "SINGLE", paper: "A4" }, // Capable: C, D, E (Best-fit: C)
      { color: "COLOR", sides: "DOUBLE", paper: "A4" }, // Capable: D, E (Best-fit: D)
      { color: "BW", sides: "SINGLE", paper: "A3" }, // Capable: E only (A3)
      { color: "COLOR", sides: "DOUBLE", paper: "A3" }, // Capable: E only (Color + A3)
    ];

    for (let i = 1; i <= 50; i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      const combo = combos[(i - 1) % combos.length]!;
      // Even orders = Normal, every 5th order = Priority
      const isPriority = i % 5 === 0;
      orders.push({
        orderId: id,
        colorMode: combo.color,
        sides: combo.sides,
        paperSize: combo.paper,
        isPriority,
        copies: (i % 3) + 1,
        pages: (i % 5) + 1,
        queuedAtMs: BASE_NOW_MS + i * 1_000, // Arrive 1 second apart
      });
    }
    return orders;
  }

  // =========================================================================
  // SCENARIO 1: Full Lifecycle (QUEUED -> CLAIMED -> SPOOLING -> PRINTING -> COMPLETED) Across 50 Orders
  // =========================================================================
  it("Scenario 1: Full lifecycle (QUEUED -> CLAIMED -> SPOOLING -> PRINTING -> COMPLETED) across 50 orders with strict Priority and FIFO", async () => {
    seedShopAndFivePrinters();
    const orders = generate50Orders();
    for (const o of orders) {
      seedPaidOrder(o);
    }

    const executeStepToCompletion = async (
      job: {
        orderId: string;
        stepId?: string;
        currentStep?: { stepId: string };
        claimId: string;
        printerId: string;
      },
      nowMs: number,
    ) => {
      const stepId = (job.stepId ?? job.currentStep?.stepId)!;
      expect(stepId).toBeDefined();

      // 1. startStep -> status transitions to SUBMISSION_STARTED, order to SPOOLING / PRINTING
      const started = await repo.startStep({
        agentId: AGENT_ID,
        orderId: job.orderId,
        stepId,
        claimId: job.claimId,
        nowMs,
      });
      expect(started).not.toBeNull();
      expect(started!.step_status).toBe("SUBMISSION_STARTED");

      // Verify order is now in active printing/spooling state
      const orderInProgress = db
        .prepare(`SELECT status FROM orders WHERE id = ?`)
        .get(job.orderId) as { status: string };
      expect(["SPOOLING", "PRINTING"]).toContain(orderInProgress.status);

      // 2. recordSubmission -> status transitions to SUBMITTED with physical spooler ID
      const spoolId = `spool-${job.orderId.slice(-4)}`;
      const submitted = await repo.recordSubmission({
        agentId: AGENT_ID,
        orderId: job.orderId,
        stepId,
        claimId: job.claimId,
        spoolerJobId: spoolId,
        nowMs: nowMs + 100,
      });
      expect(submitted).not.toBeNull();
      expect(submitted!.step_status).toBe("SUBMITTED");
      expect(submitted!.spooler_job_id).toBe(spoolId);

      // 3. recordResult -> status transitions to SUCCEEDED, order to COMPLETED, releasing physical lock!
      const completed = await repo.recordResult({
        agentId: AGENT_ID,
        orderId: job.orderId,
        stepId,
        claimId: job.claimId,
        status: "SUCCEEDED",
        spoolerJobId: spoolId,
        failureCode: null,
        failureDetail: null,
        nowMs: nowMs + 500,
      });
      expect(completed).not.toBeNull();
      expect(completed!.step_status).toBe("SUCCEEDED");

      // Verify order is now COMPLETED and claim lease is released
      const orderCompleted = db
        .prepare(
          `SELECT status, claim_id, claimed_by_agent_id, printer_id FROM orders WHERE id = ?`,
        )
        .get(job.orderId) as {
        status: string;
        claim_id: string | null;
        claimed_by_agent_id: string | null;
        printer_id: string;
      };
      expect(orderCompleted.status).toBe("COMPLETED");
      expect(orderCompleted.claim_id).toBe(job.claimId);
    };

    let simTime = BASE_NOW_MS + 60_000;
    const completedLog: Array<{
      orderId: string;
      printerId: string;
      physicalDeviceId: string;
      priority: boolean;
      round: number;
    }> = [];

    let round = 1;
    while (round <= 20) {
      // Agent sends periodic heartbeat keeping its liveness active
      db.prepare(`UPDATE agents SET last_heartbeat_at_ms = ? WHERE id = ?`).run(
        simTime,
        AGENT_ID,
      );

      const claims = await repo.claimOrRenewAll(AGENT_ID, simTime);
      if (claims.length === 0) break;

      // In Round 1, verify priority: all 5 priority orders claimed first
      if (round === 1) {
        expect(claims.length).toBe(5);
        const deviceIds = new Set(claims.map((c) => c.physicalDeviceId));
        expect(deviceIds.size).toBe(5);
        const priorityInRound1 = claims.filter((c) => {
          const num = parseInt(c.orderId.slice(-3), 10);
          return num % 5 === 0;
        });
        expect(priorityInRound1.length).toBe(5);
      }

      // Complete all claims in this batch
      for (const c of claims) {
        await executeStepToCompletion(c, simTime);
        completedLog.push({
          orderId: c.orderId,
          printerId: c.printerId,
          physicalDeviceId: c.physicalDeviceId ?? "UNKNOWN",
          priority: parseInt(c.orderId.slice(-3), 10) % 5 === 0,
          round,
        });
        simTime += 1_000;
      }

      round++;
    }

    // Verify all 50 orders completed
    expect(completedLog.length).toBe(50);

    const counts = db
      .prepare(
        `SELECT
          SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) as completed_count,
          SUM(CASE WHEN status = 'QUEUED' THEN 1 ELSE 0 END) as queued_count,
          SUM(CASE WHEN status IN ('CLAIMED', 'SPOOLING', 'PRINTING') THEN 1 ELSE 0 END) as in_flight_count
        FROM orders`,
      )
      .get() as {
      completed_count: number;
      queued_count: number;
      in_flight_count: number;
    };

    expect(counts.completed_count).toBe(50);
    expect(counts.queued_count).toBe(0);
    expect(counts.in_flight_count).toBe(0);

    const stepsSummary = db
      .prepare(
        `SELECT
          COUNT(*) as total_steps,
          SUM(CASE WHEN status = 'SUCCEEDED' THEN 1 ELSE 0 END) as succeeded_steps,
          SUM(CASE WHEN spooler_job_id IS NOT NULL THEN 1 ELSE 0 END) as total_submissions
        FROM print_attempt_steps`,
      )
      .get() as {
      total_steps: number;
      succeeded_steps: number;
      total_submissions: number;
    };

    expect(stepsSummary.total_steps).toBe(50);
    expect(stepsSummary.succeeded_steps).toBe(50);
    // Exact physical submission count: strictly 50 (1 per order, zero duplicate prints)
    expect(stepsSummary.total_submissions).toBe(50);
  });

  // =========================================================================
  // SCENARIO 2: Best-Fit Printer Selection (Simplest Capable Printer Chosen)
  // =========================================================================
  it("Scenario 2: Best-fit printer preference (simplest capable printer chosen)", async () => {
    seedShopAndFivePrinters();

    // Order A: B&W Simplex A4 -> Compatible with A, B, C, D, E. Simplest = A (Priority 50)
    seedPaidOrder({
      orderId: "00000000-0000-4000-8000-000000000101",
      colorMode: "BW",
      sides: "SINGLE",
      paperSize: "A4",
      isPriority: false,
      copies: 1,
      pages: 1,
      queuedAtMs: BASE_NOW_MS + 100,
    });

    // Order B: B&W Duplex A4 -> Compatible with B, D, E. Simplest = B (Priority 40)
    seedPaidOrder({
      orderId: "00000000-0000-4000-8000-000000000102",
      colorMode: "BW",
      sides: "DOUBLE",
      paperSize: "A4",
      isPriority: false,
      copies: 1,
      pages: 1,
      queuedAtMs: BASE_NOW_MS + 200,
    });

    // Order C: Color Simplex A4 -> Compatible with C, D, E. Simplest = C (Priority 30)
    seedPaidOrder({
      orderId: "00000000-0000-4000-8000-000000000103",
      colorMode: "COLOR",
      sides: "SINGLE",
      paperSize: "A4",
      isPriority: false,
      copies: 1,
      pages: 1,
      queuedAtMs: BASE_NOW_MS + 300,
    });

    // Order D: Color Duplex A4 -> Compatible with D, E. Simplest = D (Priority 20)
    seedPaidOrder({
      orderId: "00000000-0000-4000-8000-000000000104",
      colorMode: "COLOR",
      sides: "DOUBLE",
      paperSize: "A4",
      isPriority: false,
      copies: 1,
      pages: 1,
      queuedAtMs: BASE_NOW_MS + 400,
    });

    // Order E: A3 Job -> Compatible only with E (Priority 10)
    seedPaidOrder({
      orderId: "00000000-0000-4000-8000-000000000105",
      colorMode: "BW",
      sides: "SINGLE",
      paperSize: "A3",
      isPriority: false,
      copies: 1,
      pages: 1,
      queuedAtMs: BASE_NOW_MS + 500,
    });

    const claims = await repo.claimOrRenewAll(AGENT_ID, BASE_NOW_MS + 10_000);
    expect(claims.length).toBe(5);

    const claimMap = new Map(
      claims.map((c) => [c.orderId.slice(-3), c.printerId]),
    );
    expect(claimMap.get("101")).toBe(PRINTER_A_ID); // B&W Simplex -> Printer A
    expect(claimMap.get("102")).toBe(PRINTER_B_ID); // B&W Duplex -> Printer B
    expect(claimMap.get("103")).toBe(PRINTER_C_ID); // Color Simplex -> Printer C
    expect(claimMap.get("104")).toBe(PRINTER_D_ID); // Color Duplex -> Printer D
    expect(claimMap.get("105")).toBe(PRINTER_E_ID); // A3 Job -> Printer E
  });

  // =========================================================================
  // SCENARIO 3: Head-of-Line Blocking Prevention
  // =========================================================================
  it("Scenario 3: Head-of-line blocking prevention (unready printer does not stall other jobs)", async () => {
    // Printer D (Color Duplex) is OFFLINE
    seedShopAndFivePrinters({ printerDStatus: "OFFLINE" });

    // Oldest order #1 requires Color Duplex (Printer D - OFFLINE)
    seedPaidOrder({
      orderId: "00000000-0000-4000-8000-000000000201",
      colorMode: "COLOR",
      sides: "DOUBLE",
      paperSize: "A4",
      isPriority: true, // Priority!
      copies: 1,
      pages: 1,
      queuedAtMs: BASE_NOW_MS + 100, // Arrived first
    });

    // Younger order #2 requires B&W Simplex (Printer A - ONLINE)
    seedPaidOrder({
      orderId: "00000000-0000-4000-8000-000000000202",
      colorMode: "BW",
      sides: "SINGLE",
      paperSize: "A4",
      isPriority: false,
      copies: 1,
      pages: 1,
      queuedAtMs: BASE_NOW_MS + 200,
    });

    // Younger order #3 requires Color Simplex (Printer C - ONLINE)
    seedPaidOrder({
      orderId: "00000000-0000-4000-8000-000000000203",
      colorMode: "COLOR",
      sides: "SINGLE",
      paperSize: "A4",
      isPriority: false,
      copies: 1,
      pages: 1,
      queuedAtMs: BASE_NOW_MS + 300,
    });

    // Claim work: Order #1 can fall back to Printer E (also Color Duplex),
    // and Orders #2 and #3 proceed on Printers A and C without being blocked!
    const claims = await repo.claimOrRenewAll(AGENT_ID, BASE_NOW_MS + 10_000);

    const order2 = claims.find((c) => c.orderId.endsWith("202"));
    const order3 = claims.find((c) => c.orderId.endsWith("203"));
    expect(order2).toBeDefined();
    expect(order2!.printerId).toBe(PRINTER_A_ID);
    expect(order3).toBeDefined();
    expect(order3!.printerId).toBe(PRINTER_C_ID);
  });

  // =========================================================================
  // SCENARIO 4: Shop-Wide Fallback (Automatic reroute to any compatible printer)
  // =========================================================================
  it("Scenario 4: Shop-wide fallback when primary printer jams (fallback_printer_id IS NULL)", async () => {
    // Printer A is JAMMED
    seedShopAndFivePrinters({
      printerAStatus: "BLOCKED",
      printerAPaused: 1,
      printerAPausedReason: "PAPER_JAM",
    });

    // B&W Simplex order arrives (normally goes to Printer A)
    seedPaidOrder({
      orderId: "00000000-0000-4000-8000-000000000301",
      colorMode: "BW",
      sides: "SINGLE",
      paperSize: "A4",
      isPriority: false,
      copies: 1,
      pages: 1,
      queuedAtMs: BASE_NOW_MS + 100,
    });

    // Claim: With Printer A jammed, shop-wide fallback reroutes to next simplest compatible printer (Printer B)
    const claims = await repo.claimOrRenewAll(AGENT_ID, BASE_NOW_MS + 10_000);
    expect(claims.length).toBe(1);
    expect(claims[0]!.orderId.endsWith("301")).toBe(true);
    expect(claims[0]!.printerId).toBe(PRINTER_B_ID); // Auto-fallback to Printer B!
  });

  // =========================================================================
  // SCENARIO 5: Pre-Assigned Queued Order Rescued from Faulted Printer (Bug 5)
  // =========================================================================
  it("Scenario 5: Pre-assigned order whose assigned printer is paused is claimed by healthy fallback (Bug 5 fix)", async () => {
    seedShopAndFivePrinters({
      printerBStatus: "BLOCKED",
      printerBPaused: 1,
      printerBPausedReason: "PAPER_JAM",
    });

    // Pre-assign order to Printer B (which is now paused with a paper jam)
    seedPaidOrder({
      orderId: "00000000-0000-4000-8000-000000000401",
      colorMode: "BW",
      sides: "DOUBLE", // Needs duplex
      paperSize: "A4",
      isPriority: false,
      copies: 1,
      pages: 1,
      queuedAtMs: BASE_NOW_MS + 100,
    });
    // Explicitly pre-assign to Printer B
    db.prepare(`UPDATE orders SET printer_id = ? WHERE id = ?`).run(
      PRINTER_B_ID,
      "00000000-0000-4000-8000-000000000401",
    );

    // With Bug 5 fix (Subcase A2 in claimOrRenewAll), Printer D (Color Duplex) can claim it!
    const claims = await repo.claimOrRenewAll(AGENT_ID, BASE_NOW_MS + 10_000);
    expect(claims.length).toBe(1);
    expect(claims[0]!.orderId.endsWith("401")).toBe(true);
    // Printer D is healthy and supports duplex -> rescues the stuck job
    expect(claims[0]!.printerId).toBe(PRINTER_D_ID);
  });

  // =========================================================================
  // SCENARIO 6: Fault Detection, Dynamic Fallback & Automatic Recovery
  // =========================================================================
  it("Scenario 6: Fault detection updates D1 immediately, routes away to fallback, and restores best fit upon recovery", async () => {
    seedShopAndFivePrinters();

    // 1. Printer A reports JAMMED ("Paper Jam") while Printer B is reported healthy
    await agentRepo.updateHeartbeat({
      agentId: AGENT_ID,
      nowMs: BASE_NOW_MS + 10_000,
      printers: [
        {
          windowsPrinterName: "Printer_A_BW_Simplex",
          displayName: "Printer A (B&W Simplex)",
          status: "BLOCKED",
          statusReason: "Paper Jam",
          isDefault: true,
          isProductionEligible: true,
          isVirtual: false,
          capabilities: { colour: false, duplex: false, paperSizes: ["A4"] },
          portName: "USB001",
          driverName: "Generic",
        },
        {
          windowsPrinterName: "Printer_B_BW_Duplex",
          displayName: "Printer B (B&W Duplex)",
          status: "ONLINE",
          statusReason: null,
          isDefault: false,
          isProductionEligible: true,
          isVirtual: false,
          capabilities: { colour: false, duplex: true, paperSizes: ["A4"] },
          portName: "USB001",
          driverName: "Generic",
        },
      ],
    });

    // Verify Printer A status in database is now BLOCKED
    const printerA = db
      .prepare(`SELECT status, status_reason FROM printers WHERE id = ?`)
      .get(PRINTER_A_ID) as { status: string; status_reason: string };
    expect(printerA.status).toBe("BLOCKED");
    expect(printerA.status_reason).toBe("Paper Jam");

    // 2. Pending B&W Simplex order arrives while Printer A is jammed
    const order1Id = "00000000-0000-4000-8000-000000000601";
    seedPaidOrder({
      orderId: order1Id,
      colorMode: "BW",
      sides: "SINGLE",
      paperSize: "A4",
      isPriority: false,
      copies: 1,
      pages: 5,
      queuedAtMs: BASE_NOW_MS + 11_000,
    });

    // Claim order: Printer A cannot claim it, so it automatically routes to fallback Printer B (B&W Duplex)!
    const claim1 = await repo.claimOrRenewAll(AGENT_ID, BASE_NOW_MS + 12_000);
    expect(claim1.length).toBe(1);
    expect(claim1[0]!.orderId).toBe(order1Id);
    expect(claim1[0]!.printerId).toBe(PRINTER_B_ID);

    // 3. Printer A recovers (paper cleared, reports ONLINE)
    await agentRepo.updateHeartbeat({
      agentId: AGENT_ID,
      nowMs: BASE_NOW_MS + 42_000,
      printers: [
        {
          windowsPrinterName: "Printer_A_BW_Simplex",
          displayName: "Printer A (B&W Simplex)",
          status: "ONLINE",
          statusReason: null,
          isDefault: true,
          isProductionEligible: true,
          isVirtual: false,
          capabilities: { colour: false, duplex: false, paperSizes: ["A4"] },
          portName: "USB001",
          driverName: "Generic",
        },
        {
          windowsPrinterName: "Printer_B_BW_Duplex",
          displayName: "Printer B (B&W Duplex)",
          status: "ONLINE",
          statusReason: null,
          isDefault: false,
          isProductionEligible: true,
          isVirtual: false,
          capabilities: { colour: false, duplex: true, paperSizes: ["A4"] },
          portName: "USB001",
          driverName: "Generic",
        },
      ],
    });

    const printerARecovered = db
      .prepare(`SELECT status, status_reason FROM printers WHERE id = ?`)
      .get(PRINTER_A_ID) as { status: string; status_reason: string | null };
    expect(printerARecovered.status).toBe("ONLINE");
    expect(printerARecovered.status_reason).toBeNull();

    // 4. Next B&W Simplex order arrives: Printer A is immediately selected as best-fit!
    const order2Id = "00000000-0000-4000-8000-000000000602";
    seedPaidOrder({
      orderId: order2Id,
      colorMode: "BW",
      sides: "SINGLE",
      paperSize: "A4",
      isPriority: false,
      copies: 1,
      pages: 5,
      queuedAtMs: BASE_NOW_MS + 43_000,
    });

    const claim2 = await repo.claimOrRenewAll(AGENT_ID, BASE_NOW_MS + 44_000);
    const order2Claim = claim2.find((c) => c.orderId === order2Id);
    expect(order2Claim).toBeDefined();
    expect(order2Claim!.printerId).toBe(PRINTER_A_ID);
  });

  // =========================================================================
  // SCENARIO 7: Duplicate-Print Safety (Zero Automatic Reprints of In-Flight Jobs)
  // =========================================================================
  it("Scenario 7: Zero automatic reprint when job fails after spooler submission started", async () => {
    seedShopAndFivePrinters();

    const orderId = "00000000-0000-4000-8000-000000000701";
    seedPaidOrder({
      orderId,
      colorMode: "BW",
      sides: "SINGLE",
      paperSize: "A4",
      isPriority: false,
      copies: 1,
      pages: 10,
      queuedAtMs: BASE_NOW_MS,
    });

    // Claim the job
    const claims = await repo.claimOrRenewAll(AGENT_ID, BASE_NOW_MS + 1_000);
    expect(claims.length).toBe(1);

    // Move existing attempt and step to PRINTING / SUBMISSION_STARTED (physical submission in progress)
    db.prepare(
      `UPDATE print_attempts SET status = 'PRINTING' WHERE order_id = ?`,
    ).run(orderId);

    db.prepare(
      `UPDATE print_attempt_steps SET status = 'SUBMISSION_STARTED', updated_at_ms = ? WHERE order_id = ?`,
    ).run(BASE_NOW_MS + 2_000, orderId);

    db.prepare(
      `UPDATE orders SET status = 'PRINTING', claim_expires_at_ms = ? WHERE id = ?`,
    ).run(BASE_NOW_MS + 5_000, orderId);

    // Simulate Agent crash or power failure: claim lease expires
    const expiredTimeMs = BASE_NOW_MS + 60_000;

    // Run claim recovery
    await repo.recoverExpiredClaims(expiredTimeMs);

    // Check order status: must be quarantined to ADMIN_ACTION_REQUIRED, NOT reset to QUEUED!
    const row = db
      .prepare(`SELECT status FROM orders WHERE id = ?`)
      .get(orderId) as { status: string };

    expect(row.status).toBe("ADMIN_ACTION_REQUIRED");

    // Duplicate physical print prevented: step is quarantined to UNCERTAIN
    const step = db
      .prepare(
        `SELECT status, failure_detail FROM print_attempt_steps WHERE order_id = ?`,
      )
      .get(orderId) as { status: string; failure_detail: string };
    expect(step.status).toBe("UNCERTAIN");
    expect(step.failure_detail).toContain(
      "physical submission may have started",
    );

    // Verify claimOrRenewAll refuses to re-claim this quarantined job
    const newClaims = await repo.claimOrRenewAll(
      AGENT_ID,
      expiredTimeMs + 1_000,
    );
    const reclaims = newClaims.filter((c) => c.orderId === orderId);
    expect(reclaims.length).toBe(0); // Zero duplicate submission!
  });

  // =========================================================================
  // SCENARIO 8: Admin Recovery Buttons (Check Again, Print Recovery)
  // =========================================================================
  it("Scenario 8: Admin 'Check Again' and 'Print Recovery' buttons behavior", async () => {
    seedShopAndFivePrinters({
      printerAStatus: "BLOCKED",
      printerAPaused: 1,
      printerAPausedReason: "PAPER_JAM",
    });

    // 1. Check Again while printer is still jammed -> remains paused
    const check1 = await agentRepo.checkPrinterHealth(
      PRINTER_A_ID,
      ADMIN_ID,
      BASE_NOW_MS,
    );
    expect(check1.isPaused).toBe(true);
    expect(check1.status).toBe("BLOCKED");
    expect(check1.message).toContain("PAPER_JAM");

    // 2. Hardware issue cleared -> printer reports ONLINE
    db.prepare(
      `UPDATE printers SET status = 'ONLINE', status_reason = NULL WHERE id = ?`,
    ).run(PRINTER_A_ID);

    // 3. Admin clicks Check Again -> printer verified healthy, queue unpaused!
    const check2 = await agentRepo.checkPrinterHealth(
      PRINTER_A_ID,
      ADMIN_ID,
      BASE_NOW_MS + 30_000,
    );
    expect(check2.isPaused).toBe(false);
    expect(check2.status).toBe("ONLINE");
    expect(check2.message).toContain(
      "Printer is healthy and online. Queue resumed.",
    );

    // Verify D1 state is unpaused
    const pA = db
      .prepare(`SELECT is_paused, paused_reason FROM printers WHERE id = ?`)
      .get(PRINTER_A_ID) as {
      is_paused: number;
      paused_reason: string | null;
    };
    expect(pA.is_paused).toBe(0);
    expect(pA.paused_reason).toBeNull();

    // 4. Test Print Recovery button: recovers safe pre-submission jobs
    const orderId = "00000000-0000-4000-8000-000000000801";
    seedPaidOrder({
      orderId,
      colorMode: "BW",
      sides: "SINGLE",
      paperSize: "A4",
      isPriority: false,
      copies: 1,
      pages: 1,
      queuedAtMs: BASE_NOW_MS,
    });

    // Set order as CLAIMED with no physical submission started
    db.prepare(
      `UPDATE orders
       SET status = 'CLAIMED', claimed_by_agent_id = ?, claim_id = ?, claimed_at_ms = ?, claim_expires_at_ms = ?,
           created_at_ms = ?, updated_at_ms = ?
       WHERE id = ?`,
    ).run(
      AGENT_ID,
      "claim_test_123",
      BASE_NOW_MS - 400_000,
      BASE_NOW_MS + 60_000,
      BASE_NOW_MS - 400_000,
      BASE_NOW_MS - 400_000,
      orderId,
    );

    const recoverResult = await repo.recoverQueue({
      adminId: ADMIN_ID,
      nowMs: BASE_NOW_MS,
    });
    expect(recoverResult.recoveredOrdersCount).toBe(1);

    // Verify order is back in QUEUED state ready for printing
    const orderRow = db
      .prepare(`SELECT status FROM orders WHERE id = ?`)
      .get(orderId) as { status: string };
    expect(orderRow.status).toBe("QUEUED");
  });

  // =========================================================================
  // SCENARIO 9: False ONLINE Prevention (UNKNOWN Status Ineligible for Orders)
  // =========================================================================
  it("Scenario 9: False ONLINE prevention: UNKNOWN printer status is never treated as READY and cannot claim jobs", async () => {
    seedShopAndFivePrinters({
      printerAStatus: "UNKNOWN",
    });

    const orderId = "00000000-0000-4000-8000-000000000901";
    seedPaidOrder({
      orderId,
      colorMode: "BW",
      sides: "SINGLE",
      paperSize: "A4",
      isPriority: false,
      copies: 1,
      pages: 5,
      queuedAtMs: BASE_NOW_MS,
    });

    // Printer A is UNKNOWN: it must NOT claim the order.
    // Instead, the order safely routes to fallback Printer B (B&W Duplex)!
    const claims = await repo.claimOrRenewAll(AGENT_ID, BASE_NOW_MS + 1_000);
    expect(claims.length).toBe(1);
    expect(claims[0]!.orderId).toBe(orderId);
    expect(claims[0]!.printerId).toBe(PRINTER_B_ID);
  });

  // =========================================================================
  // SCENARIO 10: D1 Change-Detection Write Optimization
  // =========================================================================
  it("Scenario 10: D1 efficiency: identical printer status reports skip redundant database writes", async () => {
    seedShopAndFivePrinters();

    // Reset stats after seeding
    d1Stats.writes = 0;
    d1Stats.queries = 0;

    // Initial heartbeat with printer report
    await agentRepo.updateHeartbeat({
      agentId: AGENT_ID,
      nowMs: BASE_NOW_MS + 70_000,
      printers: [
        {
          windowsPrinterName: "Printer_A_BW_Simplex",
          displayName: "Printer A (B&W Simplex)",
          status: "ONLINE",
          statusReason: null,
          isDefault: true,
          isProductionEligible: true,
          isVirtual: false,
          capabilities: { colour: false, duplex: false, paperSizes: ["A4"] },
          portName: "USB001",
          driverName: "Generic / Text Only",
        },
      ],
    });

    const writesAfterFirst = d1Stats.writes;

    // Second heartbeat with identical printer report within 60s
    // Both agent heartbeat update (>60s gate) and printer update (no changes) are skipped!
    await agentRepo.updateHeartbeat({
      agentId: AGENT_ID,
      nowMs: BASE_NOW_MS + 80_000,
      printers: [
        {
          windowsPrinterName: "Printer_A_BW_Simplex",
          displayName: "Printer A (B&W Simplex)",
          status: "ONLINE",
          statusReason: null,
          isDefault: true,
          isProductionEligible: true,
          isVirtual: false,
          capabilities: { colour: false, duplex: false, paperSizes: ["A4"] },
          portName: "USB001",
          driverName: "Generic / Text Only",
        },
      ],
    });

    // Zero additional writes: identical report was completely skipped!
    expect(d1Stats.writes).toBe(writesAfterFirst);
  });

  // =========================================================================
  // SCENARIO 11: Partial Printing Mid-Job Interruption & Duplicate Protection
  // =========================================================================
  it("Scenario 11: Partial printing mid-job interruption: step 1 succeeds, step 2 crashes; step 1 is never reprinted", async () => {
    seedShopAndFivePrinters();

    // Enable identification sheet so orders generate 2 steps: (1) ID Sheet, (2) Customer Document
    db.prepare(
      `UPDATE installation SET identification_sheet_enabled = 1, identification_sheet_placement = 'FIRST', id_sheet_min_pages = 0`,
    ).run();

    const orderId = "00000000-0000-4000-8000-000000000801";
    seedPaidOrder({
      orderId,
      colorMode: "BW",
      sides: "SINGLE",
      paperSize: "A4",
      isPriority: false,
      copies: 1,
      pages: 10,
      queuedAtMs: BASE_NOW_MS,
    });

    // 1. Claim order -> creates attempt with 2 steps:
    // Step 1 = IDENTIFICATION_SHEET, Step 2 = CUSTOMER_DOCUMENT
    const claims = await repo.claimOrRenewAll(AGENT_ID, BASE_NOW_MS + 1_000);
    expect(claims.length).toBe(1);
    const claim1 = claims[0]!;
    expect(claim1.currentStep.type).toBe("IDENTIFICATION_SHEET");

    const step1Id = claim1.currentStep.stepId;

    // 2. Execute Step 1 to success
    await repo.startStep({
      agentId: AGENT_ID,
      orderId,
      stepId: step1Id,
      claimId: claim1.claimId,
      nowMs: BASE_NOW_MS + 2_000,
    });
    await repo.recordSubmission({
      agentId: AGENT_ID,
      orderId,
      stepId: step1Id,
      claimId: claim1.claimId,
      spoolerJobId: "spool-idsheet-001",
      nowMs: BASE_NOW_MS + 3_000,
    });
    await repo.recordResult({
      agentId: AGENT_ID,
      orderId,
      stepId: step1Id,
      claimId: claim1.claimId,
      status: "SUCCEEDED",
      spoolerJobId: "spool-idsheet-001",
      failureCode: null,
      failureDetail: null,
      nowMs: BASE_NOW_MS + 5_000,
    });

    // Verify step 1 is SUCCEEDED in database
    const step1Row = db
      .prepare(
        `SELECT status, spooler_job_id FROM print_attempt_steps WHERE id = ?`,
      )
      .get(step1Id) as { status: string; spooler_job_id: string };
    expect(step1Row.status).toBe("SUCCEEDED");
    expect(step1Row.spooler_job_id).toBe("spool-idsheet-001");

    // 3. Next pulse fetches Step 2 (CUSTOMER_DOCUMENT)
    const currentJobs = await repo.claimOrRenewAll(
      AGENT_ID,
      BASE_NOW_MS + 6_000,
    );
    expect(currentJobs.length).toBe(1);
    const claim2 = currentJobs[0]!;
    expect(claim2.currentStep.type).toBe("CUSTOMER_DOCUMENT");
    const step2Id = claim2.currentStep.stepId;
    expect(step2Id).not.toBe(step1Id);

    // 4. Step 2 starts submission to Windows spooler
    await repo.startStep({
      agentId: AGENT_ID,
      orderId,
      stepId: step2Id,
      claimId: claim2.claimId,
      nowMs: BASE_NOW_MS + 7_000,
    });
    await repo.recordSubmission({
      agentId: AGENT_ID,
      orderId,
      stepId: step2Id,
      claimId: claim2.claimId,
      spoolerJobId: "spool-doc-002",
      nowMs: BASE_NOW_MS + 8_000,
    });

    // 5. Hard failure / crash occurs mid-print!
    // Agent disconnects; 5-minute lease expires at t = BASE_NOW_MS + 400_000
    await repo.recoverExpiredClaims(BASE_NOW_MS + 400_000);

    // 6. Verify Post-Crash State:
    // Step 1: MUST REMAIN SUCCEEDED (never reverted)
    const step1Post = db
      .prepare(
        `SELECT status, spooler_job_id FROM print_attempt_steps WHERE id = ?`,
      )
      .get(step1Id) as { status: string; spooler_job_id: string };
    expect(step1Post.status).toBe("SUCCEEDED");
    expect(step1Post.spooler_job_id).toBe("spool-idsheet-001");

    // Step 2: Transitioned to UNCERTAIN because spooler submission was already recorded
    const step2Post = db
      .prepare(
        `SELECT status, spooler_job_id FROM print_attempt_steps WHERE id = ?`,
      )
      .get(step2Id) as { status: string; spooler_job_id: string };
    expect(step2Post.status).toBe("UNCERTAIN");
    expect(step2Post.spooler_job_id).toBe("spool-doc-002");

    // Order: MUST BE QUARANTINED to ADMIN_ACTION_REQUIRED
    const orderPost = db
      .prepare(`SELECT status, error_category FROM orders WHERE id = ?`)
      .get(orderId) as { status: string; error_category: string | null };
    expect(orderPost.status).toBe("ADMIN_ACTION_REQUIRED");

    // CRITICAL: Next claim cycle MUST NOT claim this order or reprint Step 1!
    const claimsAfterRecovery = await repo.claimOrRenewAll(
      AGENT_ID,
      BASE_NOW_MS + 410_000,
    );
    expect(claimsAfterRecovery.length).toBe(0);
  });

  // =========================================================================
  // SCENARIO 12: Simultaneous Dual Printer Hardware Failures
  // =========================================================================
  it("Scenario 12: Simultaneous dual printer failures: Printer A (jammed) and Printer B (out of paper) while jobs are queued", async () => {
    seedShopAndFivePrinters({
      printerAStatus: "BLOCKED",
      printerAPaused: 1,
      printerAPausedReason: "PAPER_JAM",
      printerBStatus: "BLOCKED",
      printerBPaused: 1,
      printerBPausedReason: "PAPER_OUT",
    });

    seedPaidOrder({
      orderId: "00000000-0000-4000-8000-000000001201",
      colorMode: "BW",
      sides: "SINGLE",
      paperSize: "A4",
      isPriority: false,
      copies: 1,
      pages: 1,
      queuedAtMs: BASE_NOW_MS + 100,
    });
    seedPaidOrder({
      orderId: "00000000-0000-4000-8000-000000001202",
      colorMode: "BW",
      sides: "DOUBLE",
      paperSize: "A4",
      isPriority: false,
      copies: 1,
      pages: 1,
      queuedAtMs: BASE_NOW_MS + 200,
    });
    seedPaidOrder({
      orderId: "00000000-0000-4000-8000-000000001203",
      colorMode: "COLOR",
      sides: "SINGLE",
      paperSize: "A4",
      isPriority: false,
      copies: 1,
      pages: 1,
      queuedAtMs: BASE_NOW_MS + 300,
    });
    seedPaidOrder({
      orderId: "00000000-0000-4000-8000-000000001204",
      colorMode: "COLOR",
      sides: "DOUBLE",
      paperSize: "A4",
      isPriority: false,
      copies: 1,
      pages: 1,
      queuedAtMs: BASE_NOW_MS + 400,
    });

    const claims = await repo.claimOrRenewAll(AGENT_ID, BASE_NOW_MS + 10_000);

    // Neither Printer A nor Printer B must claim anything!
    const printerIds = claims.map((c) => c.printerId);
    expect(printerIds).not.toContain(PRINTER_A_ID);
    expect(printerIds).not.toContain(PRINTER_B_ID);

    // Exactly 3 printers are healthy (C, D, E), so exactly 3 orders are claimed in strict FIFO:
    expect(claims.length).toBe(3);

    // 1. Oldest order (Order 1, B&W Simplex, queued at +100): Printer C is highest priority healthy compatible printer (priority 30 > 20 > 10)
    const order1Claim = claims.find((c) => c.orderId.endsWith("1201"));
    expect(order1Claim).toBeDefined();
    expect(order1Claim!.printerId).toBe(PRINTER_C_ID);

    // 2. Second oldest (Order 2, B&W Duplex, queued at +200): Requires duplex, Printer D is highest priority duplex printer (priority 20 > 10)
    const order2Claim = claims.find((c) => c.orderId.endsWith("1202"));
    expect(order2Claim).toBeDefined();
    expect(order2Claim!.printerId).toBe(PRINTER_D_ID);

    // 3. Third oldest (Order 3, Color Simplex, queued at +300): Only Printer E remains idle (C and D are busy with earlier orders)
    const order3Claim = claims.find((c) => c.orderId.endsWith("1203"));
    expect(order3Claim).toBeDefined();
    expect(order3Claim!.printerId).toBe(PRINTER_E_ID);

    // 4. Fourth order (Order 4, Color Duplex, queued at +400): Waits safely in QUEUED because all physical lanes are busy
    const order4Claim = claims.find((c) => c.orderId.endsWith("1204"));
    expect(order4Claim).toBeUndefined();
  });

  // =========================================================================
  // SCENARIO 13: Mid-Print Printer Recovery While Other Jobs Are Active
  // =========================================================================
  it("Scenario 13: Mid-print recovery: Printer A recovers from fault while Printer D is actively printing", async () => {
    seedShopAndFivePrinters({
      printerAStatus: "BLOCKED",
      printerAPaused: 1,
      printerAPausedReason: "PAPER_JAM",
    });

    // Seed Order 1 (Color Duplex) and claim it on Printer D
    const order1Id = "00000000-0000-4000-8000-000000001301";
    seedPaidOrder({
      orderId: order1Id,
      colorMode: "COLOR",
      sides: "DOUBLE",
      paperSize: "A4",
      isPriority: false,
      copies: 1,
      pages: 20,
      queuedAtMs: BASE_NOW_MS,
    });

    const claim1Batch = await repo.claimOrRenewAll(
      AGENT_ID,
      BASE_NOW_MS + 1_000,
    );
    expect(claim1Batch.length).toBe(1);
    expect(claim1Batch[0]!.printerId).toBe(PRINTER_D_ID);

    // Start printing Order 1 on Printer D
    const activeStepId = claim1Batch[0]!.currentStep.stepId;
    await repo.startStep({
      agentId: AGENT_ID,
      orderId: order1Id,
      stepId: activeStepId,
      claimId: claim1Batch[0]!.claimId,
      nowMs: BASE_NOW_MS + 2_000,
    });
    await repo.recordSubmission({
      agentId: AGENT_ID,
      orderId: order1Id,
      stepId: activeStepId,
      claimId: claim1Batch[0]!.claimId,
      spoolerJobId: "spool-d-active",
      nowMs: BASE_NOW_MS + 3_000,
    });

    // While Order 1 is actively printing on Printer D, Printer A recovers!
    // Paper jam cleared, unpaused, status reported ONLINE
    db.prepare(
      `UPDATE printers SET status = 'ONLINE', is_paused = 0, paused_reason = NULL, status_reason = NULL WHERE id = ?`,
    ).run(PRINTER_A_ID);

    // Now a pending B&W Simplex order arrives
    const order2Id = "00000000-0000-4000-8000-000000001302";
    seedPaidOrder({
      orderId: order2Id,
      colorMode: "BW",
      sides: "SINGLE",
      paperSize: "A4",
      isPriority: false,
      copies: 1,
      pages: 5,
      queuedAtMs: BASE_NOW_MS + 4_000,
    });

    // Claim next pulse: Printer A immediately claims Order 2, while Order 1 continues on Printer D!
    const activeJobs = await repo.claimOrRenewAll(
      AGENT_ID,
      BASE_NOW_MS + 5_000,
    );
    expect(activeJobs.length).toBe(2);

    const jobD = activeJobs.find((j) => j.orderId === order1Id);
    const jobA = activeJobs.find((j) => j.orderId === order2Id);

    expect(jobD).toBeDefined();
    expect(jobD!.printerId).toBe(PRINTER_D_ID);
    expect(jobD!.physicalDeviceId).toBe("PHYS_DEV_D");

    expect(jobA).toBeDefined();
    expect(jobA!.printerId).toBe(PRINTER_A_ID);
    expect(jobA!.physicalDeviceId).toBe("PHYS_DEV_A");
  });

  // =========================================================================
  // SCENARIO 14: Repeated Admin Recovery Actions & Idempotency
  // =========================================================================
  it("Scenario 14: Repeated admin recovery actions: Check Again, Issue Resolved, and Print Recovery operate idempotently", async () => {
    seedShopAndFivePrinters();

    // 1. Calling recoverQueue when queue is clean
    const rec1 = await repo.recoverQueue({
      adminId: ADMIN_ID,
      nowMs: BASE_NOW_MS,
    });
    expect(rec1.recoveredOrdersCount).toBe(0);

    // 2. Call again immediately
    const rec2 = await repo.recoverQueue({
      adminId: ADMIN_ID,
      nowMs: BASE_NOW_MS + 100,
    });
    expect(rec2.recoveredOrdersCount).toBe(0);

    // 3. Insert a stuck expired order
    const orderId = "00000000-0000-4000-8000-000000001401";
    seedPaidOrder({
      orderId,
      colorMode: "BW",
      sides: "SINGLE",
      paperSize: "A4",
      isPriority: false,
      copies: 1,
      pages: 2,
      queuedAtMs: BASE_NOW_MS - 200_000,
    });
    const stuckClaimId = crypto.randomUUID();
    db.prepare(
      `UPDATE orders SET status = 'PRINT_BLOCKED', error_category = 'PAPER_JAM',
        claimed_by_agent_id = ?, claim_id = ?, claimed_at_ms = ?, claim_expires_at_ms = ?, updated_at_ms = ?
       WHERE id = ?`,
    ).run(
      AGENT_ID,
      stuckClaimId,
      BASE_NOW_MS - 200_000,
      BASE_NOW_MS - 100_000,
      BASE_NOW_MS - 100_000,
      orderId,
    );

    // Recover queue
    const rec3 = await repo.recoverQueue({
      adminId: ADMIN_ID,
      nowMs: BASE_NOW_MS,
    });
    expect(rec3.recoveredOrdersCount).toBe(1);

    // Calling recoverQueue again immediately yields 0 (already recovered, completely idempotent!)
    const rec4 = await repo.recoverQueue({
      adminId: ADMIN_ID,
      nowMs: BASE_NOW_MS + 200,
    });
    expect(rec4.recoveredOrdersCount).toBe(0);

    const orderRow = db
      .prepare(`SELECT status FROM orders WHERE id = ?`)
      .get(orderId) as { status: string };
    expect(orderRow.status).toBe("QUEUED");
  });

  // =========================================================================
  // SCENARIO 15: D1 Write Reduction vs Agent Liveness & Lease Safety
  // =========================================================================
  it("Scenario 15: D1 write reduction preserves agent liveness, refreshes at 60s, and refuses assignments upon true agent crash", async () => {
    seedShopAndFivePrinters();
    d1Stats.writes = 0;
    d1Stats.queries = 0;

    const printerReport = [
      {
        windowsPrinterName: "Printer_A_BW_Simplex",
        displayName: "Printer A (B&W Simplex)",
        status: "ONLINE" as const,
        statusReason: null,
        isDefault: true,
        isProductionEligible: true,
        isVirtual: false,
        capabilities: { colour: false, duplex: false, paperSizes: ["A4"] },
        portName: "USB001",
        driverName: "Generic",
      },
      {
        windowsPrinterName: "Printer_B_BW_Duplex",
        displayName: "Printer B (B&W Duplex)",
        status: "ONLINE" as const,
        statusReason: null,
        isDefault: false,
        isProductionEligible: true,
        isVirtual: false,
        capabilities: { colour: false, duplex: true, paperSizes: ["A4"] },
        portName: "USB001",
        driverName: "Generic",
      },
    ];

    // t = 0s: Heartbeat 1 (initial registration)
    await agentRepo.updateHeartbeat({
      agentId: AGENT_ID,
      nowMs: BASE_NOW_MS,
      printers: printerReport,
    });
    const writesT0 = d1Stats.writes;
    expect(writesT0).toBeGreaterThanOrEqual(1);

    // t = 10s: Heartbeat 2 (identical report within 60s window) -> 0 writes!
    await agentRepo.updateHeartbeat({
      agentId: AGENT_ID,
      nowMs: BASE_NOW_MS + 10_000,
      printers: printerReport,
    });
    expect(d1Stats.writes).toBe(writesT0);

    // t = 20s, 30s, 40s, 50s -> zero additional writes!
    for (let t = 20_000; t <= 50_000; t += 10_000) {
      await agentRepo.updateHeartbeat({
        agentId: AGENT_ID,
        nowMs: BASE_NOW_MS + t,
        printers: printerReport,
      });
      expect(d1Stats.writes).toBe(writesT0);
    }

    // t = 70s: 60s gate has elapsed -> exactly 1 write refreshes agents.last_heartbeat_at_ms!
    await agentRepo.updateHeartbeat({
      agentId: AGENT_ID,
      nowMs: BASE_NOW_MS + 70_000,
      printers: printerReport,
    });
    expect(d1Stats.writes).toBe(writesT0 + 1);

    // Verify agent liveness in database: last_heartbeat_at_ms was refreshed to t=70s!
    const agentRow = db
      .prepare(`SELECT last_heartbeat_at_ms FROM agents WHERE id = ?`)
      .get(AGENT_ID) as { last_heartbeat_at_ms: number };
    expect(agentRow.last_heartbeat_at_ms).toBe(BASE_NOW_MS + 70_000);

    // Now test True Agent Crash Detection:
    // Agent stops sending heartbeats completely.
    // Advance time by 100s to t = BASE_NOW_MS + 170_000 (>90s agent offline threshold).
    const orderCrashTestId = "00000000-0000-4000-8000-000000001501";
    seedPaidOrder({
      orderId: orderCrashTestId,
      colorMode: "BW",
      sides: "SINGLE",
      paperSize: "A4",
      isPriority: false,
      copies: 1,
      pages: 1,
      queuedAtMs: BASE_NOW_MS + 170_000,
    });

    // claimOrRenewAll checks a.last_heartbeat_at_ms >= nowMs - 90_000.
    // 70,000 < 170,000 - 90,000 (80,000). The agent is inactive / crashed!
    const claimsDuringCrash = await repo.claimOrRenewAll(
      AGENT_ID,
      BASE_NOW_MS + 170_000,
    );
    expect(claimsDuringCrash.length).toBe(0); // Safely refuses to dispatch to dead agent!
  });
});
