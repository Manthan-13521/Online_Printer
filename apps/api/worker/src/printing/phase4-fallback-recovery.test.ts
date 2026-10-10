import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";

import { D1PrintingRepository } from "./repository.js";

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

interface PrinterRow {
  is_paused?: number;
  paused_reason?: string | null;
}

interface AttemptRow {
  id: string;
  printer_id: string;
  status: string;
  fallback_from_printer_id?: string | null;
  fallback_reason?: string | null;
}

interface OrderRow {
  status?: string;
  printer_id?: string | null;
  claimed_by_agent_id?: string | null;
  claim_id?: string | null;
  error_category?: string | null;
  next_retry_at_ms?: number | null;
  fallback_count?: number;
}

interface FileRow {
  id?: string;
  print_status?: string;
}

interface StepRow {
  status?: string;
}

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
    this.values = values.map((v) => {
      if (v === undefined || v === null) return null;
      if (typeof v === "boolean") return v ? 1 : 0;
      return v;
    }) as SQLInputValue[];
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
    const row = this.db.prepare(this.sql).get(...this.values) as T | undefined;
    return Promise.resolve(row ?? null);
  }
  all<T>(): Promise<D1Result<T>> {
    const rows = this.db.prepare(this.sql).all(...this.values) as T[];
    return Promise.resolve({
      success: true,
      meta: { changes: 0 },
      results: rows,
    } as unknown as D1Result<T>);
  }
}

function asD1(db: DatabaseSync): D1Database {
  return {
    prepare: (sql: string) => new Statement(db, sql),
    async batch(statements: Statement[]) {
      db.exec("BEGIN");
      try {
        const results = [];
        for (const s of statements) {
          if (s["sql"].trim().toUpperCase().startsWith("SELECT")) {
            results.push(await s.all());
          } else {
            results.push(await s.run());
          }
        }
        db.exec("COMMIT");
        return results;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  } as unknown as D1Database;
}

const AGENT_ID = "00000000-0000-0000-0000-000000000001";
const PRINTER_A_ID = "00000000-0000-0000-0000-000000000002";
const PRINTER_B_ID = "00000000-0000-0000-0000-000000000003";

describe("Phase 4: Automatic Safe Fallback & Printer Failure Recovery", () => {
  let sqlite: DatabaseSync;
  let d1: D1Database;
  let repo: D1PrintingRepository;

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    for (const sql of migrations) {
      sqlite.exec(sql);
    }
    d1 = asD1(sqlite);
    repo = new D1PrintingRepository(d1);
  });

  function seedAgentAndPrinters(opts?: {
    printerAPaused?: boolean;
    printerAOffline?: boolean;
    printerBColor?: boolean;
    autoFallbackEnabled?: boolean;
    fallbackPrinterId?: string;
  }) {
    const now = 1_000_000;
    // Agent
    sqlite.exec(`
      INSERT INTO agents (id, display_name, credential_hash, is_active, paired_at_ms, last_heartbeat_at_ms, created_at_ms, updated_at_ms)
      VALUES ('${AGENT_ID}', 'Main Windows Agent', 'fake_hash', 1, ${now}, ${now}, ${now}, ${now});
    `);

    // Printer A: Primary / Default B&W Printer
    const pAStatus = opts?.printerAOffline ? "OFFLINE" : "ONLINE";
    const pAPaused = opts?.printerAPaused ? 1 : 0;
    sqlite.exec(`
      INSERT INTO printers (
        id, agent_id, windows_printer_name, display_name, enabled, status,
        is_paused, paused_reason, is_production_eligible, is_virtual, priority,
        capabilities_json, verified_capabilities_json, enabled_services_json,
        fallback_printer_id, auto_fallback_enabled, created_at_ms, updated_at_ms
      ) VALUES (
        '${PRINTER_A_ID}', '${AGENT_ID}', 'Brother HL-L2321D', 'Primary Counter B&W', 1, '${pAStatus}',
        ${pAPaused}, ${pAPaused ? "'PAPER_JAM'" : "NULL"}, 1, 0, 100,
        '{"colour":false,"duplex":true,"paperSizes":["A4"]}',
        '{"verified":{"bw":1,"color":0,"duplex":1,"a4":1,"a3":0},"requiresReview":0}',
        '{"bw":1,"color":0,"duplex":1,"a4":1,"a3":0}',
        ${opts?.fallbackPrinterId ? `'${opts.fallbackPrinterId}'` : `'${PRINTER_B_ID}'`},
        ${(opts?.autoFallbackEnabled ?? true) ? 1 : 0}, ${now}, ${now}
      );
    `);

    // Printer B: Secondary / Backup Printer
    const isBColor = opts?.printerBColor ?? false;
    sqlite.exec(`
      INSERT INTO printers (
        id, agent_id, windows_printer_name, display_name, enabled, status,
        is_paused, paused_reason, is_production_eligible, is_virtual, priority,
        capabilities_json, verified_capabilities_json, enabled_services_json,
        fallback_printer_id, auto_fallback_enabled, created_at_ms, updated_at_ms
      ) VALUES (
        '${PRINTER_B_ID}', '${AGENT_ID}', 'HP LaserJet Pro M404', 'Backup Counter B&W', 1, 'ONLINE',
        0, NULL, 1, 0, 50,
        '{"colour":${isBColor},"duplex":true,"paperSizes":["A4"]}',
        '{"verified":{"bw":1,"color":${isBColor ? 1 : 0},"duplex":1,"a4":1,"a3":0},"requiresReview":0}',
        '{"bw":1,"color":${isBColor ? 1 : 0},"duplex":1,"a4":1,"a3":0}',
        NULL, 0, ${now}, ${now}
      );
    `);

    // Installation default
    sqlite.exec(`
      INSERT OR REPLACE INTO installation (
        id, shop_name, identification_sheet_enabled, identification_sheet_placement,
        default_production_printer_id, created_at_ms, updated_at_ms
      ) VALUES (
        1, 'PrintGo Shop', 0, 'LAST', '${PRINTER_A_ID}', ${now}, ${now}
      );
    `);
  }

  function seedPaidOrder(
    orderId: string,
    opts?: { colorMode?: "BW" | "COLOR"; queuedAt?: number },
  ) {
    const now = 1_000_000;
    const colorMode = opts?.colorMode ?? "BW";
    const queuedAt = opts?.queuedAt ?? now;
    const fileId = crypto.randomUUID();
    const upId = crypto.randomUUID();
    const payId = crypto.randomUUID();

    sqlite.exec(`
      INSERT INTO orders (
        id, public_job_code, pickup_code, customer_name, customer_phone,
        original_filename, color_mode, paper_size, sides,
        printing_amount_paise, service_charge_paise, total_amount_paise,
        status, cleanup_state, created_at_ms, updated_at_ms, paid_at_ms, queued_at_ms
      ) VALUES (
        '${orderId}', 'JOB-${orderId.slice(0, 4)}', 'PU-${orderId.slice(0, 4)}', 'Customer', '9876543210',
        'document.pdf', '${colorMode}', 'A4', 'SINGLE',
        1000, 0, 1000,
        'QUEUED', 'ACTIVE', ${now}, ${now}, ${now}, ${queuedAt}
      );

      INSERT INTO order_files (
        id, order_id, position, original_filename, r2_object_key,
        expected_size_bytes, size_bytes, uploaded_at_ms, source_page_count, selected_pages, copies,
        color_mode, paper_size, sides, upload_status, created_at_ms, updated_at_ms
      ) VALUES (
        '${fileId}', '${orderId}', 1, 'document.pdf', 'uploads/${orderId}/document.pdf',
        1024, 1024, ${now}, 2, 'ALL', 1,
        '${colorMode}', 'A4', 'SINGLE', 'UPLOADED', ${now}, ${now}
      );

      INSERT INTO uploads (
        id, order_id, r2_object_key, original_filename, mime_type,
        size_bytes, storage_status, created_at_ms, uploaded_at_ms, updated_at_ms, expected_size_bytes
      ) VALUES (
        '${upId}', '${orderId}', 'uploads/${orderId}/document.pdf', 'document.pdf', 'application/pdf',
        1024, 'UPLOADED', ${now}, ${now}, ${now}, 1024
      );

      INSERT INTO payments (
        id, order_id, amount_paise, currency, status,
        provider, provider_order_id, provider_payment_id,
        created_at_ms, updated_at_ms, verified_at_ms
      ) VALUES (
        '${payId}', '${orderId}', 1000, 'INR', 'PAID',
        'RAZORPAY', 'order_rzp_${orderId.slice(0, 8)}', 'pay_rzp_${orderId.slice(0, 8)}',
        ${now}, ${now}, ${now}
      );
    `);
  }

  it("1. Pre-Submission Fallback: claims printer_a, preflight detects PAPER_JAM, safely falls back to printer_b", async () => {
    seedAgentAndPrinters();
    const orderId = "11111111-1111-1111-1111-111111111111";
    seedPaidOrder(orderId);

    const now = 1_000_100;
    // Step 1: Agent claims order
    const claimed = await repo.claimOrRenew(AGENT_ID, now);
    expect(claimed).not.toBeNull();
    expect(claimed?.orderId).toBe(orderId);
    expect(claimed?.printerId).toBe(PRINTER_A_ID);
    expect(claimed?.currentStep.type).toBe("CUSTOMER_DOCUMENT");
    expect(claimed?.currentStep.status).toBe("PENDING");

    // Step 2: Agent preflight detects PAPER_JAM before submission
    const fallbackResult = await repo.handlePreflightFailure({
      agentId: AGENT_ID,
      orderId,
      stepId: claimed!.currentStep.stepId,
      claimId: claimed!.claimId,
      failureCode: "PAPER_JAM",
      failureDetail: "Paper jam in tray 1",
      nowMs: now + 500,
    });

    expect(fallbackResult.action).toBe("FALLBACK_ASSIGNED");
    expect(fallbackResult.fallbackPrinterName).toBe("Backup Counter B&W");
    expect(fallbackResult.printJob?.printerId).toBe(PRINTER_B_ID);
    expect(fallbackResult.printJob?.attemptId).not.toBe(claimed?.attemptId);

    // Verify D1 state:
    // 1. Failing printer is paused with reason PAPER_JAM
    const printerA = sqlite
      .prepare(
        `SELECT is_paused, paused_reason FROM printers WHERE id = '${PRINTER_A_ID}'`,
      )
      .get() as PrinterRow;
    expect(printerA.is_paused).toBe(1);
    expect(printerA.paused_reason).toBe("PAPER_JAM");

    // 2. Old attempt is marked FAILED, new attempt is CREATED on printer_b
    const attempts = sqlite
      .prepare(
        "SELECT id, printer_id, status, fallback_from_printer_id, fallback_reason FROM print_attempts WHERE order_id = ? ORDER BY attempt_number ASC",
      )
      .all(orderId) as unknown as AttemptRow[];
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.id).toBe(claimed!.attemptId);
    expect(attempts[0]?.printer_id).toBe(PRINTER_A_ID);
    expect(attempts[0]?.status).toBe("FAILED");

    expect(attempts[1]?.id).toBe(fallbackResult.printJob?.attemptId);
    expect(attempts[1]?.printer_id).toBe(PRINTER_B_ID);
    expect(attempts[1]?.status).toBe("CREATED");
    expect(attempts[1]?.fallback_from_printer_id).toBe(PRINTER_A_ID);
    expect(attempts[1]?.fallback_reason).toBe("PAPER_JAM");

    // 3. Order is updated to printer_b
    const orderRow = sqlite
      .prepare("SELECT printer_id, fallback_count FROM orders WHERE id = ?")
      .get(orderId) as OrderRow;
    expect(orderRow.printer_id).toBe(PRINTER_B_ID);
    expect(orderRow.fallback_count).toBe(1);
  });

  it("2. Incompatible Fallback: Color order cannot fallback to B&W-only secondary printer, releases claim to prevent starvation", async () => {
    // Printer A is Color, Printer B is B&W only
    seedAgentAndPrinters({ printerBColor: false });
    // Make printer A color
    sqlite.exec(`
      UPDATE printers
      SET capabilities_json = '{"colour":true,"duplex":true,"paperSizes":["A4"]}',
          verified_capabilities_json = '{"verified":{"bw":1,"color":1,"duplex":1,"a4":1,"a3":0},"requiresReview":0}',
          enabled_services_json = '{"bw":1,"color":1,"duplex":1,"a4":1,"a3":0}'
      WHERE id = '${PRINTER_A_ID}';
    `);

    const orderId = "22222222-2222-2222-2222-222222222222";
    seedPaidOrder(orderId, { colorMode: "COLOR" });

    const now = 1_000_100;
    const claimed = await repo.claimOrRenew(AGENT_ID, now);
    expect(claimed?.printerId).toBe(PRINTER_A_ID);

    // Preflight detects OFFLINE
    const result = await repo.handlePreflightFailure({
      agentId: AGENT_ID,
      orderId,
      stepId: claimed!.currentStep.stepId,
      claimId: claimed!.claimId,
      failureCode: "OFFLINE",
      failureDetail: "Printer is turned off",
      nowMs: now + 500,
    });

    // Incompatible fallback -> BLOCKED_RELEASED
    expect(result.action).toBe("BLOCKED_RELEASED");
    expect(result.retryAfterMs).toBe(30_000);

    // Verify order in D1: claim released, status = RETRY_PENDING
    const orderRow = sqlite
      .prepare(
        "SELECT status, claimed_by_agent_id, claim_id, error_category, next_retry_at_ms FROM orders WHERE id = ?",
      )
      .get(orderId) as OrderRow;
    expect(orderRow.status).toBe("RETRY_PENDING");
    expect(orderRow.claimed_by_agent_id).toBeNull();
    expect(orderRow.claim_id).toBeNull();
    expect(orderRow.error_category).toBe("PRINTER_OFFLINE");
    expect(orderRow.next_retry_at_ms).toBe(now + 500 + 30_000);
  });

  it("3. Queue Starvation Prevention: Blocked job on Printer A releases lease, allowing unrelated order for Printer B to progress", async () => {
    seedAgentAndPrinters({ printerBColor: true });
    // Configure Printer A without any fallback printer so it must unstarve
    sqlite.exec(
      `UPDATE printers SET fallback_printer_id = NULL, auto_fallback_enabled = 0 WHERE id = '${PRINTER_A_ID}'`,
    );

    const orderA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const orderB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

    // Order A is queued earlier, targeting Printer A
    seedPaidOrder(orderA, { colorMode: "BW", queuedAt: 1_000_100 });
    seedPaidOrder(orderB, { colorMode: "COLOR", queuedAt: 1_000_200 });
    sqlite.exec(
      `UPDATE orders SET printer_id = '${PRINTER_B_ID}' WHERE id = '${orderB}'`,
    );

    const now = 1_000_000;
    // Step 1: Agent claims Order A
    const jobA = await repo.claimOrRenew(AGENT_ID, now);
    expect(jobA?.orderId).toBe(orderA);
    expect(jobA?.printerId).toBe(PRINTER_A_ID);

    // Step 2: Printer A is jammed; preflight failure reports no fallback
    const releaseRes = await repo.handlePreflightFailure({
      agentId: AGENT_ID,
      orderId: orderA,
      stepId: jobA!.currentStep.stepId,
      claimId: jobA!.claimId,
      failureCode: "PAPER_JAM",
      failureDetail: "Tray jammed",
      nowMs: now + 100,
    });
    expect(releaseRes.action).toBe("BLOCKED_RELEASED");

    // Step 3: Agent immediately polls again (next pulse).
    // Because Order A released its claim and Printer A is paused,
    // Order B (for Printer B) MUST now be claimed!
    const jobB = await repo.claimOrRenew(AGENT_ID, now + 200);
    expect(jobB).not.toBeNull();
    expect(jobB?.orderId).toBe(orderB);
    expect(jobB?.printerId).toBe(PRINTER_B_ID);

    // Step 4: Complete Order B
    await repo.startStep({
      agentId: AGENT_ID,
      orderId: orderB,
      stepId: jobB!.currentStep.stepId,
      claimId: jobB!.claimId,
      nowMs: now + 300,
    });
    await repo.recordSubmission({
      agentId: AGENT_ID,
      orderId: orderB,
      stepId: jobB!.currentStep.stepId,
      claimId: jobB!.claimId,
      spoolerJobId: "spool-b",
      nowMs: now + 400,
    });
    await repo.recordResult({
      agentId: AGENT_ID,
      orderId: orderB,
      stepId: jobB!.currentStep.stepId,
      claimId: jobB!.claimId,
      spoolerJobId: "spool-b",
      status: "SUCCEEDED",
      failureCode: null,
      failureDetail: null,
      nowMs: now + 500,
    });

    const statusB = sqlite
      .prepare("SELECT status FROM orders WHERE id = ?")
      .get(orderB) as OrderRow;
    expect(statusB.status).toBe("COMPLETED");

    // Step 5: Meanwhile, Order A remains RETRY_PENDING with future next_retry_at_ms
    const statusA = sqlite
      .prepare("SELECT status, next_retry_at_ms FROM orders WHERE id = ?")
      .get(orderA) as OrderRow;
    expect(statusA.status).toBe("RETRY_PENDING");
    expect(statusA.next_retry_at_ms).toBeGreaterThan(now);
  });

  it("4. Post-Submission Safety Boundary: Strictly prohibits automatic rerouting once submission has started", async () => {
    seedAgentAndPrinters();
    const orderId = "33333333-3333-3333-3333-333333333333";
    seedPaidOrder(orderId);

    const now = 1_000_000;
    const job = await repo.claimOrRenew(AGENT_ID, now);
    expect(job).not.toBeNull();

    // Start step & submit to spooler
    await repo.startStep({
      agentId: AGENT_ID,
      orderId,
      stepId: job!.currentStep.stepId,
      claimId: job!.claimId,
      nowMs: now + 100,
    });
    await repo.recordSubmission({
      agentId: AGENT_ID,
      orderId,
      stepId: job!.currentStep.stepId,
      claimId: job!.claimId,
      spoolerJobId: "spooler-1234",
      nowMs: now + 200,
    });

    // An agent or bug attempts to request fallback AFTER submission
    const result = await repo.handlePreflightFailure({
      agentId: AGENT_ID,
      orderId,
      stepId: job!.currentStep.stepId,
      claimId: job!.claimId,
      failureCode: "OFFLINE",
      failureDetail: "Printer power dropped mid-job",
      nowMs: now + 300,
    });

    expect(result.action).toBe("ACTION_REQUIRED");
    expect(result.message).toContain("Automatic rerouting is prohibited");

    // Printer is NOT rerouted
    const orderRow = sqlite
      .prepare("SELECT printer_id, status FROM orders WHERE id = ?")
      .get(orderId) as OrderRow;
    expect(orderRow.printer_id).toBe(PRINTER_A_ID);
  });

  it("5. Ambiguous Submission State: Agent crash after SUBMISSION_STARTED transitions to UNCERTAIN / ADMIN_ACTION_REQUIRED", async () => {
    seedAgentAndPrinters();
    const orderId = "44444444-4444-4444-4444-444444444444";
    seedPaidOrder(orderId);

    const now = 1_000_000;
    const job = await repo.claimOrRenew(AGENT_ID, now);

    // Step was started (SumatraPDF launched), but agent crashed before spooler confirmation
    await repo.startStep({
      agentId: AGENT_ID,
      orderId,
      stepId: job!.currentStep.stepId,
      claimId: job!.claimId,
      nowMs: now + 100,
    });

    const result = await repo.handlePreflightFailure({
      agentId: AGENT_ID,
      orderId,
      stepId: job!.currentStep.stepId,
      claimId: job!.claimId,
      failureCode: "UNKNOWN",
      failureDetail: "Agent restarted after submission began",
      nowMs: now + 200,
    });

    expect(result.action).toBe("ACTION_REQUIRED");
    expect(result.message).toContain("Submission was already initiated");

    const orderRow = sqlite
      .prepare("SELECT status, error_category FROM orders WHERE id = ?")
      .get(orderId) as OrderRow;
    expect(orderRow.status).toBe("ADMIN_ACTION_REQUIRED");
    expect(orderRow.error_category).toBe("COMPLETION_UNKNOWN");

    const stepRow = sqlite
      .prepare("SELECT status FROM print_attempt_steps WHERE id = ?")
      .get(job!.currentStep.stepId) as StepRow;
    expect(stepRow.status).toBe("UNCERTAIN");
  });

  it("6. Multi-File Order: File 1 prints on Printer A; File 2 fails preflight on Printer A and safely falls back to Printer B", async () => {
    seedAgentAndPrinters();
    const orderId = "55555555-5555-5555-5555-555555555555";
    const now = 1_000_000;
    const file1Id = "00000000-0000-0000-0000-000000000011";
    const file2Id = "00000000-0000-0000-0000-000000000012";
    const up1Id = crypto.randomUUID();
    const payId = crypto.randomUUID();

    // Seed 2-file order
    sqlite.exec(`
      INSERT INTO orders (
        id, public_job_code, pickup_code, customer_name, customer_phone,
        original_filename, color_mode, paper_size, sides,
        printing_amount_paise, service_charge_paise, total_amount_paise,
        status, cleanup_state, created_at_ms, updated_at_ms, paid_at_ms, queued_at_ms
      ) VALUES (
        '${orderId}', 'JOB-5555', 'PU-5555', 'Multi Customer', '9876543210',
        'file1.pdf', 'BW', 'A4', 'SINGLE',
        2000, 0, 2000,
        'QUEUED', 'ACTIVE', ${now}, ${now}, ${now}, ${now}
      );

      INSERT INTO order_files (id, order_id, position, original_filename, r2_object_key, expected_size_bytes, size_bytes, uploaded_at_ms, source_page_count, selected_pages, copies, color_mode, paper_size, sides, upload_status, print_status, created_at_ms, updated_at_ms)
      VALUES
        ('${file1Id}', '${orderId}', 1, 'file1.pdf', 'uploads/${orderId}/f1.pdf', 1024, 1024, ${now}, 1, 'ALL', 1, 'BW', 'A4', 'SINGLE', 'UPLOADED', 'PENDING', ${now}, ${now}),
        ('${file2Id}', '${orderId}', 2, 'file2.pdf', 'uploads/${orderId}/f2.pdf', 1024, 1024, ${now}, 1, 'ALL', 1, 'BW', 'A4', 'SINGLE', 'UPLOADED', 'PENDING', ${now}, ${now});

      INSERT INTO uploads (id, order_id, r2_object_key, original_filename, mime_type, size_bytes, storage_status, created_at_ms, uploaded_at_ms, updated_at_ms, expected_size_bytes)
      VALUES
        ('${up1Id}', '${orderId}', 'uploads/${orderId}/f1.pdf', 'file1.pdf', 'application/pdf', 1024, 'UPLOADED', ${now}, ${now}, ${now}, 1024);

      INSERT INTO payments (id, order_id, amount_paise, currency, status, provider, provider_order_id, provider_payment_id, created_at_ms, updated_at_ms, verified_at_ms)
      VALUES ('${payId}', '${orderId}', 2000, 'INR', 'PAID', 'RAZORPAY', 'rzp_ord_5', 'rzp_pay_5', ${now}, ${now}, ${now});
    `);

    // 1. Claim and print File 1 on Printer A
    const job1 = await repo.claimOrRenew(AGENT_ID, now);
    expect(job1?.fileId).toBe(file1Id);
    expect(job1?.printerId).toBe(PRINTER_A_ID);

    await repo.startStep({
      agentId: AGENT_ID,
      orderId,
      stepId: job1!.currentStep.stepId,
      claimId: job1!.claimId,
      nowMs: now + 100,
    });
    await repo.recordSubmission({
      agentId: AGENT_ID,
      orderId,
      stepId: job1!.currentStep.stepId,
      claimId: job1!.claimId,
      spoolerJobId: "spool-f1",
      nowMs: now + 200,
    });
    await repo.recordResult({
      agentId: AGENT_ID,
      orderId,
      stepId: job1!.currentStep.stepId,
      claimId: job1!.claimId,
      spoolerJobId: "spool-f1",
      status: "SUCCEEDED",
      failureCode: null,
      failureDetail: null,
      nowMs: now + 300,
    });

    // Verify File 1 is PRINTED
    const f1Row = sqlite
      .prepare(`SELECT print_status FROM order_files WHERE id = '${file1Id}'`)
      .get() as FileRow;
    expect(f1Row.print_status).toBe("PRINTED");

    // 2. Claim File 2
    const job2 = await repo.claimOrRenew(AGENT_ID, now + 400);
    expect(job2?.fileId).toBe(file2Id);
    expect(job2?.printerId).toBe(PRINTER_A_ID);

    // Printer A runs out of paper during File 2 preflight
    const fbRes = await repo.handlePreflightFailure({
      agentId: AGENT_ID,
      orderId,
      stepId: job2!.currentStep.stepId,
      claimId: job2!.claimId,
      failureCode: "PAPER_OUT",
      failureDetail: "Paper tray is empty",
      nowMs: now + 500,
    });

    expect(fbRes.action).toBe("FALLBACK_ASSIGNED");
    expect(fbRes.printJob?.printerId).toBe(PRINTER_B_ID);
    expect(fbRes.printJob?.fileId).toBe(file2Id);

    // Complete File 2 on Printer B
    await repo.startStep({
      agentId: AGENT_ID,
      orderId,
      stepId: fbRes.printJob!.currentStep.stepId,
      claimId: fbRes.printJob!.claimId,
      nowMs: now + 600,
    });
    await repo.recordSubmission({
      agentId: AGENT_ID,
      orderId,
      stepId: fbRes.printJob!.currentStep.stepId,
      claimId: fbRes.printJob!.claimId,
      spoolerJobId: "spool-f2",
      nowMs: now + 700,
    });
    await repo.recordResult({
      agentId: AGENT_ID,
      orderId,
      stepId: fbRes.printJob!.currentStep.stepId,
      claimId: fbRes.printJob!.claimId,
      spoolerJobId: "spool-f2",
      status: "SUCCEEDED",
      failureCode: null,
      failureDetail: null,
      nowMs: now + 800,
    });

    // File 1 is still PRINTED, File 2 is now PRINTED, and order is COMPLETED!
    const files = sqlite
      .prepare(
        "SELECT id, print_status FROM order_files WHERE order_id = ? ORDER BY position ASC",
      )
      .all(orderId) as unknown as FileRow[];
    expect(files[0]?.print_status).toBe("PRINTED");
    expect(files[1]?.print_status).toBe("PRINTED");

    const finalOrder = sqlite
      .prepare("SELECT status FROM orders WHERE id = ?")
      .get(orderId) as OrderRow;
    expect(finalOrder.status).toBe("COMPLETED");
  });

  it("7. Printer Recovery: Blocked job is reclaimed once printer unpauses and next_retry_at_ms arrives", async () => {
    seedAgentAndPrinters();
    sqlite.exec(
      `UPDATE printers SET fallback_printer_id = NULL, auto_fallback_enabled = 0 WHERE id = '${PRINTER_A_ID}'`,
    );

    const orderId = "66666666-6666-6666-6666-666666666666";
    seedPaidOrder(orderId);

    const now = 1_000_000;
    const job = await repo.claimOrRenew(AGENT_ID, now);

    // Fail preflight -> releases lease, backoff 30s
    await repo.handlePreflightFailure({
      agentId: AGENT_ID,
      orderId,
      stepId: job!.currentStep.stepId,
      claimId: job!.claimId,
      failureCode: "PAPER_JAM",
      nowMs: now,
    });

    // Case A: Before retry time (at now + 10s), even if printer is fixed, cannot claim yet
    sqlite.exec(
      `UPDATE printers SET is_paused = 0, status = 'ONLINE' WHERE id = '${PRINTER_A_ID}'`,
    );
    const earlyClaim = await repo.claimOrRenew(AGENT_ID, now + 10_000);
    expect(earlyClaim).toBeNull();

    // Case B: At retry time (now + 30_001ms), printer is online and unpaused -> successfully claimed!
    const reclaimed = await repo.claimOrRenew(AGENT_ID, now + 30_001);
    expect(reclaimed).not.toBeNull();
    expect(reclaimed?.orderId).toBe(orderId);
    expect(reclaimed?.printerId).toBe(PRINTER_A_ID);
  });

  it("8. Disabled Fallback Toggle: When auto_fallback_enabled is 0, automatic fallback is not used", async () => {
    seedAgentAndPrinters({ autoFallbackEnabled: false });
    const orderId = "77777777-7777-7777-7777-777777777777";
    seedPaidOrder(orderId);

    const now = 1_000_000;
    const job = await repo.claimOrRenew(AGENT_ID, now);

    const res = await repo.handlePreflightFailure({
      agentId: AGENT_ID,
      orderId,
      stepId: job!.currentStep.stepId,
      claimId: job!.claimId,
      failureCode: "DOOR_OPEN",
      nowMs: now,
    });

    // Because auto_fallback_enabled = 0 for printer_a, it does not fallback to printer_b
    expect(res.action).toBe("BLOCKED_RELEASED");
  });

  it("9. Multi-File Phase 3 Routing Parity: File 1 (BW) routes to Printer A, File 2 (Color) routes to Printer B without order pin", async () => {
    // Printer A is B&W only (default), Printer B is Color
    seedAgentAndPrinters({ printerBColor: true });
    const orderId = "88888888-8888-8888-8888-888888888888";
    const now = 1_000_000;
    const file1Id = "00000000-0000-0000-0000-000000000081";
    const file2Id = "00000000-0000-0000-0000-000000000082";
    const up1Id = crypto.randomUUID();
    const payId = crypto.randomUUID();

    sqlite.exec(`
      INSERT INTO orders (
        id, public_job_code, pickup_code, customer_name, customer_phone,
        original_filename, color_mode, paper_size, sides,
        printing_amount_paise, service_charge_paise, total_amount_paise,
        status, cleanup_state, created_at_ms, updated_at_ms, paid_at_ms, queued_at_ms
      ) VALUES (
        '${orderId}', 'JOB-8888', 'PU-8888', 'Multi Customer', '9876543210',
        'file1.pdf', 'COLOR', 'A4', 'SINGLE',
        3000, 0, 3000,
        'QUEUED', 'ACTIVE', ${now}, ${now}, ${now}, ${now}
      );

      INSERT INTO order_files (id, order_id, position, original_filename, r2_object_key, expected_size_bytes, size_bytes, uploaded_at_ms, source_page_count, selected_pages, copies, color_mode, paper_size, sides, upload_status, print_status, created_at_ms, updated_at_ms)
      VALUES
        ('${file1Id}', '${orderId}', 1, 'file1.pdf', 'uploads/${orderId}/f1.pdf', 1024, 1024, ${now}, 1, 'ALL', 1, 'BW', 'A4', 'SINGLE', 'UPLOADED', 'PENDING', ${now}, ${now}),
        ('${file2Id}', '${orderId}', 2, 'file2.pdf', 'uploads/${orderId}/f2.pdf', 1024, 1024, ${now}, 1, 'ALL', 1, 'COLOR', 'A4', 'SINGLE', 'UPLOADED', 'PENDING', ${now}, ${now});

      INSERT INTO uploads (id, order_id, r2_object_key, original_filename, mime_type, size_bytes, storage_status, created_at_ms, uploaded_at_ms, updated_at_ms, expected_size_bytes)
      VALUES
        ('${up1Id}', '${orderId}', 'uploads/${orderId}/f1.pdf', 'file1.pdf', 'application/pdf', 1024, 'UPLOADED', ${now}, ${now}, ${now}, 1024);

      INSERT INTO payments (id, order_id, amount_paise, currency, status, provider, provider_order_id, provider_payment_id, created_at_ms, updated_at_ms, verified_at_ms)
      VALUES ('${payId}', '${orderId}', 3000, 'INR', 'PAID', 'RAZORPAY', 'rzp_ord_8', 'rzp_pay_8', ${now}, ${now}, ${now});
    `);

    // 1. Claim File 1 -> must route to default Mono Printer A
    const job1 = await repo.claimOrRenew(AGENT_ID, now);
    expect(job1?.fileId).toBe(file1Id);
    expect(job1?.printerId).toBe(PRINTER_A_ID);

    // Complete File 1 on Printer A
    await repo.startStep({
      agentId: AGENT_ID,
      orderId,
      stepId: job1!.currentStep.stepId,
      claimId: job1!.claimId,
      nowMs: now + 100,
    });
    await repo.recordSubmission({
      agentId: AGENT_ID,
      orderId,
      stepId: job1!.currentStep.stepId,
      claimId: job1!.claimId,
      spoolerJobId: "spool-m1",
      nowMs: now + 200,
    });
    await repo.recordResult({
      agentId: AGENT_ID,
      orderId,
      stepId: job1!.currentStep.stepId,
      claimId: job1!.claimId,
      spoolerJobId: "spool-m1",
      status: "SUCCEEDED",
      failureCode: null,
      failureDetail: null,
      nowMs: now + 300,
    });

    const f1Status = sqlite
      .prepare(`SELECT print_status FROM order_files WHERE id = '${file1Id}'`)
      .get() as FileRow;
    expect(f1Status.print_status).toBe("PRINTED");

    // 2. Claim File 2 -> must route to Color Printer B via Phase 3 capability routing!
    const job2 = await repo.claimOrRenew(AGENT_ID, now + 400);
    expect(job2).not.toBeNull();
    expect(job2?.fileId).toBe(file2Id);
    expect(job2?.printerId).toBe(PRINTER_B_ID);

    // Complete File 2 on Printer B
    await repo.startStep({
      agentId: AGENT_ID,
      orderId,
      stepId: job2!.currentStep.stepId,
      claimId: job2!.claimId,
      nowMs: now + 500,
    });
    await repo.recordSubmission({
      agentId: AGENT_ID,
      orderId,
      stepId: job2!.currentStep.stepId,
      claimId: job2!.claimId,
      spoolerJobId: "spool-m2",
      nowMs: now + 600,
    });
    await repo.recordResult({
      agentId: AGENT_ID,
      orderId,
      stepId: job2!.currentStep.stepId,
      claimId: job2!.claimId,
      spoolerJobId: "spool-m2",
      status: "SUCCEEDED",
      failureCode: null,
      failureDetail: null,
      nowMs: now + 700,
    });

    const finalOrder = sqlite
      .prepare("SELECT status FROM orders WHERE id = ?")
      .get(orderId) as OrderRow;
    expect(finalOrder.status).toBe("COMPLETED");

    // Verify durable attempt history recorded each printer accurately
    const attempts = sqlite
      .prepare(
        "SELECT printer_id, status FROM print_attempts WHERE order_id = ? ORDER BY attempt_number ASC",
      )
      .all(orderId) as unknown as AttemptRow[];
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.printer_id).toBe(PRINTER_A_ID);
    expect(attempts[0]?.status).toBe("SUCCEEDED");
    expect(attempts[1]?.printer_id).toBe(PRINTER_B_ID);
    expect(attempts[1]?.status).toBe("SUCCEEDED");
  });

  it("10. Multi-File Failure Isolation: File 1 completed; File 2 preflight failure unstarves queue without re-printing File 1", async () => {
    seedAgentAndPrinters({ printerBColor: true });
    // Configure Printer B without fallback
    sqlite.exec(
      `UPDATE printers SET fallback_printer_id = NULL, auto_fallback_enabled = 0 WHERE id = '${PRINTER_B_ID}'`,
    );

    const orderId = "99999999-9999-9999-9999-999999999999";
    const now = 1_000_000;
    const file1Id = "00000000-0000-0000-0000-000000000091";
    const file2Id = "00000000-0000-0000-0000-000000000092";
    const up1Id = crypto.randomUUID();
    const payId = crypto.randomUUID();

    sqlite.exec(`
      INSERT INTO orders (
        id, public_job_code, pickup_code, customer_name, customer_phone,
        original_filename, color_mode, paper_size, sides,
        printing_amount_paise, service_charge_paise, total_amount_paise,
        status, cleanup_state, created_at_ms, updated_at_ms, paid_at_ms, queued_at_ms
      ) VALUES (
        '${orderId}', 'JOB-9999', 'PU-9999', 'Customer', '9876543210',
        'file1.pdf', 'COLOR', 'A4', 'SINGLE',
        3000, 0, 3000,
        'QUEUED', 'ACTIVE', ${now}, ${now}, ${now}, ${now}
      );

      INSERT INTO order_files (id, order_id, position, original_filename, r2_object_key, expected_size_bytes, size_bytes, uploaded_at_ms, source_page_count, selected_pages, copies, color_mode, paper_size, sides, upload_status, print_status, created_at_ms, updated_at_ms)
      VALUES
        ('${file1Id}', '${orderId}', 1, 'file1.pdf', 'uploads/${orderId}/f1.pdf', 1024, 1024, ${now}, 1, 'ALL', 1, 'BW', 'A4', 'SINGLE', 'UPLOADED', 'PENDING', ${now}, ${now}),
        ('${file2Id}', '${orderId}', 2, 'file2.pdf', 'uploads/${orderId}/f2.pdf', 1024, 1024, ${now}, 1, 'ALL', 1, 'COLOR', 'A4', 'SINGLE', 'UPLOADED', 'PENDING', ${now}, ${now});

      INSERT INTO uploads (id, order_id, r2_object_key, original_filename, mime_type, size_bytes, storage_status, created_at_ms, uploaded_at_ms, updated_at_ms, expected_size_bytes)
      VALUES
        ('${up1Id}', '${orderId}', 'uploads/${orderId}/f1.pdf', 'file1.pdf', 'application/pdf', 1024, 'UPLOADED', ${now}, ${now}, ${now}, 1024);

      INSERT INTO payments (id, order_id, amount_paise, currency, status, provider, provider_order_id, provider_payment_id, created_at_ms, updated_at_ms, verified_at_ms)
      VALUES ('${payId}', '${orderId}', 3000, 'INR', 'PAID', 'RAZORPAY', 'rzp_ord_9', 'rzp_pay_9', ${now}, ${now}, ${now});
    `);

    // Complete File 1
    const job1 = await repo.claimOrRenew(AGENT_ID, now);
    await repo.startStep({
      agentId: AGENT_ID,
      orderId,
      stepId: job1!.currentStep.stepId,
      claimId: job1!.claimId,
      nowMs: now + 100,
    });
    await repo.recordSubmission({
      agentId: AGENT_ID,
      orderId,
      stepId: job1!.currentStep.stepId,
      claimId: job1!.claimId,
      spoolerJobId: "spool-iso1",
      nowMs: now + 200,
    });
    await repo.recordResult({
      agentId: AGENT_ID,
      orderId,
      stepId: job1!.currentStep.stepId,
      claimId: job1!.claimId,
      spoolerJobId: "spool-iso1",
      status: "SUCCEEDED",
      failureCode: null,
      failureDetail: null,
      nowMs: now + 300,
    });

    // Claim File 2 on Printer B
    const job2 = await repo.claimOrRenew(AGENT_ID, now + 400);
    expect(job2?.printerId).toBe(PRINTER_B_ID);

    // Preflight detects OFFLINE on Printer B
    const fbRes = await repo.handlePreflightFailure({
      agentId: AGENT_ID,
      orderId,
      stepId: job2!.currentStep.stepId,
      claimId: job2!.claimId,
      failureCode: "OFFLINE",
      failureDetail: "Printer B unplugged",
      nowMs: now + 500,
    });
    expect(fbRes.action).toBe("BLOCKED_RELEASED");

    // File 1 remains PRINTED
    const f1Row = sqlite
      .prepare(`SELECT print_status FROM order_files WHERE id = '${file1Id}'`)
      .get() as FileRow;
    expect(f1Row.print_status).toBe("PRINTED");

    // File 2 remains PENDING with order in RETRY_PENDING
    const f2Row = sqlite
      .prepare(`SELECT print_status FROM order_files WHERE id = '${file2Id}'`)
      .get() as FileRow;
    expect(f2Row.print_status).toBe("PENDING");

    const orderRow = sqlite
      .prepare("SELECT status, claimed_by_agent_id FROM orders WHERE id = ?")
      .get(orderId) as OrderRow;
    expect(orderRow.status).toBe("RETRY_PENDING");
    expect(orderRow.claimed_by_agent_id).toBeNull();
  });

  it("11. Stale Agent Fencing: Expired claim lease rejects preflight reporting and prevents rerouting", async () => {
    seedAgentAndPrinters();
    const orderId = "aaaaaaaa-1111-2222-3333-444444444444";
    seedPaidOrder(orderId);

    const now = 1_000_000;
    const job = await repo.claimOrRenew(AGENT_ID, now);
    expect(job).not.toBeNull();

    // Fast-forward past claim lease expiration (5 minutes + 1ms)
    const expiredNow = now + 300_001;

    // Stale agent attempts to report preflight failure after lease expired
    const result = await repo.handlePreflightFailure({
      agentId: AGENT_ID,
      orderId,
      stepId: job!.currentStep.stepId,
      claimId: job!.claimId,
      failureCode: "PAPER_OUT",
      nowMs: expiredNow,
    });

    expect(result.action).toBe("ACTION_REQUIRED");
    expect(result.message).toContain("not owned by active agent lease");
  });

  it("12. Gated Backoff Query Optimization: Excludes backed-off orders from executing recovery and candidate queries", async () => {
    seedAgentAndPrinters();
    sqlite.exec(
      `UPDATE printers SET fallback_printer_id = NULL, auto_fallback_enabled = 0 WHERE id = '${PRINTER_A_ID}'`,
    );

    const orderId = "bbbbbbbb-1111-2222-3333-444444444444";
    seedPaidOrder(orderId);

    const now = 1_000_000;
    const job = await repo.claimOrRenew(AGENT_ID, now);

    // Fail preflight -> backoff 30s
    await repo.handlePreflightFailure({
      agentId: AGENT_ID,
      orderId,
      stepId: job!.currentStep.stepId,
      claimId: job!.claimId,
      failureCode: "PAPER_JAM",
      nowMs: now,
    });

    // Pulse at now + 5s (during backoff period)
    const pulseDuringBackoff = await repo.claimOrRenew(AGENT_ID, now + 5_000);
    // Must return null without claiming
    expect(pulseDuringBackoff).toBeNull();
  });
});
