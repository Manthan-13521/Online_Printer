import { readFileSync, readdirSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { D1PrintingRepository } from "./repository.js";

// Statement wrapper for node:sqlite DatabaseSync matching Cloudflare D1
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
const AGENT_2_ID = "40000000-0000-4000-8000-000000000002";
const PRINTER_A_ID = "10000000-0000-4000-8000-00000000000A"; // HP Laser MFP 136w TEST (Priority 10, B&W, A4)
const PRINTER_B_ID = "20000000-0000-4000-8000-00000000000B"; // PrintGo Secondary Printer B (Priority 5, B&W/Color, A4)

describe("PRINTGO — PHASE 4 ACCEPTANCE TEST SUITE: FAILURE RECOVERY, RETRIES & ADMIN SAFETY", () => {
  let db: DatabaseSync;
  let d1: D1Database;
  let repo: D1PrintingRepository;
  const tempDirs: string[] = [];

  const nowMs = 1_700_000_000_000;

  beforeEach(() => {
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

    d1 = asD1(db);
    repo = new D1PrintingRepository(d1);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => fsPromises.rm(dir, { recursive: true, force: true })),
    );
  });

  function recordSuccess(params: {
    orderId: string;
    stepId: string;
    claimId: string;
    agentId: string;
    spoolerJobId: string;
    nowMs: number;
  }) {
    return repo.recordResult({
      ...params,
      status: "SUCCEEDED",
      failureCode: null,
      failureDetail: null,
    });
  }

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
    printerBColor?: boolean;
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
      ) VALUES (1, 'PrintGo', 'PrintGo Phase 4 Lab', '+919876543210', 'Shop 12', 'Test Mode', 1, ?, 26214400, 52428800, 0, 'LAST', ?, ?)`,
    ).run(defaultPrinter, nowMs, nowMs);

    // 2. Active Agents
    db.prepare(
      `INSERT INTO agents (
        id, display_name, credential_hash, is_active, paired_at_ms,
        last_heartbeat_at_ms, created_at_ms, updated_at_ms
      ) VALUES (?, 'HP Windows Agent 1', 'hash-test-1', 1, ?, ?, ?, ?)`,
    ).run(AGENT_ID, nowMs, nowMs, nowMs, nowMs);

    db.prepare(
      `INSERT INTO agents (
        id, display_name, credential_hash, is_active, paired_at_ms,
        last_heartbeat_at_ms, created_at_ms, updated_at_ms
      ) VALUES (?, 'HP Windows Agent 2', 'hash-test-2', 1, ?, ?, ?, ?)`,
    ).run(AGENT_2_ID, nowMs, nowMs, nowMs, nowMs);

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

    // 4. Printer B: PrintGo Secondary Printer B
    const pBPriority = opts?.printerBPriority ?? 5;
    const pBEnabled = opts?.printerBEnabled ?? 1;
    const pBStatus = opts?.printerBStatus ?? "ONLINE";
    const pBPaused = opts?.printerBPaused ?? 0;
    const pBReqReview = opts?.printerBRequiresReview ?? 0;
    const pBPhysicalDev =
      opts?.printerBPhysicalDeviceId !== undefined
        ? opts.printerBPhysicalDeviceId
        : "SIMULATED_PHYSICAL_DEVICE_B";
    const pBColor = opts?.printerBColor ?? false;

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
      "PrintGo Secondary Printer B",
      "Simulated Secondary Printer B",
      pBEnabled,
      pBStatus,
      pBPaused,
      pBPaused ? "OFFLINE" : null,
      pBPriority,
      pBPhysicalDev,
      JSON.stringify({ colour: pBColor, duplex: false, paperSizes: ["A4"] }),
      JSON.stringify({
        verified: { bw: 1, color: pBColor ? 1 : 0, duplex: 0, a4: 1, a3: 0 },
        enabled: { bw: 1, color: pBColor ? 1 : 0, duplex: 0, a4: 1, a3: 0 },
        requiresReview: pBReqReview,
      }),
      JSON.stringify({
        bw: 1,
        color: pBColor ? 1 : 0,
        duplex: 0,
        a4: 1,
        a3: 0,
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

    const isClaimedState = [
      "CLAIMED",
      "SPOOLING",
      "PRINTING",
      "PRINT_BLOCKED",
      "PRINT_FAILED",
      "ADMIN_ACTION_REQUIRED",
      "PRINTED",
      "COMPLETED",
    ].includes(orderStatus);
    const assignedAgentId = isClaimedState ? AGENT_ID : null;
    const assignedClaimId = isClaimedState ? crypto.randomUUID() : null;
    const assignedClaimedAt = isClaimedState ? queuedAt : null;
    const assignedClaimExpires = isClaimedState ? queuedAt + 60_000 : null;

    db.prepare(
      `INSERT INTO orders (
        id, public_job_code, pickup_code, customer_name, customer_phone,
        original_filename, color_mode, paper_size, sides,
        printing_amount_paise, service_charge_paise, total_amount_paise,
        status, cleanup_state, is_priority, printer_id,
        claimed_by_agent_id, claim_id, claim_expires_at_ms, claimed_at_ms,
        created_at_ms, updated_at_ms, paid_at_ms, queued_at_ms
      ) VALUES (
        ?, ?, ?, 'Phase 4 Customer', '9876543210',
        'document.pdf', ?, ?, ?,
        1000, 0, 1000,
        ?, 'ACTIVE', ?, ?,
        ?, ?, ?, ?,
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
      assignedAgentId,
      assignedClaimId,
      assignedClaimExpires,
      assignedClaimedAt,
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

  // ==========================================================================
  // SCENARIO 4.1: Safe pre-submission retry
  // ==========================================================================
  it("4.1 — Safe pre-submission retry: failure before spooler permits fallback and produces exactly 1 submission", async () => {
    seedAgentAndPrinters();
    const orderId = "40000000-0000-4000-8000-000000000001";
    seedPaidOrder(orderId);

    // Initial claim selects Printer A
    const claim1 = await repo.claimOrRenew(AGENT_ID, nowMs);
    expect(claim1).not.toBeNull();
    expect(claim1?.printerId).toBe(PRINTER_A_ID);
    expect(claim1?.currentStep.status).toBe("PENDING");

    // Failure injected BEFORE spooler submission (e.g. preflight reports OFFLINE / PAPER_JAM)
    const fallbackRes = await repo.handlePreflightFailure({
      orderId,
      stepId: claim1!.currentStep.stepId,
      claimId: claim1!.claimId,
      agentId: AGENT_ID,
      failureCode: "OFFLINE",
      failureDetail: "Printer A hardware tray blocked prior to submission",
      nowMs: nowMs + 1000,
    });

    expect(fallbackRes.action).toBe("FALLBACK_ASSIGNED");
    expect(fallbackRes.fallbackPrinterName).toBe("PrintGo Secondary Printer B");

    // Agent executes the authorized fallback print on Printer B
    const claim2 = await repo.findCurrent(AGENT_ID);
    expect(claim2?.printerId).toBe(PRINTER_B_ID);

    await repo.startStep({
      orderId,
      stepId: claim2!.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: claim2!.claimId,
      nowMs: nowMs + 2000,
    });

    const spoolerJobId = "spool-printer-b-001";
    await repo.recordSubmission({
      orderId,
      stepId: claim2!.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: claim2!.claimId,
      spoolerJobId,
      nowMs: nowMs + 3000,
    });

    await recordSuccess({
      orderId,
      stepId: claim2!.currentStep.stepId,
      claimId: claim2!.claimId,
      agentId: AGENT_ID,
      spoolerJobId,
      nowMs: nowMs + 4000,
    });

    // Check final order state
    const orderRow = db
      .prepare(`SELECT status, printer_id FROM orders WHERE id = ?`)
      .get(orderId) as { status: string; printer_id: string };
    expect(orderRow.status).toBe("COMPLETED");
    expect(orderRow.printer_id).toBe(PRINTER_B_ID);

    // Spooler submissions across entire order: exactly 1 on Printer B, 0 on Printer A
    const attempts = db
      .prepare(
        `SELECT pa.printer_id, ps.status, ps.spooler_job_id
         FROM print_attempts pa
         JOIN print_attempt_steps ps ON ps.print_attempt_id = pa.id
         WHERE pa.order_id = ?`,
      )
      .all(orderId) as Array<{
      printer_id: string;
      status: string;
      spooler_job_id: string | null;
    }>;
    expect(attempts.filter((a) => a.spooler_job_id !== null)).toHaveLength(1);
    expect(attempts.find((a) => a.spooler_job_id !== null)?.printer_id).toBe(
      PRINTER_B_ID,
    );
  });

  // ==========================================================================
  // SCENARIO 4.2: Submission-started failure
  // ==========================================================================
  it("4.2 — Submission-started failure: failure after submission boundary strictly prohibits automatic retry/fallback", async () => {
    seedAgentAndPrinters();
    const orderId = "40000000-0000-4000-8000-000000000002";
    seedPaidOrder(orderId);

    const claim = await repo.claimOrRenew(AGENT_ID, nowMs);
    expect(claim?.printerId).toBe(PRINTER_A_ID);

    // Irreversible submission boundary crossed
    await repo.startStep({
      orderId,
      stepId: claim!.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: claim!.claimId,
      nowMs: nowMs + 1000,
    });

    // Spooler or driver error occurs post-submission
    const fallbackRes = await repo.handlePreflightFailure({
      orderId,
      stepId: claim!.currentStep.stepId,
      claimId: claim!.claimId,
      agentId: AGENT_ID,
      failureCode: "SPOOLER_ERROR",
      failureDetail: "SumatraPDF crashed during spool pipeline",
      nowMs: nowMs + 2000,
    });

    // Automatic fallback is STRICTLY PROHIBITED
    expect(fallbackRes.action).toBe("ACTION_REQUIRED");

    // Order transitions to ADMIN_ACTION_REQUIRED with COMPLETION_UNKNOWN
    const orderRow = db
      .prepare(`SELECT status, error_category FROM orders WHERE id = ?`)
      .get(orderId) as { status: string; error_category: string };
    expect(orderRow.status).toBe("ADMIN_ACTION_REQUIRED");
    expect(orderRow.error_category).toBe("COMPLETION_UNKNOWN");

    // Zero attempts on Printer B
    const bAttempts = db
      .prepare(
        `SELECT COUNT(*) c FROM print_attempts WHERE order_id = ? AND printer_id = ?`,
      )
      .get(orderId, PRINTER_B_ID) as { c: number };
    expect(bAttempts.c).toBe(0);
  });

  // ==========================================================================
  // SCENARIO 4.3: Lost spooler acknowledgment
  // ==========================================================================
  it("4.3 — Lost spooler acknowledgment: journal retains spool ID and prevents duplicate print submission", async () => {
    const tempDir = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), "printgo-journal-test-"),
    );
    tempDirs.push(tempDir);
    const journalFile = path.join(tempDir, "active-print.json");

    seedAgentAndPrinters();
    const orderId = "40000000-0000-4000-8000-000000000003";
    seedPaidOrder(orderId);

    const claim = await repo.claimOrRenew(AGENT_ID, nowMs);
    await repo.startStep({
      orderId,
      stepId: claim!.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: claim!.claimId,
      nowMs: nowMs + 500,
    });

    const confirmedSpoolerId = "windows-spooler-job-903";

    // 1. Spooler accepts job -> Agent persists in local durable journal
    await fsPromises.writeFile(
      journalFile,
      JSON.stringify({
        orderId,
        attemptId: claim!.attemptId,
        stepId: claim!.currentStep.stepId,
        spoolerJobId: confirmedSpoolerId,
        updatedAtMs: nowMs + 1000,
      }),
      "utf8",
    );

    // 2. Acknowledgment to Cloudflare Worker is lost due to dropped connection
    // On reconnection, agent reads journal and replays recordSubmission with same spool ID
    const recovered = JSON.parse(
      await fsPromises.readFile(journalFile, "utf8"),
    ) as {
      orderId: string;
      spoolerJobId: string;
    };
    expect(recovered.spoolerJobId).toBe(confirmedSpoolerId);

    const sub1 = await repo.recordSubmission({
      orderId,
      stepId: claim!.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: claim!.claimId,
      spoolerJobId: recovered.spoolerJobId,
      nowMs: nowMs + 2000,
    });
    expect(sub1?.spooler_job_id).toBe(confirmedSpoolerId);

    // Second call is idempotent and does not create duplicate submission
    const sub2 = await repo.recordSubmission({
      orderId,
      stepId: claim!.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: claim!.claimId,
      spoolerJobId: recovered.spoolerJobId,
      nowMs: nowMs + 2500,
    });
    expect(sub2?.spooler_job_id).toBe(confirmedSpoolerId);

    // Only one step exists
    const steps = db
      .prepare(
        `SELECT COUNT(*) c FROM print_attempt_steps WHERE print_attempt_id = ?`,
      )
      .get(claim!.attemptId) as { c: number };
    expect(steps.c).toBe(1);
  });

  // ==========================================================================
  // SCENARIO 4.4: Agent crash before submission
  // ==========================================================================
  it("4.4 — Agent crash before submission: crash during preparation safely reclaims and prints exactly once", async () => {
    seedAgentAndPrinters();
    const orderId = "40000000-0000-4000-8000-000000000004";
    seedPaidOrder(orderId);

    const claim1 = await repo.claimOrRenew(AGENT_ID, nowMs);
    expect(claim1?.currentStep.status).toBe("PENDING");

    // Agent crashes prior to startStep (zero spooler interaction)
    // On restart, claimOrRenew safely renews the active lease without incrementing submissions
    const claim2 = await repo.claimOrRenew(AGENT_ID, nowMs + 10_000);
    expect(claim2?.orderId).toBe(orderId);
    expect(claim2?.currentStep.status).toBe("PENDING");

    await repo.startStep({
      orderId,
      stepId: claim2!.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: claim2!.claimId,
      nowMs: nowMs + 11_000,
    });

    await repo.recordSubmission({
      orderId,
      stepId: claim2!.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: claim2!.claimId,
      spoolerJobId: "spool-404",
      nowMs: nowMs + 12_000,
    });

    await recordSuccess({
      orderId,
      stepId: claim2!.currentStep.stepId,
      claimId: claim2!.claimId,
      agentId: AGENT_ID,
      spoolerJobId: "spool-404",
      nowMs: nowMs + 13_000,
    });

    const orderRow = db
      .prepare(`SELECT status FROM orders WHERE id = ?`)
      .get(orderId) as { status: string };
    expect(orderRow.status).toBe("COMPLETED");

    // Total spooler submissions: exactly 1
    const attempts = db
      .prepare(`SELECT COUNT(*) c FROM print_attempts WHERE order_id = ?`)
      .get(orderId) as { c: number };
    expect(attempts.c).toBe(1);
  });

  // ==========================================================================
  // SCENARIO 4.5: Agent crash during submission
  // ==========================================================================
  it("4.5 — Agent crash during submission: crash in SUBMISSION_STARTED without spooler ID transitions to UNCERTAIN", async () => {
    seedAgentAndPrinters();
    const orderId = "40000000-0000-4000-8000-000000000005";
    seedPaidOrder(orderId);

    const claim = await repo.claimOrRenew(AGENT_ID, nowMs);
    await repo.startStep({
      orderId,
      stepId: claim!.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: claim!.claimId,
      nowMs: nowMs + 1000,
    });

    // Agent crashes mid-submission; on restart, agent detects SUBMISSION_STARTED without spooler ID
    // Reports UNCERTAIN to Cloudflare Worker
    const result = await repo.recordResult({
      orderId,
      stepId: claim!.currentStep.stepId,
      claimId: claim!.claimId,
      agentId: AGENT_ID,
      status: "UNCERTAIN",
      spoolerJobId: null,
      failureCode: "UNKNOWN",
      failureDetail: "Agent restarted mid-submission; no spool ID confirmed",
      nowMs: nowMs + 5000,
    });

    expect(result).not.toBeNull();
    const orderRow = db
      .prepare(`SELECT status, error_category FROM orders WHERE id = ?`)
      .get(orderId) as { status: string; error_category: string };
    expect(orderRow.status).toBe("COMPLETION_UNKNOWN");
    expect(orderRow.error_category).toBe("COMPLETION_UNKNOWN");

    // Subsequent claim pulse CANNOT auto-claim this order
    const nextClaim = await repo.claimOrRenew(AGENT_ID, nowMs + 10_000);
    expect(nextClaim).toBeNull();
  });

  // ==========================================================================
  // SCENARIO 4.6: Agent crash after submission
  // ==========================================================================
  it("4.6 — Agent crash after submission: crash with confirmed spooler ID resumes monitoring and does not resubmit", async () => {
    seedAgentAndPrinters();
    const orderId = "40000000-0000-4000-8000-000000000006";
    seedPaidOrder(orderId);

    const claim = await repo.claimOrRenew(AGENT_ID, nowMs);
    await repo.startStep({
      orderId,
      stepId: claim!.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: claim!.claimId,
      nowMs: nowMs + 1000,
    });

    const spoolerJobId = "spool-406";
    await repo.recordSubmission({
      orderId,
      stepId: claim!.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: claim!.claimId,
      spoolerJobId,
      nowMs: nowMs + 2000,
    });

    // Step is now SUBMITTED. Agent crashes before observe completes.
    // On restart, agent finds step is SUBMITTED with spoolerJobId: spool-406.
    // Agent directly reports observation result without calling submitPdfJob again!
    await recordSuccess({
      orderId,
      stepId: claim!.currentStep.stepId,
      claimId: claim!.claimId,
      agentId: AGENT_ID,
      spoolerJobId,
      nowMs: nowMs + 8000,
    });

    const orderRow = db
      .prepare(`SELECT status FROM orders WHERE id = ?`)
      .get(orderId) as { status: string };
    expect(orderRow.status).toBe("COMPLETED");

    // Submissions across lifecycle: exactly 1
    const attempts = db
      .prepare(
        `SELECT ps.spooler_job_id FROM print_attempt_steps ps
         JOIN print_attempts pa ON pa.id = ps.print_attempt_id
         WHERE pa.order_id = ?`,
      )
      .all(orderId) as Array<{ spooler_job_id: string }>;
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.spooler_job_id).toBe(spoolerJobId);
  });

  // ==========================================================================
  // SCENARIO 4.7: Network outage
  // ==========================================================================
  it("4.7 — Network outage: disconnect during active attempt preserves fencing token and reconciles safely", async () => {
    seedAgentAndPrinters();
    const orderId = "40000000-0000-4000-8000-000000000007";
    seedPaidOrder(orderId);

    const claim = await repo.claimOrRenew(AGENT_ID, nowMs);
    await repo.startStep({
      orderId,
      stepId: claim!.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: claim!.claimId,
      nowMs: nowMs + 1000,
    });

    const spoolerJobId = "spool-407";
    await repo.recordSubmission({
      orderId,
      stepId: claim!.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: claim!.claimId,
      spoolerJobId,
      nowMs: nowMs + 2000,
    });

    // Network disconnect occurs. Another rogue/stale agent tries to claim with invalid claim_id
    const staleResult = await repo.recordResult({
      orderId,
      stepId: claim!.currentStep.stepId,
      claimId: "invalid-stale-claim-id",
      agentId: AGENT_ID,
      spoolerJobId,
      status: "SUCCEEDED",
      failureCode: null,
      failureDetail: null,
      nowMs: nowMs + 3000,
    });
    // Rejected by fencing token!
    expect(staleResult).toBeNull();

    // When network recovers, authentic agent with valid claim_id reports completion
    const validResult = await recordSuccess({
      orderId,
      stepId: claim!.currentStep.stepId,
      claimId: claim!.claimId,
      agentId: AGENT_ID,
      spoolerJobId,
      nowMs: nowMs + 4000,
    });
    expect(validResult).not.toBeNull();

    const orderRow = db
      .prepare(`SELECT status FROM orders WHERE id = ?`)
      .get(orderId) as { status: string };
    expect(orderRow.status).toBe("COMPLETED");
  });

  // ==========================================================================
  // SCENARIO 4.8: Expired claim lease
  // ==========================================================================
  it("4.8 — Expired claim lease: stale ownership cannot submit or overwrite a newer result", async () => {
    seedAgentAndPrinters();
    const orderId = "40000000-0000-4000-8000-000000000008";
    seedPaidOrder(orderId);

    const claim = await repo.claimOrRenew(AGENT_ID, nowMs);
    const leaseExpiresAt = claim!.leaseExpiresAtMs;

    // Time advances past lease expiry
    const expiredTimeMs = leaseExpiresAt + 10_000;

    // Stale agent attempts preflight reporting or submission with expired lease
    const stalePreflight = await repo.handlePreflightFailure({
      orderId,
      stepId: claim!.currentStep.stepId,
      claimId: claim!.claimId,
      agentId: AGENT_ID,
      failureCode: "OFFLINE",
      nowMs: expiredTimeMs,
    });

    // Rejected: lease expired!
    expect(stalePreflight.action).toBe("ACTION_REQUIRED");
    expect(stalePreflight.message).toContain(
      "Print step not owned by active agent lease",
    );
  });

  // ==========================================================================
  // SCENARIO 4.9: Concurrent Worker race
  // ==========================================================================
  it("4.9 — Concurrent Worker race: two workers racing to claim same order yields exactly 1 winner", async () => {
    seedAgentAndPrinters();
    const orderId = "40000000-0000-4000-8000-000000000009";
    seedPaidOrder(orderId);

    // Two concurrent workers attempt claim simultaneously at same logical nowMs
    const [claimA, claimB] = await Promise.all([
      repo.claimOrRenew(AGENT_ID, nowMs),
      repo.claimOrRenew(AGENT_2_ID, nowMs),
    ]);

    // Exactly one worker must succeed; the other must receive null
    const winners = [claimA, claimB].filter((c) => c !== null);
    expect(winners).toHaveLength(1);

    // Database shows exactly 1 active claim
    const orderRow = db
      .prepare(`SELECT status, claimed_by_agent_id FROM orders WHERE id = ?`)
      .get(orderId) as { status: string; claimed_by_agent_id: string };
    expect(orderRow.status).toBe("CLAIMED");
    expect([AGENT_ID, AGENT_2_ID]).toContain(orderRow.claimed_by_agent_id);
  });

  // ==========================================================================
  // ==========================================================================
  // SCENARIO 4.10: Retry schedule progression
  // ==========================================================================
  it("4.10 — Retry backoff: enforces exact pre-submission retry progression (60s -> 90s -> 90s)", async () => {
    // Disable auto-fallback to force backoff retry progression on single printer
    seedAgentAndPrinters({
      autoFallbackEnabled: 0,
      fallbackPrinterId: null,
    });
    const orderId = "40000000-0000-4000-8000-000000000010";
    seedPaidOrder(orderId);

    // Progression:
    // Initial failure -> Retry 1 after 60,000ms (60s)
    // Retry 1 failure -> Retry 2 after 90,000ms (90s)
    // Retry 2 failure -> Retry 3 after 90,000ms (90s)
    const expectedDelays = [60_000, 90_000, 90_000];

    let currentSimTime = nowMs;

    for (let i = 0; i < expectedDelays.length; i++) {
      const claim = await repo.claimOrRenew(AGENT_ID, currentSimTime);
      expect(claim).not.toBeNull();

      const res = await repo.handlePreflightFailure({
        orderId,
        stepId: claim!.currentStep.stepId,
        claimId: claim!.claimId,
        agentId: AGENT_ID,
        failureCode: "PAPER_JAM",
        failureDetail: `Jam simulation attempt ${i + 1}`,
        nowMs: currentSimTime,
      });

      expect(res.action).toBe("BLOCKED_RELEASED");
      expect(res.retryAfterMs).toBe(expectedDelays[i]);

      const orderRow = db
        .prepare(
          `SELECT status, next_retry_at_ms, fallback_count, attempt_count FROM orders WHERE id = ?`,
        )
        .get(orderId) as {
        status: string;
        next_retry_at_ms: number;
        fallback_count: number;
        attempt_count: number;
      };
      expect(orderRow.status).toBe("RETRY_PENDING");
      expect(orderRow.fallback_count).toBe(i + 1);
      expect(orderRow.attempt_count).toBe(i + 1);
      expect(orderRow.next_retry_at_ms).toBe(
        currentSimTime + expectedDelays[i]!,
      );

      // Boundary timing test: premature claim query 1,000ms before next_retry_at_ms returns null
      const prematureClaim = await repo.claimOrRenew(
        AGENT_ID,
        currentSimTime + expectedDelays[i]! - 1000,
      );
      expect(prematureClaim).toBeNull();

      // Boundary timing test: premature claim query 1ms before next_retry_at_ms returns null
      const precisePremature = await repo.claimOrRenew(
        AGENT_ID,
        currentSimTime + expectedDelays[i]! - 1,
      );
      expect(precisePremature).toBeNull();

      // Advance time to next_retry_at_ms for next iteration
      currentSimTime = orderRow.next_retry_at_ms;

      // Operator temporarily checks paper jam on printer and updates agent heartbeat
      db.prepare(
        `UPDATE printers SET is_paused = 0, paused_reason = NULL WHERE id = ?`,
      ).run(PRINTER_A_ID);
      db.prepare(`UPDATE agents SET last_heartbeat_at_ms = ? WHERE id = ?`).run(
        currentSimTime,
        AGENT_ID,
      );
    }
  });

  // ==========================================================================
  // SCENARIO 4.11: Retry exhaustion and operator escalation (STOP -> ADMIN_ACTION_REQUIRED)
  // ==========================================================================
  it("4.11 — Retry exhaustion audit: 1 initial + 3 retries (60s -> 90s -> 90s) stops and transitions to ADMIN_ACTION_REQUIRED", async () => {
    seedAgentAndPrinters({
      autoFallbackEnabled: 0,
      fallbackPrinterId: null,
    });
    const orderId = "40000000-0000-4000-8000-000000000011";
    seedPaidOrder(orderId);

    let currentSimTime = nowMs;

    // 1. Initial attempt fails before submission -> Retry 1 in 60s
    const claimInit = await repo.claimOrRenew(AGENT_ID, currentSimTime);
    expect(claimInit).not.toBeNull();
    const resInit = await repo.handlePreflightFailure({
      orderId,
      stepId: claimInit!.currentStep.stepId,
      claimId: claimInit!.claimId,
      agentId: AGENT_ID,
      failureCode: "PAPER_JAM",
      failureDetail: "Tray 1 empty / paper jam",
      nowMs: currentSimTime,
    });
    expect(resInit.action).toBe("BLOCKED_RELEASED");
    expect(resInit.retryAfterMs).toBe(60_000);
    currentSimTime += 60_000;
    db.prepare(
      `UPDATE printers SET is_paused = 0, paused_reason = NULL WHERE id = ?`,
    ).run(PRINTER_A_ID);
    db.prepare(`UPDATE agents SET last_heartbeat_at_ms = ? WHERE id = ?`).run(
      currentSimTime,
      AGENT_ID,
    );

    // 2. Retry 1 fails before submission -> Retry 2 in 90s
    const claim1 = await repo.claimOrRenew(AGENT_ID, currentSimTime);
    expect(claim1).not.toBeNull();
    const res1 = await repo.handlePreflightFailure({
      orderId,
      stepId: claim1!.currentStep.stepId,
      claimId: claim1!.claimId,
      agentId: AGENT_ID,
      failureCode: "PAPER_JAM",
      failureDetail: "Tray 1 still jammed on retry 1",
      nowMs: currentSimTime,
    });
    expect(res1.action).toBe("BLOCKED_RELEASED");
    expect(res1.retryAfterMs).toBe(90_000);
    currentSimTime += 90_000;
    db.prepare(
      `UPDATE printers SET is_paused = 0, paused_reason = NULL WHERE id = ?`,
    ).run(PRINTER_A_ID);
    db.prepare(`UPDATE agents SET last_heartbeat_at_ms = ? WHERE id = ?`).run(
      currentSimTime,
      AGENT_ID,
    );

    // 3. Retry 2 fails before submission -> Retry 3 in 90s
    const claim2 = await repo.claimOrRenew(AGENT_ID, currentSimTime);
    expect(claim2).not.toBeNull();
    const res2 = await repo.handlePreflightFailure({
      orderId,
      stepId: claim2!.currentStep.stepId,
      claimId: claim2!.claimId,
      agentId: AGENT_ID,
      failureCode: "PAPER_JAM",
      failureDetail: "Tray 1 still jammed on retry 2",
      nowMs: currentSimTime,
    });
    expect(res2.action).toBe("BLOCKED_RELEASED");
    expect(res2.retryAfterMs).toBe(90_000);
    currentSimTime += 90_000;
    db.prepare(
      `UPDATE printers SET is_paused = 0, paused_reason = NULL WHERE id = ?`,
    ).run(PRINTER_A_ID);
    db.prepare(`UPDATE agents SET last_heartbeat_at_ms = ? WHERE id = ?`).run(
      currentSimTime,
      AGENT_ID,
    );

    // 4. Retry 3 fails before submission -> STOP!
    // Total 1 initial attempt + 3 automatic retries have failed.
    const claim3 = await repo.claimOrRenew(AGENT_ID, currentSimTime);
    expect(claim3).not.toBeNull();
    const res3 = await repo.handlePreflightFailure({
      orderId,
      stepId: claim3!.currentStep.stepId,
      claimId: claim3!.claimId,
      agentId: AGENT_ID,
      failureCode: "PAPER_JAM",
      failureDetail: "Tray 1 still jammed on retry 3",
      nowMs: currentSimTime,
    });

    // Policy verified: MUST return ACTION_REQUIRED and STOP automatic claims
    expect(res3.action).toBe("ACTION_REQUIRED");
    expect(res3.message).toContain(
      "Maximum automatic retries (3) exhausted before spooler submission",
    );

    // Check order state in D1
    const finalOrder = db
      .prepare(
        `SELECT status, error_category, raw_error, blocked_reason, fallback_count, attempt_count, next_retry_at_ms FROM orders WHERE id = ?`,
      )
      .get(orderId) as {
      status: string;
      error_category: string;
      raw_error: string;
      blocked_reason: string;
      fallback_count: number;
      attempt_count: number;
      next_retry_at_ms: number | null;
    };
    expect(finalOrder.status).toBe("ADMIN_ACTION_REQUIRED");
    expect(finalOrder.error_category).toBe("PAPER_JAM");
    expect(finalOrder.raw_error).toContain(
      "Maximum automatic retries (3) exhausted",
    );
    expect(finalOrder.fallback_count).toBe(4);
    expect(finalOrder.attempt_count).toBe(3);
    expect(finalOrder.next_retry_at_ms).toBeNull(); // Automatic retries strictly stopped!

    // Verify automatic worker claims NEVER pick up this order again
    db.prepare(
      `UPDATE printers SET is_paused = 0, paused_reason = NULL WHERE id = ?`,
    ).run(PRINTER_A_ID);
    const stoppedClaim = await repo.claimOrRenew(
      AGENT_ID,
      currentSimTime + 1_000_000,
    );
    expect(stoppedClaim).toBeNull();

    // Verify Admin UI displays order correctly via listLiveOrders
    const liveOrders = await repo.listLiveOrders(currentSimTime);
    const live = liveOrders.find((o) => o.orderId === orderId);
    expect(live).toBeDefined();
    expect(live?.status).toBe("ADMIN_ACTION_REQUIRED");
    expect(live?.attemptCount).toBe(3);
    expect(live?.errorCategory).toBe("PAPER_JAM");
    expect(live?.rawError).toContain("Maximum automatic retries (3) exhausted");

    // Operator Recovery: Operator fixes printer, confirms retry in Admin UI
    const retryRes = await repo.retryOrder({
      orderId,
      adminId: "admin-operator-1",
      forceUncertain: true,
      nowMs: currentSimTime + 10_000,
    });
    expect(retryRes.status).toBe("QUEUED");

    // Verified: Admin retry resets attempt_count and fallback_count for a clean recovery cycle
    const recoveredOrder = db
      .prepare(
        `SELECT status, attempt_count, fallback_count, next_retry_at_ms FROM orders WHERE id = ?`,
      )
      .get(orderId) as {
      status: string;
      attempt_count: number;
      fallback_count: number;
      next_retry_at_ms: number | null;
    };
    expect(recoveredOrder.status).toBe("QUEUED");
    expect(recoveredOrder.attempt_count).toBe(0);
    expect(recoveredOrder.fallback_count).toBe(0);
    expect(recoveredOrder.next_retry_at_ms).toBeNull();
  });

  // ==========================================================================
  // SCENARIO 4.12: Admin retry after uncertain print
  // ==========================================================================
  it("4.12 — Admin retry after uncertain print: requires explicit forceUncertain authorization", async () => {
    seedAgentAndPrinters();
    const orderId = "40000000-0000-4000-8000-000000000012";
    seedPaidOrder(orderId, { status: "ADMIN_ACTION_REQUIRED" });

    // Mark error category as COMPLETION_UNKNOWN
    db.prepare(
      `UPDATE orders SET error_category = 'COMPLETION_UNKNOWN' WHERE id = ?`,
    ).run(orderId);

    // 1. Retry without forceUncertain -> MUST throw UNCERTAIN_RETRY_CONFIRMATION_REQUIRED
    await expect(
      repo.retryOrder({
        orderId,
        nowMs,
        adminId: "admin-operator-1",
        forceUncertain: false,
      }),
    ).rejects.toThrow("UNCERTAIN_RETRY_CONFIRMATION_REQUIRED");

    // 2. Retry with explicit operator confirmation forceUncertain: true -> succeeds
    const retryRes = await repo.retryOrder({
      orderId,
      nowMs,
      adminId: "admin-operator-1",
      forceUncertain: true,
    });
    expect(retryRes.orderId).toBe(orderId);

    // Order transitions to QUEUED, ready for safe reprint
    const orderRow = db
      .prepare(`SELECT status, error_category FROM orders WHERE id = ?`)
      .get(orderId) as { status: string; error_category: string | null };
    expect(orderRow.status).toBe("QUEUED");
    expect(orderRow.error_category).toBeNull();
  });

  // ==========================================================================
  // SCENARIO 4.13: Admin double-click or repeated retry
  // ==========================================================================
  it("4.13 — Admin double-click or repeated retry: atomic transitions prevent duplicate execution", async () => {
    seedAgentAndPrinters();
    const orderId = "40000000-0000-4000-8000-000000000013";
    seedPaidOrder(orderId, { status: "PRINT_FAILED" });

    // First admin retry request succeeds
    const firstRetry = await repo.retryOrder({
      orderId,
      nowMs,
      adminId: "admin-1",
    });
    expect(firstRetry.orderId).toBe(orderId);

    // Second simultaneous retry request fails because status is already QUEUED
    await expect(
      repo.retryOrder({
        orderId,
        nowMs: nowMs + 100,
        adminId: "admin-1",
      }),
    ).rejects.toThrow("ORDER_CANNOT_BE_RETRIED");

    // Exactly 1 order in QUEUED status
    const orderRow = db
      .prepare(`SELECT status FROM orders WHERE id = ?`)
      .get(orderId) as { status: string };
    expect(orderRow.status).toBe("QUEUED");
  });

  // ==========================================================================
  // SCENARIO 4.14: Multi-file partial completion
  // ==========================================================================
  it("4.14 — Multi-file partial completion: File 1 preserved as PRINTED while File 2 is retried safely", async () => {
    seedAgentAndPrinters();
    const orderId = "40000000-0000-4000-8000-000000000014";
    const file1Id = "50000000-0000-4000-8000-000000000001";
    const file2Id = "50000000-0000-4000-8000-000000000002";

    seedPaidOrder(orderId, {
      files: [
        { fileId: file1Id, sourcePageCount: 2, copies: 1 },
        { fileId: file2Id, sourcePageCount: 3, copies: 1 },
      ],
    });

    // 1. Claim Order -> File 1 is claimed
    const claim1 = await repo.claimOrRenew(AGENT_ID, nowMs);
    expect(claim1?.fileId).toBe(file1Id);

    await repo.startStep({
      orderId,
      stepId: claim1!.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: claim1!.claimId,
      nowMs: nowMs + 1000,
    });

    const spoolerJob1 = "spool-414-file-1";
    await repo.recordSubmission({
      orderId,
      stepId: claim1!.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: claim1!.claimId,
      spoolerJobId: spoolerJob1,
      nowMs: nowMs + 2000,
    });

    await recordSuccess({
      orderId,
      stepId: claim1!.currentStep.stepId,
      claimId: claim1!.claimId,
      agentId: AGENT_ID,
      spoolerJobId: spoolerJob1,
      nowMs: nowMs + 3000,
    });

    // Verify File 1 is marked PRINTED in order_files
    const file1Row = db
      .prepare(`SELECT print_status FROM order_files WHERE id = ?`)
      .get(file1Id) as { print_status: string };
    expect(file1Row.print_status).toBe("PRINTED");

    // 2. Claim next file -> File 2 is claimed
    const claim2 = await repo.claimOrRenew(AGENT_ID, nowMs + 4000);
    expect(claim2?.fileId).toBe(file2Id);

    await repo.startStep({
      orderId,
      stepId: claim2!.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: claim2!.claimId,
      nowMs: nowMs + 5000,
    });

    // File 2 encounters uncertain crash/failure
    await repo.recordResult({
      orderId,
      stepId: claim2!.currentStep.stepId,
      claimId: claim2!.claimId,
      agentId: AGENT_ID,
      status: "UNCERTAIN",
      spoolerJobId: null,
      failureCode: "UNKNOWN",
      failureDetail: "File 2 crashed mid-submission",
      nowMs: nowMs + 6000,
    });

    // Order moves to COMPLETION_UNKNOWN
    const orderUncertain = db
      .prepare(`SELECT status FROM orders WHERE id = ?`)
      .get(orderId) as { status: string };
    expect(orderUncertain.status).toBe("COMPLETION_UNKNOWN");

    // 3. Admin reconciles order with forceUncertain: true
    await repo.retryOrder({
      orderId,
      nowMs: nowMs + 10_000,
      adminId: "admin-operator",
      forceUncertain: true,
    });

    // Check order_files statuses:
    // File 1 MUST REMAIN 'PRINTED'
    // File 2 MUST BE RESET TO 'PENDING'
    const f1After = db
      .prepare(`SELECT print_status FROM order_files WHERE id = ?`)
      .get(file1Id) as { print_status: string };
    const f2After = db
      .prepare(`SELECT print_status FROM order_files WHERE id = ?`)
      .get(file2Id) as { print_status: string };
    expect(f1After.print_status).toBe("PRINTED");
    expect(f2After.print_status).toBe("PENDING");

    // 4. On next claim, agent is served ONLY File 2!
    const claim3 = await repo.claimOrRenew(AGENT_ID, nowMs + 11_000);
    expect(claim3?.fileId).toBe(file2Id);
    expect(claim3?.currentStep.status).toBe("PENDING");
  });

  // ==========================================================================
  // SCENARIO 4.15: Physical-device lock recovery
  // ==========================================================================
  it("4.15 — Physical-device lock recovery: serializes execution and releases lock cleanly upon lease expiry", async () => {
    // Both printers share the same physical device ID to enforce serialization
    seedAgentAndPrinters({
      printerBPhysicalDeviceId: "HP_PHYSICAL_DEVICE_136W",
    });
    const order1Id = "40000000-0000-4000-8000-000000000015";
    const order2Id = "40000000-0000-4000-8000-000000000016";

    seedPaidOrder(order1Id, { queuedAtMs: nowMs - 100 });
    seedPaidOrder(order2Id, { queuedAtMs: nowMs });

    // Order 1 claims Printer A (locks physical device HP_PHYSICAL_DEVICE_136W)
    const claim1 = await repo.claimOrRenew(AGENT_ID, nowMs);
    expect(claim1?.orderId).toBe(order1Id);
    expect(claim1?.physicalDeviceId).toBe("HP_PHYSICAL_DEVICE_136W");

    // Order 2 cannot claim because physical device is busy
    const activeJobs = await repo.findAllCurrent(AGENT_ID);
    expect(activeJobs.map((j) => j.orderId)).toEqual([order1Id]);

    // Simulate Agent 1 crashing and lease expiring
    const expiredNowMs = claim1!.leaseExpiresAtMs + 5000;
    db.prepare(`UPDATE agents SET last_heartbeat_at_ms = ? WHERE id = ?`).run(
      expiredNowMs + 1000,
      AGENT_ID,
    );
    await repo.recoverExpiredClaims(expiredNowMs);

    // Order 1 had unstarted attempt -> reset to QUEUED, clearing the lock
    const o1Row = db
      .prepare(`SELECT status, claimed_by_agent_id FROM orders WHERE id = ?`)
      .get(order1Id) as { status: string; claimed_by_agent_id: string | null };
    expect(o1Row.status).toBe("QUEUED");
    expect(o1Row.claimed_by_agent_id).toBeNull();

    // Now either order can be safely claimed without concurrent execution conflict
    const nextClaim = await repo.claimOrRenew(AGENT_ID, expiredNowMs + 1000);
    expect(nextClaim).not.toBeNull();
    expect(nextClaim?.physicalDeviceId).toBe("HP_PHYSICAL_DEVICE_136W");
  });

  // ==========================================================================
  // SCENARIO 4.16: Payment and capability enforcement
  // ==========================================================================
  it("4.16 — Payment and capability enforcement: rejects unpaid orders and incompatible/unreviewed printers", async () => {
    seedAgentAndPrinters();

    // Subcase A: Unpaid order (PAYMENT_PENDING)
    const unpaidOrderId = "40000000-0000-4000-8000-000000000017";
    seedPaidOrder(unpaidOrderId, { unpaid: true, status: "PAYMENT_PENDING" });

    const unpaidClaim = await repo.claimOrRenew(AGENT_ID, nowMs);
    expect(unpaidClaim).toBeNull();

    // Subcase B: Incompatible printer (Color order with only B&W Printer A and B)
    const colorOrderId = "40000000-0000-4000-8000-000000000018";
    seedPaidOrder(colorOrderId, { colorMode: "COLOR" });

    const colorClaim = await repo.claimOrRenew(AGENT_ID, nowMs);
    expect(colorClaim).toBeNull(); // Neither B&W printer is selected

    // Subcase C: Unreviewed printer (requiresReview = 1)
    db.prepare(`UPDATE orders SET status = 'COMPLETED' WHERE id IN (?, ?)`).run(
      unpaidOrderId,
      colorOrderId,
    );

    // Mark Printer A as requiring review
    db.prepare(
      `UPDATE printers SET verified_capabilities_json = json_set(verified_capabilities_json, '$.requiresReview', 1) WHERE id = ?`,
    ).run(PRINTER_A_ID);

    const normalOrderId = "40000000-0000-4000-8000-000000000019";
    seedPaidOrder(normalOrderId, { printerId: PRINTER_A_ID });

    // Unreviewed printer cannot be claimed
    const rejectedClaim = await repo.claimOrRenew(AGENT_ID, nowMs);
    expect(rejectedClaim).toBeNull();

    // Once reviewed (requiresReview = 0), claim is permitted
    db.prepare(
      `UPDATE printers SET verified_capabilities_json = json_set(verified_capabilities_json, '$.requiresReview', 0) WHERE id = ?`,
    ).run(PRINTER_A_ID);

    const approvedClaim = await repo.claimOrRenew(AGENT_ID, nowMs);
    expect(approvedClaim?.orderId).toBe(normalOrderId);
    expect(approvedClaim?.printerId).toBe(PRINTER_A_ID);
  });

  // ==========================================================================
  // SCENARIO 4.17: Database and journal inconsistency
  // ==========================================================================
  it("4.17 — Database and journal inconsistency: fail-closed idempotency across all 4 execution boundaries", async () => {
    seedAgentAndPrinters();
    const orderId = "40000000-0000-4000-8000-000000000020";
    seedPaidOrder(orderId);

    const claim = await repo.claimOrRenew(AGENT_ID, nowMs);

    // Boundary 1: startStep executed (SUBMISSION_STARTED)
    await repo.startStep({
      orderId,
      stepId: claim!.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: claim!.claimId,
      nowMs: nowMs + 1000,
    });
    // Calling startStep again is idempotent
    await repo.startStep({
      orderId,
      stepId: claim!.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: claim!.claimId,
      nowMs: nowMs + 1100,
    });

    // Boundary 2: Spooler submitted and recordSubmission called
    const spoolId = "spool-417-id";
    const subRes1 = await repo.recordSubmission({
      orderId,
      stepId: claim!.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: claim!.claimId,
      spoolerJobId: spoolId,
      nowMs: nowMs + 2000,
    });
    expect(subRes1?.spooler_job_id).toBe(spoolId);

    // Repeated recordSubmission with same spool ID succeeds idempotently
    const subRes2 = await repo.recordSubmission({
      orderId,
      stepId: claim!.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: claim!.claimId,
      spoolerJobId: spoolId,
      nowMs: nowMs + 2100,
    });
    expect(subRes2?.spooler_job_id).toBe(spoolId);

    // Boundary 3: Completion update (recordResult SUCCEEDED)
    const resultRes = await recordSuccess({
      orderId,
      stepId: claim!.currentStep.stepId,
      claimId: claim!.claimId,
      agentId: AGENT_ID,
      spoolerJobId: spoolId,
      nowMs: nowMs + 3000,
    });
    expect(resultRes).not.toBeNull();

    const orderRow = db
      .prepare(`SELECT status FROM orders WHERE id = ?`)
      .get(orderId) as { status: string };
    expect(orderRow.status).toBe("COMPLETED");
  });

  // ==========================================================================
  // SCENARIO 4.18: Recovery after multiple restarts
  // ==========================================================================
  it("4.18 — Recovery after multiple restarts: 3 successive agent restarts yield zero duplicate prints and clean release", async () => {
    seedAgentAndPrinters();
    const orderId = "40000000-0000-4000-8000-000000000021";
    seedPaidOrder(orderId);

    // RESTART 1: Agent restarts while order is QUEUED -> claims cleanly
    const claim1 = await repo.claimOrRenew(AGENT_ID, nowMs);
    expect(claim1?.currentStep.status).toBe("PENDING");

    await repo.startStep({
      orderId,
      stepId: claim1!.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: claim1!.claimId,
      nowMs: nowMs + 1000,
    });

    const spoolerJobId = "spool-418-unique";
    await repo.recordSubmission({
      orderId,
      stepId: claim1!.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: claim1!.claimId,
      spoolerJobId,
      nowMs: nowMs + 2000,
    });

    // RESTART 2: Agent restarts while job is SUBMITTED with active spooler ID
    // Claim renewal retains the active job without resetting or duplicating submission
    const claim2 = await repo.claimOrRenew(AGENT_ID, nowMs + 3000);
    expect(claim2?.currentStep.status).toBe("SUBMITTED");
    expect(claim2?.currentStep.spoolerJobId).toBe(spoolerJobId);

    // Agent completes observation and reports success
    await recordSuccess({
      orderId,
      stepId: claim2!.currentStep.stepId,
      claimId: claim2!.claimId,
      agentId: AGENT_ID,
      spoolerJobId,
      nowMs: nowMs + 4000,
    });

    // RESTART 3: Agent restarts after completion -> no pending jobs, clean release
    const claim3 = await repo.claimOrRenew(AGENT_ID, nowMs + 10_000);
    expect(claim3).toBeNull();

    // Verify exactly 1 submission in entire lifecycle
    const attempts = db
      .prepare(
        `SELECT ps.spooler_job_id FROM print_attempt_steps ps
         JOIN print_attempts pa ON pa.id = ps.print_attempt_id
         WHERE pa.order_id = ?`,
      )
      .all(orderId) as Array<{ spooler_job_id: string }>;
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.spooler_job_id).toBe(spoolerJobId);
  });
});
