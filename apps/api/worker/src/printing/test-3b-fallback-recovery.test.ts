import { readFileSync, readdirSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkerEnv } from "../env.js";
import { D1PaymentReadiness } from "../payments/readiness.js";
import { D1PrintingRepository } from "./repository.js";

type ClaimedJob = NonNullable<
  Awaited<ReturnType<D1PrintingRepository["claimOrRenew"]>>
>;

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
const PRINTER_A_ID = "10000000-0000-4000-8000-00000000000A"; // HP Laser MFP 136w TEST (Priority 10)
const PRINTER_B_ID = "20000000-0000-4000-8000-00000000000B"; // PrintGo Simulated Printer B (Priority 5)

describe("TEST 3B: Safe Printer Fallback & Failure Recovery (Phase 3)", () => {
  let db: DatabaseSync;
  let d1: D1Database;
  let repo: D1PrintingRepository;
  let readiness: D1PaymentReadiness;
  const tempDirs: string[] = [];

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

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => fsPromises.rm(dir, { recursive: true, force: true })),
    );
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
    printerBRequiresReview?: number;
    defaultPrinterId?: string | null;
    autoFallbackEnabled?: number;
    fallbackPrinterId?: string | null;
    printerAPhysicalDeviceId?: string | null;
    printerBPhysicalDeviceId?: string | null;
    printerADuplex?: boolean;
    printerBColor?: boolean;
    printerBDuplex?: boolean;
    printerBA3?: boolean;
  }) {
    const defaultPrinter =
      opts?.defaultPrinterId !== undefined
        ? opts.defaultPrinterId
        : PRINTER_A_ID;

    // 1. Installation
    db.prepare(
      `INSERT INTO installation (
        id, app_name, shop_name, contact_phone, address, customer_notice,
        online_printing_enabled, default_production_printer_id,
        max_pdf_size_bytes, max_order_upload_bytes,
        identification_sheet_enabled, identification_sheet_placement,
        created_at_ms, updated_at_ms
      ) VALUES (1, 'PrintGo', 'PrintGo Fallback Lab', '+919876543210', 'Shop 12', 'Test Mode', 1, ?, 26214400, 52428800, 0, 'LAST', ?, ?)`,
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
    const pADuplex = opts?.printerADuplex ?? false;
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
      JSON.stringify({ colour: false, duplex: pADuplex, paperSizes: ["A4"] }),
      JSON.stringify({
        verified: { bw: 1, color: 0, duplex: pADuplex ? 1 : 0, a4: 1, a3: 0 },
        enabled: { bw: 1, color: 0, duplex: pADuplex ? 1 : 0, a4: 1, a3: 0 },
        requiresReview: pAReqReview,
      }),
      JSON.stringify({
        bw: 1,
        color: 0,
        duplex: pADuplex ? 1 : 0,
        a4: 1,
        a3: 0,
      }),
      nowMs,
      nowMs,
      nowMs,
    );

    // 4. Printer B: PrintGo Simulated Printer B
    const pBPriority = opts?.printerBPriority ?? 5;
    const pBEnabled = opts?.printerBEnabled ?? 1;
    const pBStatus = opts?.printerBStatus ?? "ONLINE";
    const pBPaused = opts?.printerBPaused ?? 0;
    const pBReqReview = opts?.printerBRequiresReview ?? 0;
    const pBColor = opts?.printerBColor ?? false;
    const pBDuplex = opts?.printerBDuplex ?? false;
    const pBA3 = opts?.printerBA3 ?? false;
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
      JSON.stringify({
        colour: pBColor,
        duplex: pBDuplex,
        paperSizes: pBA3 ? ["A4", "A3"] : ["A4"],
      }),
      JSON.stringify({
        verified: {
          bw: 1,
          color: pBColor ? 1 : 0,
          duplex: pBDuplex ? 1 : 0,
          a4: 1,
          a3: pBA3 ? 1 : 0,
        },
        enabled: {
          bw: 1,
          color: pBColor ? 1 : 0,
          duplex: pBDuplex ? 1 : 0,
          a4: 1,
          a3: pBA3 ? 1 : 0,
        },
        requiresReview: pBReqReview,
      }),
      JSON.stringify({
        bw: 1,
        color: pBColor ? 1 : 0,
        duplex: pBDuplex ? 1 : 0,
        a4: 1,
        a3: pBA3 ? 1 : 0,
      }),
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
      status?: string;
      unpaid?: boolean;
      files?: Array<{
        fileId: string;
        sourcePageCount: number;
        copies: number;
        selectedPages?: string;
        colorMode?: "BW" | "COLOR";
        sides?: "SINGLE" | "DOUBLE";
        paperSize?: "A4" | "A3";
      }>;
    },
  ) {
    const colorMode = opts?.colorMode ?? "BW";
    const sides = opts?.sides ?? "SINGLE";
    const paperSize = opts?.paperSize ?? "A4";
    const queuedAt = opts?.queuedAtMs ?? nowMs;
    const isPriority = opts?.isPriority ? 1 : 0;
    const assignedPrinterId = opts?.printerId ?? null;
    const orderStatus = opts?.status ?? "QUEUED";
    const isPaid = !(opts?.unpaid ?? false);

    db.prepare(
      `INSERT INTO orders (
        id, public_job_code, pickup_code, customer_name, customer_phone,
        original_filename, color_mode, paper_size, sides,
        printing_amount_paise, service_charge_paise, total_amount_paise,
        status, cleanup_state, is_priority, printer_id,
        created_at_ms, updated_at_ms, paid_at_ms, queued_at_ms
      ) VALUES (
        ?, ?, ?, 'Test Customer', '9876543210',
        'document.pdf', ?, ?, ?,
        1000, 0, 1000,
        ?, 'ACTIVE', ?, ?,
        ?, ?, ?, ?
      )`,
    ).run(
      orderId,
      `JOB-${orderId.slice(-6)}`,
      `PU-${orderId.slice(-6)}`,
      colorMode,
      paperSize,
      sides,
      orderStatus,
      isPriority,
      assignedPrinterId,
      queuedAt,
      queuedAt,
      isPaid ? queuedAt : null,
      orderStatus === "PAYMENT_PENDING" ? null : queuedAt,
    );

    const filesToInsert = opts?.files ?? [
      {
        fileId: crypto.randomUUID(),
        sourcePageCount: 1,
        copies: 1,
        colorMode,
        sides,
        paperSize,
      },
    ];

    for (const [idx, f] of filesToInsert.entries()) {
      const position = idx + 1;
      const fColor = f.colorMode ?? colorMode;
      const fSides = f.sides ?? sides;
      const fPaper = f.paperSize ?? paperSize;
      const fPages = f.selectedPages ?? "ALL";

      db.prepare(
        `INSERT INTO order_files (
          id, order_id, position, original_filename, r2_object_key,
          expected_size_bytes, size_bytes, uploaded_at_ms, source_page_count, selected_pages, copies,
          color_mode, paper_size, sides, upload_status, print_status, created_at_ms, updated_at_ms
        ) VALUES (
          ?, ?, ?, 'document.pdf', ?,
          1024, 1024, ?, ?, ?, ?,
          ?, ?, ?, 'UPLOADED', 'PENDING', ?, ?
        )`,
      ).run(
        f.fileId,
        orderId,
        position,
        `uploads/${orderId}/file-${position}.pdf`,
        queuedAt,
        f.sourcePageCount,
        fPages,
        f.copies,
        fColor,
        fPaper,
        fSides,
        queuedAt,
        queuedAt,
      );

      if (position === 1) {
        db.prepare(
          `INSERT INTO uploads (
            id, order_id, r2_object_key, original_filename, mime_type,
            size_bytes, storage_status, created_at_ms, uploaded_at_ms, updated_at_ms, expected_size_bytes
          ) VALUES (
            ?, ?, ?, 'document.pdf', 'application/pdf',
            1024, 'UPLOADED', ?, ?, ?, 1024
          )`,
        ).run(
          crypto.randomUUID(),
          orderId,
          `uploads/${orderId}/file-1.pdf`,
          queuedAt,
          queuedAt,
          queuedAt,
        );
      }
    }

    if (isPaid) {
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
        crypto.randomUUID(),
        orderId,
        `order_rzp_${orderId.slice(-8)}`,
        `pay_rzp_${orderId.slice(-8)}`,
        queuedAt,
        queuedAt,
        queuedAt,
      );
    }
  }

  async function completeStepSuccessfully(
    job: ClaimedJob,
    spoolerId: string,
    atMs: number,
  ) {
    await repo.startStep({
      orderId: job.orderId,
      stepId: job.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: job.claimId,
      nowMs: atMs,
    });
    await repo.recordSubmission({
      orderId: job.orderId,
      stepId: job.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: job.claimId,
      spoolerJobId: spoolerId,
      nowMs: atMs,
    });
    await repo.recordResult({
      orderId: job.orderId,
      stepId: job.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: job.claimId,
      spoolerJobId: spoolerId,
      status: "SUCCEEDED",
      failureCode: null,
      failureDetail: null,
      nowMs: atMs + 1000,
    });
  }

  // --------------------------------------------------------------------------
  // TEST 3B.1: Preferred printer fails before submission
  // Printer A selected -> preflight fails -> fallback selects Printer B -> exactly 1 submission
  // --------------------------------------------------------------------------
  it("3B.1 — Preferred printer fails before submission: safe fallback to Printer B with zero submissions on Printer A", async () => {
    seedAgentAndPrinters();
    const orderId = "30000000-0000-4000-8000-000000000001";
    seedPaidOrder(orderId);

    // 1. Agent claims order -> routed to Printer A (Priority 10)
    const claim = await repo.claimOrRenew(AGENT_ID, nowMs);
    expect(claim).not.toBeNull();
    expect(claim?.printerId).toBe(PRINTER_A_ID);
    const step1Id = claim!.currentStep.stepId;

    // 2. Preflight detects failure on Printer A before physical submission starts
    const fallbackRes = await repo.handlePreflightFailure({
      orderId,
      stepId: step1Id,
      claimId: claim!.claimId,
      agentId: AGENT_ID,
      failureCode: "PAPER_JAM",
      failureDetail: "Printer A paper path blocked",
      nowMs: nowMs + 1000,
    });

    expect(fallbackRes.action).toBe("FALLBACK_ASSIGNED");
    expect(fallbackRes.fallbackPrinterName).toBe("PrintGo Simulated Printer B");
    expect(fallbackRes.printJob?.printerId).toBe(PRINTER_B_ID);

    // 3. Verify database attempt provenance
    const attempts = db
      .prepare(
        `SELECT id, printer_id, status, fallback_from_printer_id, fallback_reason FROM print_attempts WHERE order_id = ? ORDER BY attempt_number ASC`,
      )
      .all(orderId) as Array<{
      id: string;
      printer_id: string;
      status: string;
      fallback_from_printer_id: string | null;
      fallback_reason: string | null;
    }>;

    expect(attempts).toHaveLength(2);
    // Attempt 1 on Printer A was marked FAILED with 0 physical submissions
    expect(attempts[0]?.printer_id).toBe(PRINTER_A_ID);
    expect(attempts[0]?.status).toBe("FAILED");
    // Attempt 2 on Printer B was created with fallback provenance
    expect(attempts[1]?.printer_id).toBe(PRINTER_B_ID);
    expect(attempts[1]?.status).toBe("CREATED");
    expect(attempts[1]?.fallback_from_printer_id).toBe(PRINTER_A_ID);
    expect(attempts[1]?.fallback_reason).toBe("PAPER_JAM");

    // 4. Execute physical submission on Printer B and complete
    const attempt2Job = fallbackRes.printJob!;
    await completeStepSuccessfully(
      attempt2Job,
      "spool-printer-b-101",
      nowMs + 2000,
    );

    // 5. Final state verification: exactly 1 physical submission occurred (on B)
    const finalOrder = db
      .prepare(
        `SELECT status, printer_id, fallback_count FROM orders WHERE id = ?`,
      )
      .get(orderId) as {
      status: string;
      printer_id: string;
      fallback_count: number;
    };
    expect(finalOrder.status).toBe("COMPLETED");
    expect(finalOrder.printer_id).toBe(PRINTER_B_ID);
    expect(finalOrder.fallback_count).toBe(1);
  });

  // --------------------------------------------------------------------------
  // TEST 3B.2: Printer offline before claim
  // Printer A is OFFLINE before claim -> Claim routes directly to Printer B
  // --------------------------------------------------------------------------
  it("3B.2 — Printer offline before claim: routes directly to Printer B with no claim on Printer A", async () => {
    seedAgentAndPrinters({
      printerAStatus: "OFFLINE", // Printer A is offline
      printerBStatus: "ONLINE",
      autoFallbackEnabled: 1,
      fallbackPrinterId: PRINTER_B_ID,
    });

    const orderId = "30000000-0000-4000-8000-000000000002";
    seedPaidOrder(orderId);

    // Claim pulse directly assigns Printer B
    const claim = await repo.claimOrRenew(AGENT_ID, nowMs);
    expect(claim).not.toBeNull();
    expect(claim?.printerId).toBe(PRINTER_B_ID);

    // Verify Printer A was NEVER claimed
    const attempts = db
      .prepare(`SELECT printer_id FROM print_attempts WHERE order_id = ?`)
      .all(orderId) as Array<{ printer_id: string }>;
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.printer_id).toBe(PRINTER_B_ID);
  });

  // --------------------------------------------------------------------------
  // TEST 3B.3: Printer paused or paper-out before submission
  // Printer A becomes unavailable before submission -> Provably 0 submissions -> Safe fallback
  // --------------------------------------------------------------------------
  it("3B.3 — Printer paused or paper-out before submission: safe fallback permitted when zero submission is proven", async () => {
    seedAgentAndPrinters();
    const orderId = "30000000-0000-4000-8000-000000000003";
    seedPaidOrder(orderId);

    const claim = await repo.claimOrRenew(AGENT_ID, nowMs);
    expect(claim?.printerId).toBe(PRINTER_A_ID);

    // Preflight detects PAPER_OUT before submission begins
    const fallbackRes = await repo.handlePreflightFailure({
      orderId,
      stepId: claim!.currentStep.stepId,
      claimId: claim!.claimId,
      agentId: AGENT_ID,
      failureCode: "PAPER_OUT",
      failureDetail: "Tray 1 empty",
      nowMs: nowMs + 1000,
    });

    expect(fallbackRes.action).toBe("FALLBACK_ASSIGNED");
    expect(fallbackRes.printJob?.printerId).toBe(PRINTER_B_ID);
  });

  // --------------------------------------------------------------------------
  // TEST 3B.4: Fallback disabled
  // Printer A fails preflight, but auto_fallback_enabled = 0 -> Releases lease with backoff
  // --------------------------------------------------------------------------
  it("3B.4 — Fallback disabled: does not switch to Printer B, releases claim to RETRY_PENDING", async () => {
    seedAgentAndPrinters({
      autoFallbackEnabled: 0, // Fallback toggle disabled
      fallbackPrinterId: null,
    });
    const orderId = "30000000-0000-4000-8000-000000000004";
    seedPaidOrder(orderId);

    const claim = await repo.claimOrRenew(AGENT_ID, nowMs);
    expect(claim?.printerId).toBe(PRINTER_A_ID);

    const fallbackRes = await repo.handlePreflightFailure({
      orderId,
      stepId: claim!.currentStep.stepId,
      claimId: claim!.claimId,
      agentId: AGENT_ID,
      failureCode: "PAPER_JAM",
      nowMs: nowMs + 1000,
    });

    // Branch B: No fallback permitted -> BLOCKED_RELEASED
    expect(fallbackRes.action).toBe("BLOCKED_RELEASED");

    const orderRow = db
      .prepare(
        `SELECT status, claimed_by_agent_id, claim_id, fallback_count, next_retry_at_ms FROM orders WHERE id = ?`,
      )
      .get(orderId) as {
      status: string;
      claimed_by_agent_id: string | null;
      claim_id: string | null;
      fallback_count: number;
      next_retry_at_ms: number | null;
    };

    expect(orderRow.status).toBe("RETRY_PENDING");
    expect(orderRow.claimed_by_agent_id).toBeNull();
    expect(orderRow.claim_id).toBeNull();
    expect(orderRow.fallback_count).toBe(1);
    expect(orderRow.next_retry_at_ms).toBeGreaterThan(nowMs);
  });

  // --------------------------------------------------------------------------
  // TEST 3B.5: Fallback printer incompatible
  // Order requires DUPLEX, Printer B is single-sided only -> Fallback rejected
  // --------------------------------------------------------------------------
  it("3B.5 — Fallback printer incompatible: never selects incapable Printer B, releases claim", async () => {
    seedAgentAndPrinters({
      printerADuplex: true,
      printerBDuplex: false, // Printer B cannot print duplex!
    });
    const orderId = "30000000-0000-4000-8000-000000000005";
    // Double-sided order
    seedPaidOrder(orderId, { sides: "DOUBLE" });

    // Manually claim on Printer A for test preflight evaluation
    db.prepare(`UPDATE orders SET printer_id = ? WHERE id = ?`).run(
      PRINTER_A_ID,
      orderId,
    );
    const claim = await repo.claimOrRenew(AGENT_ID, nowMs);
    expect(claim?.printerId).toBe(PRINTER_A_ID);

    const fallbackRes = await repo.handlePreflightFailure({
      orderId,
      stepId: claim!.currentStep.stepId,
      claimId: claim!.claimId,
      agentId: AGENT_ID,
      failureCode: "PAPER_JAM",
      nowMs: nowMs + 1000,
    });

    // Printer B cannot do DUPLEX -> fallback rejected, claim released
    expect(fallbackRes.action).toBe("BLOCKED_RELEASED");
    const orderRow = db
      .prepare(`SELECT status, printer_id FROM orders WHERE id = ?`)
      .get(orderId) as { status: string; printer_id: string };
    expect(orderRow.status).toBe("RETRY_PENDING");
  });

  // --------------------------------------------------------------------------
  // TEST 3B.6: Both printers unavailable
  // Both printers OFFLINE -> Preflight fails closed, claim returns null
  // --------------------------------------------------------------------------
  it("3B.6 — Both printers unavailable: fails closed with no claim and no submission", async () => {
    seedAgentAndPrinters({
      printerAStatus: "OFFLINE",
      printerBStatus: "OFFLINE",
    });
    const orderId = "30000000-0000-4000-8000-000000000006";
    seedPaidOrder(orderId);

    // Preflight readiness check fails closed
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
  // TEST 3B.7: Failure after submission begins
  // Failure occurs AFTER SUBMISSION_STARTED -> STRICTLY PROHIBITS automatic fallback
  // --------------------------------------------------------------------------
  it("3B.7 — Failure after submission begins: strictly prohibits fallback to Printer B, moves to ADMIN_ACTION_REQUIRED", async () => {
    seedAgentAndPrinters();
    const orderId = "30000000-0000-4000-8000-000000000007";
    seedPaidOrder(orderId);

    const claim = await repo.claimOrRenew(AGENT_ID, nowMs);
    expect(claim?.printerId).toBe(PRINTER_A_ID);

    // Advance step to SUBMISSION_STARTED (the irreversible boundary)
    db.prepare(
      `UPDATE print_attempt_steps SET status = 'SUBMISSION_STARTED', updated_at_ms = ? WHERE id = ?`,
    ).run(nowMs + 500, claim!.currentStep.stepId);

    // Report preflight failure after submission started
    const fallbackRes = await repo.handlePreflightFailure({
      orderId,
      stepId: claim!.currentStep.stepId,
      claimId: claim!.claimId,
      agentId: AGENT_ID,
      failureCode: "SPOOLER_ERROR",
      failureDetail: "Spooler RPC failed during write",
      nowMs: nowMs + 1000,
    });

    // Automatic fallback is STRICTLY PROHIBITED
    expect(fallbackRes.action).toBe("ACTION_REQUIRED");

    // Order transitions to ADMIN_ACTION_REQUIRED with COMPLETION_UNKNOWN
    const orderRow = db
      .prepare(`SELECT status, error_category FROM orders WHERE id = ?`)
      .get(orderId) as { status: string; error_category: string };
    expect(orderRow.status).toBe("ADMIN_ACTION_REQUIRED");
    expect(orderRow.error_category).toBe("COMPLETION_UNKNOWN");

    // Zero print attempts created on Printer B
    const attempts = db
      .prepare(`SELECT printer_id FROM print_attempts WHERE order_id = ?`)
      .all(orderId) as Array<{ printer_id: string }>;
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.printer_id).toBe(PRINTER_A_ID);
  });

  // --------------------------------------------------------------------------
  // TEST 3B.8: Spooler acknowledgment lost
  // Spooler job fast-despools or unobserved -> Agent marks UNCERTAIN -> Operator review
  // --------------------------------------------------------------------------
  it("3B.8 — Spooler acknowledgment lost: records UNCERTAIN without automatic reprint or fallback", async () => {
    seedAgentAndPrinters();
    const orderId = "30000000-0000-4000-8000-000000000008";
    seedPaidOrder(orderId);

    const claim = await repo.claimOrRenew(AGENT_ID, nowMs);

    // Record step result as UNCERTAIN due to lost spooler correlation
    const result = await repo.recordResult({
      orderId,
      stepId: claim!.currentStep.stepId,
      claimId: claim!.claimId,
      agentId: AGENT_ID,
      spoolerJobId: "unobserved-spool-999",
      status: "UNCERTAIN",
      failureCode: "UNKNOWN",
      failureDetail: "Windows accepted job but spooler disappeared instantly",
      nowMs: nowMs + 1000,
    });

    expect(result).not.toBeNull();
    const orderRow = db
      .prepare(`SELECT status, error_category FROM orders WHERE id = ?`)
      .get(orderId) as { status: string; error_category: string };
    expect(orderRow.status).toBe("COMPLETION_UNKNOWN");
    expect(orderRow.error_category).toBe("COMPLETION_UNKNOWN");

    // Next claim pulse CANNOT automatically claim this order
    const nextClaim = await repo.claimOrRenew(AGENT_ID, nowMs + 5000);
    expect(nextClaim).toBeNull();
  });

  // --------------------------------------------------------------------------
  // TEST 3B.9: Network interruption after submission
  // Network fails after submission -> Durable journal retains spoolerJobId on disk
  // --------------------------------------------------------------------------
  it("3B.9 — Network interruption after submission: durable journal retains spooler ID to prevent duplicate print", async () => {
    const tempDir = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), "printgo-journal-test-"),
    );
    tempDirs.push(tempDir);
    const journalFile = path.join(tempDir, "active-print.json");

    const orderId = "30000000-0000-4000-8000-000000000009";
    const attemptId = "attempt-009";
    const stepId = "step-009";
    const spoolerJobId = "windows-spool-42";

    // 1. Agent records submission in local durable execution journal on disk
    await fsPromises.writeFile(
      journalFile,
      JSON.stringify({
        orderId,
        attemptId,
        stepId,
        spoolerJobId,
        updatedAtMs: nowMs,
      }),
      "utf8",
    );

    // 2. Simulate process crash / network interruption, then agent restarts and reads journal
    const recovered = JSON.parse(
      await fsPromises.readFile(journalFile, "utf8"),
    ) as {
      orderId: string;
      spoolerJobId: string;
    };
    expect(recovered).not.toBeNull();
    expect(recovered.orderId).toBe(orderId);
    expect(recovered.spoolerJobId).toBe(spoolerJobId);

    // 3. Worker repository verifies recordSubmission idempotency: repeated submission with same spooler ID is safely accepted
    seedAgentAndPrinters();
    seedPaidOrder(orderId);
    const claim = await repo.claimOrRenew(AGENT_ID, nowMs);
    await repo.startStep({
      orderId,
      stepId: claim!.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: claim!.claimId,
      nowMs,
    });
    const sub1 = await repo.recordSubmission({
      orderId,
      stepId: claim!.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: claim!.claimId,
      spoolerJobId,
      nowMs,
    });
    expect(sub1).not.toBeNull();
    // Replay after network recovery
    const sub2 = await repo.recordSubmission({
      orderId,
      stepId: claim!.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: claim!.claimId,
      spoolerJobId,
      nowMs: nowMs + 1000,
    });
    expect(sub2).not.toBeNull();
    expect(sub2?.spooler_job_id).toBe(spoolerJobId);
  });

  // --------------------------------------------------------------------------
  // TEST 3B.10: Agent crash before submission
  // Crash occurs before startPrintStep -> Step remains PENDING -> Safe retry permitted
  // --------------------------------------------------------------------------
  it("3B.10 — Agent crash before submission: provably zero submission allows safe renewal and retry", async () => {
    seedAgentAndPrinters();
    const orderId = "30000000-0000-4000-8000-000000000010";
    seedPaidOrder(orderId);

    const claim = await repo.claimOrRenew(AGENT_ID, nowMs);
    expect(claim?.currentStep.status).toBe("PENDING");

    // Agent restarts: claimOrRenew safely renews the active lease
    const renewed = await repo.claimOrRenew(AGENT_ID, nowMs + 10_000);
    expect(renewed?.orderId).toBe(orderId);
    expect(renewed?.printerId).toBe(PRINTER_A_ID);
    expect(renewed?.currentStep.status).toBe("PENDING");
  });

  // --------------------------------------------------------------------------
  // TEST 3B.11: Agent crash after submission begins
  // Step reached SUBMISSION_STARTED, Agent crashes without spooler ID -> PaidPrintExecutor reports UNCERTAIN
  // --------------------------------------------------------------------------
  it("3B.11 — Agent crash after submission begins: PaidPrintExecutor reports UNCERTAIN on restart without confirmed spooler ID", async () => {
    seedAgentAndPrinters();
    const orderId = "30000000-0000-4000-8000-000000000011";
    seedPaidOrder(orderId);

    const claim = await repo.claimOrRenew(AGENT_ID, nowMs);
    expect(claim?.currentStep.status).toBe("PENDING");

    // 1. Agent starts submission -> step moves to SUBMISSION_STARTED
    await repo.startStep({
      orderId,
      stepId: claim!.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: claim!.claimId,
      nowMs: nowMs + 1000,
    });

    // 2. Agent process crashes mid-submission! On restart, the agent detects
    // step is in SUBMISSION_STARTED with no confirmed spooler ID.
    // It reports status UNCERTAIN to the Cloudflare Worker repository.
    const res = await repo.recordResult({
      orderId,
      stepId: claim!.currentStep.stepId,
      claimId: claim!.claimId,
      agentId: AGENT_ID,
      status: "UNCERTAIN",
      spoolerJobId: null,
      failureCode: "UNKNOWN",
      failureDetail:
        "Process crash mid-submission with no confirmed spooler ID",
      nowMs: nowMs + 2000,
    });

    expect(res).not.toBeNull();
    const orderRow = db
      .prepare(`SELECT status, error_category FROM orders WHERE id = ?`)
      .get(orderId) as { status: string; error_category: string };
    expect(orderRow.status).toBe("COMPLETION_UNKNOWN");
    expect(orderRow.error_category).toBe("COMPLETION_UNKNOWN");

    // 3. System strictly prevents automatic reprint or fallback without human intervention
    const nextClaim = await repo.claimOrRenew(AGENT_ID, nowMs + 10_000);
    expect(nextClaim).toBeNull();
  });

  // --------------------------------------------------------------------------
  // TEST 3B.12: Retry backoff timing
  // Gated backoff prevents tight polling loop before next_retry_at_ms
  // --------------------------------------------------------------------------
  it("3B.12 — Retry backoff: respects next_retry_at_ms and prevents busy claim loops", async () => {
    seedAgentAndPrinters({
      autoFallbackEnabled: 0,
      fallbackPrinterId: null,
    });
    const orderId = "30000000-0000-4000-8000-000000000012";
    seedPaidOrder(orderId);

    const claim = await repo.claimOrRenew(AGENT_ID, nowMs);
    const fallbackRes = await repo.handlePreflightFailure({
      orderId,
      stepId: claim!.currentStep.stepId,
      claimId: claim!.claimId,
      agentId: AGENT_ID,
      failureCode: "PAPER_JAM",
      nowMs,
    });

    expect(fallbackRes.action).toBe("BLOCKED_RELEASED");
    const backoffMs = fallbackRes.retryAfterMs ?? 30_000;
    const retryAtMs = nowMs + backoffMs;

    // Pulse at nowMs + 10_000 (BEFORE next_retry_at_ms arrives) -> MUST be null
    const earlyClaim = await repo.claimOrRenew(AGENT_ID, nowMs + 10_000);
    expect(earlyClaim).toBeNull();

    // Operator clears the paper jam and unpauses Printer A
    db.prepare(
      `UPDATE printers SET is_paused = 0, paused_reason = NULL WHERE id = ?`,
    ).run(PRINTER_A_ID);
    db.prepare(`UPDATE agents SET last_heartbeat_at_ms = ? WHERE id = ?`).run(
      retryAtMs + 1,
      AGENT_ID,
    );

    // Pulse at nowMs + retryAfterMs (AFTER next_retry_at_ms arrives) -> Can be claimed
    const unblockedClaim = await repo.claimOrRenew(AGENT_ID, retryAtMs + 1);
    expect(unblockedClaim).not.toBeNull();
    expect(unblockedClaim?.orderId).toBe(orderId);
  });

  // --------------------------------------------------------------------------
  // TEST 3B.13: Retry limits and backoff cap
  // Repeated failures cap backoff at 300,000ms
  // --------------------------------------------------------------------------
  it("3B.13 — Retry exhaustion: caps backoff at 300,000ms and limits unconstrained retries", async () => {
    seedAgentAndPrinters({
      autoFallbackEnabled: 0,
      fallbackPrinterId: null,
    });
    const orderId = "30000000-0000-4000-8000-000000000013";
    seedPaidOrder(orderId);

    // Preflight fails: 3 retries (60s -> 90s -> 90s), then stops on 4th failure
    let currentNow = nowMs;
    for (let i = 1; i <= 3; i++) {
      const claim = await repo.claimOrRenew(AGENT_ID, currentNow);
      expect(claim).not.toBeNull();
      const res = await repo.handlePreflightFailure({
        orderId,
        stepId: claim!.currentStep.stepId,
        claimId: claim!.claimId,
        agentId: AGENT_ID,
        failureCode: "PAPER_JAM",
        nowMs: currentNow,
      });
      expect(res.action).toBe("BLOCKED_RELEASED");
      expect(res.retryAfterMs).toBeLessThanOrEqual(90_000);

      // Operator clears paper jam and agent heartbeat pulses
      db.prepare(
        `UPDATE printers SET is_paused = 0, paused_reason = NULL WHERE id = ?`,
      ).run(PRINTER_A_ID);
      currentNow += (res.retryAfterMs ?? 90_000) + 1;
      db.prepare(`UPDATE agents SET last_heartbeat_at_ms = ? WHERE id = ?`).run(
        currentNow,
        AGENT_ID,
      );
    }

    // 4th failure (Retry 3 fails) -> Exhausted -> ACTION_REQUIRED
    const claim4 = await repo.claimOrRenew(AGENT_ID, currentNow);
    expect(claim4).not.toBeNull();
    const res4 = await repo.handlePreflightFailure({
      orderId,
      stepId: claim4!.currentStep.stepId,
      claimId: claim4!.claimId,
      agentId: AGENT_ID,
      failureCode: "PAPER_JAM",
      nowMs: currentNow,
    });
    expect(res4.action).toBe("ACTION_REQUIRED");

    const orderRow = db
      .prepare(`SELECT status, fallback_count FROM orders WHERE id = ?`)
      .get(orderId) as { status: string; fallback_count: number };
    expect(orderRow.status).toBe("ADMIN_ACTION_REQUIRED");
    expect(orderRow.fallback_count).toBe(4);
  });

  // --------------------------------------------------------------------------
  // TEST 3B.14: Physical-device lock protection
  // Printer A and Printer B share hardware ID -> Concurrent submission blocked
  // --------------------------------------------------------------------------
  it("3B.14 — Physical-device lock protection: shared hardware ID prevents concurrent conflicting submissions", async () => {
    const SHARED_HW = "SHARED_PHYSICAL_ENGINE_01";
    seedAgentAndPrinters({
      printerAPhysicalDeviceId: SHARED_HW,
      printerBPhysicalDeviceId: SHARED_HW, // Shared engine!
    });

    const o1 = "30000000-0000-4000-8000-000000000014";
    const o2 = "30000000-0000-4000-8000-000000000015";
    seedPaidOrder(o1, { queuedAtMs: nowMs - 5000 });
    seedPaidOrder(o2, { queuedAtMs: nowMs });

    // Claim jobs: only Order 1 is claimed; Order 2 blocked by shared engine lock
    const activeJobs = await repo.claimOrRenewAll(AGENT_ID, nowMs);
    expect(activeJobs).toHaveLength(1);
    expect(activeJobs[0]?.orderId).toBe(o1);

    const o2Row = db
      .prepare(`SELECT status FROM orders WHERE id = ?`)
      .get(o2) as { status: string };
    expect(o2Row.status).toBe("QUEUED");
  });

  // --------------------------------------------------------------------------
  // TEST 3B.15: Concurrent fallback race
  // Two parallel calls attempt fallback on the same order -> Exactly one succeeds
  // --------------------------------------------------------------------------
  it("3B.15 — Concurrent fallback race: atomic D1 batch grants exactly one fallback lease", async () => {
    seedAgentAndPrinters();
    const orderId = "30000000-0000-4000-8000-000000000016";
    seedPaidOrder(orderId);

    const claim = await repo.claimOrRenew(AGENT_ID, nowMs);
    expect(claim).not.toBeNull();

    // Two race attempts on handlePreflightFailure
    const results = await Promise.allSettled([
      repo.handlePreflightFailure({
        orderId,
        stepId: claim!.currentStep.stepId,
        claimId: claim!.claimId,
        agentId: AGENT_ID,
        failureCode: "PAPER_JAM",
        nowMs: nowMs + 1000,
      }),
      repo.handlePreflightFailure({
        orderId,
        stepId: claim!.currentStep.stepId,
        claimId: claim!.claimId,
        agentId: AGENT_ID,
        failureCode: "PAPER_JAM",
        nowMs: nowMs + 1000,
      }),
    ]);

    // Exactly one call succeeds in authoring fallback, the second is aborted / unique constraint prevented
    const fulfilled = results
      .filter(
        (
          r,
        ): r is PromiseFulfilledResult<
          Awaited<ReturnType<typeof repo.handlePreflightFailure>>
        > => r.status === "fulfilled",
      )
      .map((r) => r.value);
    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]?.action).toBe("FALLBACK_ASSIGNED");

    // Total attempts created: exactly 2 (Attempt 1 on A, Attempt 2 on B)
    const attempts = db
      .prepare(`SELECT id FROM print_attempts WHERE order_id = ?`)
      .all(orderId) as Array<{ id: string }>;
    expect(attempts).toHaveLength(2);
  });

  // --------------------------------------------------------------------------
  // TEST 3B.17: Payment and capability safety
  // Unpaid, unverified, or disabled printers cannot claim or receive fallback
  // --------------------------------------------------------------------------
  it("3B.17 — Payment and capability safety: rejects unpaid orders and unverified printer configurations", async () => {
    seedAgentAndPrinters();

    // 1. Unpaid order
    const unpaidId = "30000000-0000-4000-8000-000000000017";
    seedPaidOrder(unpaidId, { status: "PAYMENT_PENDING", unpaid: true });
    const unpaidClaim = await repo.claimOrRenew(AGENT_ID, nowMs);
    expect(unpaidClaim).toBeNull();

    // 2. Unverified printer (requiresReview = 1) with priority routing
    db.prepare(
      `UPDATE installation SET default_production_printer_id = NULL WHERE id = 1`,
    ).run();
    db.prepare(
      `UPDATE printers SET verified_capabilities_json = json_set(verified_capabilities_json, '$.requiresReview', 1) WHERE id = ?`,
    ).run(PRINTER_A_ID);
    const paidId = "30000000-0000-4000-8000-000000000018";
    seedPaidOrder(paidId);

    const unverifiedClaim = await repo.claimOrRenew(AGENT_ID, nowMs + 1000);
    // Skips Printer A and routes to Printer B
    expect(unverifiedClaim?.printerId).toBe(PRINTER_B_ID);
  });

  // --------------------------------------------------------------------------
  // TEST 3B.18: Recovery after Admin reconciliation
  // Admin inspects uncertain order and calls retryOrder with forceUncertain
  // --------------------------------------------------------------------------
  it("3B.18 — Recovery after Admin reconciliation: requires forceUncertain, resets to QUEUED, and completes safely", async () => {
    seedAgentAndPrinters();
    const orderId = "30000000-0000-4000-8000-000000000019";
    seedPaidOrder(orderId);

    const claim = await repo.claimOrRenew(AGENT_ID, nowMs);

    // Transition order to COMPLETION_UNKNOWN
    await repo.recordResult({
      orderId,
      stepId: claim!.currentStep.stepId,
      claimId: claim!.claimId,
      agentId: AGENT_ID,
      spoolerJobId: "spool-lost-99",
      status: "UNCERTAIN",
      failureCode: "UNKNOWN",
      failureDetail: "Spooler state uncertain",
      nowMs: nowMs + 1000,
    });

    // 1. Admin attempts retry WITHOUT forceUncertain -> MUST fail
    await expect(
      repo.retryOrder({
        orderId,
        adminId: "admin-user",
        nowMs: nowMs + 5000,
      }),
    ).rejects.toThrow("UNCERTAIN_RETRY_CONFIRMATION_REQUIRED");

    // 2. Admin confirms physical inspection -> retries WITH forceUncertain: true
    const retryRes = await repo.retryOrder({
      orderId,
      adminId: "admin-user",
      forceUncertain: true,
      nowMs: nowMs + 6000,
    });
    expect(retryRes.status).toBe("QUEUED");

    // 3. Order is now clean and eligible for claiming
    const newClaim = await repo.claimOrRenew(AGENT_ID, nowMs + 7000);
    expect(newClaim).not.toBeNull();
    expect(newClaim?.orderId).toBe(orderId);

    // 4. Completes successfully
    await completeStepSuccessfully(
      newClaim!,
      "spool-verified-100",
      nowMs + 8000,
    );

    const finalOrder = db
      .prepare(`SELECT status FROM orders WHERE id = ?`)
      .get(orderId) as { status: string };
    expect(finalOrder.status).toBe("COMPLETED");
  });

  // --------------------------------------------------------------------------
  // TEST 3B.16: Multi-file order integrity
  // File 1 (3p, 3c = 9) on A; File 2 (2p, 4c = 8) on B. Total = 17 impressions.
  // --------------------------------------------------------------------------
  it("3B.16 — Multi-file order integrity: File 1 prints on A, File 2 falls back to B, total exactly 17 page impressions", async () => {
    seedAgentAndPrinters();
    const orderId = "30000000-0000-4000-8000-000000000020";
    const f1Id = "40000000-0000-4000-8000-000000000001";
    const f2Id = "40000000-0000-4000-8000-000000000002";

    seedPaidOrder(orderId, {
      files: [
        { fileId: f1Id, sourcePageCount: 3, copies: 3 }, // 3 * 3 = 9 impressions
        { fileId: f2Id, sourcePageCount: 2, copies: 4 }, // 2 * 4 = 8 impressions
      ],
    });

    // 1. Claim File 1 on Printer A
    const claim1 = await repo.claimOrRenew(AGENT_ID, nowMs);
    expect(claim1?.orderId).toBe(orderId);
    expect(claim1?.printerId).toBe(PRINTER_A_ID);
    expect(claim1?.fileId).toBe(f1Id);
    expect(claim1?.copies).toBe(3);
    expect(claim1?.sourcePageCount).toBe(3);

    // Complete File 1 on Printer A
    await completeStepSuccessfully(claim1!, "spool-f1", nowMs + 1000);

    // Verify File 1 is PRINTED
    const f1Row = db
      .prepare(`SELECT print_status FROM order_files WHERE id = ?`)
      .get(f1Id) as { print_status: string };
    expect(f1Row.print_status).toBe("PRINTED");

    // 2. Next claim pulse claims File 2 on Printer A
    const claim2 = await repo.claimOrRenew(AGENT_ID, nowMs + 2000);
    expect(claim2?.orderId).toBe(orderId);
    expect(claim2?.printerId).toBe(PRINTER_A_ID);
    expect(claim2?.fileId).toBe(f2Id);
    expect(claim2?.copies).toBe(4);
    expect(claim2?.sourcePageCount).toBe(2);

    // 3. Preflight on File 2 fails on Printer A (PAPER_JAM)
    const fallbackRes = await repo.handlePreflightFailure({
      orderId,
      stepId: claim2!.currentStep.stepId,
      claimId: claim2!.claimId,
      agentId: AGENT_ID,
      failureCode: "PAPER_JAM",
      nowMs: nowMs + 3000,
    });

    expect(fallbackRes.action).toBe("FALLBACK_ASSIGNED");
    expect(fallbackRes.printJob?.printerId).toBe(PRINTER_B_ID);
    expect(fallbackRes.printJob?.fileId).toBe(f2Id);

    // 4. File 2 completes on Printer B
    await completeStepSuccessfully(
      fallbackRes.printJob!,
      "spool-f2-on-b",
      nowMs + 4000,
    );

    // 5. Verify whole order is now COMPLETED
    const finalOrder = db
      .prepare(`SELECT status FROM orders WHERE id = ?`)
      .get(orderId) as { status: string };
    expect(finalOrder.status).toBe("COMPLETED");

    // 6. Verify impressions: File 1 (3p * 3c = 9) + File 2 (2p * 4c = 8) = 17 total page impressions
    const files = db
      .prepare(
        `SELECT source_page_count, copies, print_status FROM order_files WHERE order_id = ? ORDER BY position ASC`,
      )
      .all(orderId) as Array<{
      source_page_count: number;
      copies: number;
      print_status: string;
    }>;

    expect(files).toHaveLength(2);
    expect(files[0]?.print_status).toBe("PRINTED");
    expect(files[1]?.print_status).toBe("PRINTED");

    const totalImpressions = files.reduce(
      (sum, f) => sum + f.source_page_count * f.copies,
      0,
    );
    expect(totalImpressions).toBe(17);
  });
});
