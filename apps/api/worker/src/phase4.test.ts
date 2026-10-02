import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  normalizePrinterFailure,
  isPrinterWideFailure,
  toCustomerOrderStatus,
} from "@printgo/domain";
import { D1AgentRepository } from "./agent/repository.js";
import { D1CustomerRepository } from "./customer/repository.js";
import { D1PrintingRepository } from "./printing/repository.js";

function createTestDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
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
  ];
  for (const name of migrationFiles) {
    db.exec(
      readFileSync(
        new URL(`../../../../database/migrations/${name}`, import.meta.url),
        "utf8",
      ),
    );
  }
  return db;
}

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
  return {
    prepare: (sql: string) => new StatementWrapper(db, sql),
    async batch(statements: StatementWrapper[]) {
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
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    exec: (sql: string) => {
      db.exec(sql);
      return Promise.resolve({ count: 1, duration: 0 });
    },
    dump: () => Promise.resolve(new ArrayBuffer(0)),
  } as unknown as D1Database;
}

const AGENT_ID = "00000000-0000-0000-0000-000000000001";
const PRINTER_ID = "00000000-0000-0000-0000-000000000002";

function seedAgentAndPrinter(rawDb: DatabaseSync, nowMs = 1_000_000) {
  rawDb.exec(`
    INSERT OR REPLACE INTO installation (
      id, shop_name, contact_phone, address, customer_notice,
      online_printing_enabled, max_pdf_size_bytes, max_order_upload_bytes,
      identification_sheet_enabled, default_production_printer_id,
      created_at_ms, updated_at_ms
    ) VALUES (
      1, 'Test Shop', '+919876543210', 'Shop Address', 'Notice',
      1, 26214400, 104857600,
      0, '${PRINTER_ID}',
      ${nowMs}, ${nowMs}
    );

    INSERT OR REPLACE INTO agents (id, display_name, credential_hash, is_active, paired_at_ms, last_heartbeat_at_ms, created_at_ms, updated_at_ms)
    VALUES ('${AGENT_ID}', 'Counter PC', 'hash_credential', 1, ${nowMs}, ${nowMs}, ${nowMs}, ${nowMs});

    INSERT OR REPLACE INTO printers (
      id, agent_id, display_name, windows_printer_name, enabled, status,
      is_production_eligible, is_virtual, capabilities_json, created_at_ms, updated_at_ms
    ) VALUES (
      '${PRINTER_ID}', '${AGENT_ID}', 'Main HP Laser', 'HP LaserJet Pro', 1, 'ONLINE',
      1, 0, '{"colour":1,"duplex":1,"paperSizes":["A4","A3"]}', ${nowMs}, ${nowMs}
    );
  `);
}

function insertPaidOrder(
  rawDb: DatabaseSync,
  id: string,
  opts: {
    status?: string;
    isPriority?: boolean;
    queuedAtMs?: number;
    pickupCode?: string;
    nowMs?: number;
  } = {},
) {
  const now = opts.nowMs ?? 1_000_000;
  const status = opts.status ?? "QUEUED";
  const priority = opts.isPriority ? 1 : 0;
  const queuedAt = opts.queuedAtMs ?? now;
  const pickup = opts.pickupCode ?? `PZ-${id.slice(-3)}`;

  const payId = crypto.randomUUID();
  const fileId = crypto.randomUUID();
  const uploadId = crypto.randomUUID();

  const needsClaim = [
    "CLAIMED",
    "SPOOLING",
    "PRINTING",
    "PRINT_BLOCKED",
    "PRINT_FAILED",
    "ADMIN_ACTION_REQUIRED",
    "PRINTED",
  ].includes(status);

  const claimedBy = needsClaim ? `'${AGENT_ID}'` : "NULL";
  const claimId = needsClaim ? `'${crypto.randomUUID()}'` : "NULL";
  const claimExpires = needsClaim ? now + 60_000 : "NULL";
  const claimedAt = needsClaim ? now : "NULL";

  rawDb.exec(`
    INSERT INTO orders (
      id, public_job_code, pickup_code, customer_name, customer_phone,
      original_filename, selected_pages, copies, color_mode, paper_size, sides,
      printing_amount_paise, service_charge_paise, total_amount_paise,
      status, is_priority, queued_at_ms, created_at_ms, updated_at_ms, cleanup_state,
      claimed_by_agent_id, claim_id, claim_expires_at_ms, claimed_at_ms
    ) VALUES (
      '${id}', 'JOB-${id}', '${pickup}', 'Alice', '+919876543210',
      'doc_${id}.pdf', 'ALL', 1, 'BW', 'A4', 'SINGLE',
      1000, 0, 1000,
      '${status}', ${priority}, ${queuedAt}, ${Math.min(now, queuedAt)}, ${now}, 'ACTIVE',
      ${claimedBy}, ${claimId}, ${claimExpires}, ${claimedAt}
    );

    INSERT INTO payments (
      id, order_id, provider, status, amount_paise, currency,
      provider_order_id, provider_payment_id, verified_at_ms, created_at_ms, updated_at_ms
    ) VALUES (
      '${payId}', '${id}', 'RAZORPAY', 'PAID', 1000, 'INR',
      'order_ext_${id}', 'pay_ext_${id}', ${now}, ${now}, ${now}
    );

    INSERT INTO order_files (
      id, order_id, position, original_filename, r2_object_key,
      expected_size_bytes, size_bytes, source_page_count, selected_pages,
      copies, paper_size, color_mode, sides, printing_amount_paise,
      service_charge_paise, upload_status, print_status, uploaded_at_ms, created_at_ms, updated_at_ms
    ) VALUES (
      '${fileId}', '${id}', 1, 'doc_${id}.pdf', 'uploads/${id}/doc.pdf',
      1024, 1024, 1, 'ALL',
      1, 'A4', 'BW', 'SINGLE', 1000,
      0, 'UPLOADED', 'PENDING', ${now}, ${now}, ${now}
    );

    INSERT INTO uploads (
      id, order_id, r2_object_key, original_filename, mime_type, size_bytes,
      storage_status, uploaded_at_ms, created_at_ms, updated_at_ms
    ) VALUES (
      '${uploadId}', '${id}', 'uploads/${id}/doc.pdf', 'doc_${id}.pdf', 'application/pdf', 1024,
      'UPLOADED', ${now}, ${now}, ${now}
    );
  `);
}

describe("Phase 4: Print Failure Recovery + Queue Pause/Resume", () => {
  it("normalizes printer failures accurately", () => {
    expect(normalizePrinterFailure("OFFLINE")).toBe("PRINTER_OFFLINE");
    expect(normalizePrinterFailure("printer_offline")).toBe("PRINTER_OFFLINE");
    expect(normalizePrinterFailure("Printer is not available or offline")).toBe(
      "PRINTER_OFFLINE",
    );
    expect(normalizePrinterFailure("PAPER_OUT")).toBe("PAPER_OUT");
    expect(normalizePrinterFailure("out_of_paper")).toBe("PAPER_OUT");
    expect(normalizePrinterFailure("JAM in tray 2")).toBe("PAPER_JAM");
    expect(normalizePrinterFailure("COMM_ERROR")).toBe("CONNECTION_LOST");
    expect(normalizePrinterFailure("Spooler service RPC error")).toBe(
      "SPOOLER_ERROR",
    );
    expect(normalizePrinterFailure("TONER_LOW / USER_INTERVENTION")).toBe(
      "PRINTER_ERROR",
    );
    expect(normalizePrinterFailure("Corrupt PDF syntax")).toBe("UNKNOWN");
    expect(normalizePrinterFailure(null)).toBe("UNKNOWN");

    expect(isPrinterWideFailure("PRINTER_OFFLINE")).toBe(true);
    expect(isPrinterWideFailure("PAPER_OUT")).toBe(true);
    expect(isPrinterWideFailure("PAPER_JAM")).toBe(true);
    expect(isPrinterWideFailure("CONNECTION_LOST")).toBe(true);
    expect(isPrinterWideFailure("SPOOLER_ERROR")).toBe(true);
    expect(isPrinterWideFailure("PRINTER_ERROR")).toBe(true);
    expect(isPrinterWideFailure("UNKNOWN")).toBe(false);
  });

  it("File/Job Failure: when B fails on healthy printer, B -> RETRY_PENDING and C/D continue", async () => {
    const rawDb = createTestDatabase();
    const d1 = asD1(rawDb);
    const repo = new D1PrintingRepository(d1);
    const nowMs = 1_000_000;
    seedAgentAndPrinter(rawDb, nowMs);

    // Queue: A (id: 1111...), B (id: 2222...), C (id: 3333...), D (id: 4444...)
    insertPaidOrder(rawDb, "11111111-1111-1111-1111-111111111111", {
      queuedAtMs: 1000,
      nowMs,
    });
    insertPaidOrder(rawDb, "22222222-2222-2222-2222-222222222222", {
      queuedAtMs: 2000,
      nowMs,
    });
    insertPaidOrder(rawDb, "33333333-3333-3333-3333-333333333333", {
      queuedAtMs: 3000,
      nowMs,
    });
    insertPaidOrder(rawDb, "44444444-4444-4444-4444-444444444444", {
      queuedAtMs: 4000,
      nowMs,
    });

    // 1. Claim and complete A
    const jobA = await repo.claimOrRenew(AGENT_ID, nowMs);
    expect(jobA?.orderId).toBe("11111111-1111-1111-1111-111111111111");
    await repo.startStep({
      orderId: jobA!.orderId,
      stepId: jobA!.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: jobA!.claimId,
      nowMs,
    });
    await repo.recordSubmission({
      orderId: jobA!.orderId,
      stepId: jobA!.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: jobA!.claimId,
      spoolerJobId: "spool-1",
      nowMs,
    });
    await repo.recordResult({
      orderId: jobA!.orderId,
      stepId: jobA!.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: jobA!.claimId,
      spoolerJobId: "spool-1",
      status: "SUCCEEDED",
      failureCode: null,
      failureDetail: null,
      nowMs: nowMs + 1000,
    });

    const statusA = rawDb
      .prepare("SELECT status FROM orders WHERE id = ?")
      .get("11111111-1111-1111-1111-111111111111") as { status: string };
    expect(statusA.status).toBe("COMPLETED");

    // 2. Claim B
    const jobB = await repo.claimOrRenew(AGENT_ID, nowMs + 1100);
    expect(jobB?.orderId).toBe("22222222-2222-2222-2222-222222222222");

    await repo.startStep({
      orderId: jobB!.orderId,
      stepId: jobB!.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: jobB!.claimId,
      nowMs: nowMs + 1200,
    });

    // B fails due to corrupt document / font parsing error (healthy printer)
    await repo.recordResult({
      orderId: jobB!.orderId,
      stepId: jobB!.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: jobB!.claimId,
      spoolerJobId: null,
      status: "FAILED",
      failureCode: "INVALID_PDF",
      failureDetail: "Could not parse embedded font",
      nowMs: nowMs + 1300,
    });

    // Check B state: RETRY_PENDING, attempt_count = 1, next_retry_at_ms = now + 10_000, claim released
    const rowB = rawDb
      .prepare(
        "SELECT status, attempt_count, next_retry_at_ms, claimed_by_agent_id, claim_id FROM orders WHERE id = ?",
      )
      .get("22222222-2222-2222-2222-222222222222") as {
      status: string;
      attempt_count: number;
      next_retry_at_ms: number;
      claimed_by_agent_id: string | null;
      claim_id: string | null;
    };
    expect(rowB.status).toBe("RETRY_PENDING");
    expect(rowB.attempt_count).toBe(1);
    expect(rowB.next_retry_at_ms).toBe(nowMs + 1300 + 10_000);
    expect(rowB.claimed_by_agent_id).toBeNull();
    expect(rowB.claim_id).toBeNull();

    // 3. Agent is NOT blocked: C continues!
    const jobC = await repo.claimOrRenew(AGENT_ID, nowMs + 1400);
    expect(jobC?.orderId).toBe("33333333-3333-3333-3333-333333333333");

    // Complete C
    await repo.startStep({
      orderId: jobC!.orderId,
      stepId: jobC!.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: jobC!.claimId,
      nowMs: nowMs + 1500,
    });
    await repo.recordSubmission({
      orderId: jobC!.orderId,
      stepId: jobC!.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: jobC!.claimId,
      spoolerJobId: "spool-3",
      nowMs: nowMs + 1600,
    });
    await repo.recordResult({
      orderId: jobC!.orderId,
      stepId: jobC!.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: jobC!.claimId,
      spoolerJobId: "spool-3",
      status: "SUCCEEDED",
      failureCode: null,
      failureDetail: null,
      nowMs: nowMs + 2000,
    });

    // 4. D continues!
    const jobD = await repo.claimOrRenew(AGENT_ID, nowMs + 2100);
    expect(jobD?.orderId).toBe("44444444-4444-4444-4444-444444444444");

    // Complete D
    await repo.startStep({
      orderId: jobD!.orderId,
      stepId: jobD!.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: jobD!.claimId,
      nowMs: nowMs + 2200,
    });
    await repo.recordSubmission({
      orderId: jobD!.orderId,
      stepId: jobD!.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: jobD!.claimId,
      spoolerJobId: "spool-4",
      nowMs: nowMs + 2300,
    });
    await repo.recordResult({
      orderId: jobD!.orderId,
      stepId: jobD!.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: jobD!.claimId,
      spoolerJobId: "spool-4",
      status: "SUCCEEDED",
      failureCode: null,
      failureDetail: null,
      nowMs: nowMs + 2500,
    });

    // 5. Normal queued work is now finished.
    // At t = nowMs + 3000 (< B's next_retry_at_ms = nowMs + 11300), B is NOT claimed yet
    const earlyJob = await repo.claimOrRenew(AGENT_ID, nowMs + 3000);
    expect(earlyJob).toBeNull();

    // 6. After 10s wait (t = nowMs + 12000), B is retried!
    const retryJobB1 = await repo.claimOrRenew(AGENT_ID, nowMs + 12000);
    expect(retryJobB1?.orderId).toBe("22222222-2222-2222-2222-222222222222");

    // Retry 1 fails again
    await repo.startStep({
      orderId: retryJobB1!.orderId,
      stepId: retryJobB1!.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: retryJobB1!.claimId,
      nowMs: nowMs + 12100,
    });
    await repo.recordResult({
      orderId: retryJobB1!.orderId,
      stepId: retryJobB1!.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: retryJobB1!.claimId,
      spoolerJobId: null,
      status: "FAILED",
      failureCode: "INVALID_PDF",
      failureDetail: "Still corrupt",
      nowMs: nowMs + 12200,
    });

    const rowB2 = rawDb
      .prepare(
        "SELECT status, attempt_count, next_retry_at_ms FROM orders WHERE id = ?",
      )
      .get("22222222-2222-2222-2222-222222222222") as {
      status: string;
      attempt_count: number;
      next_retry_at_ms: number;
    };
    expect(rowB2.status).toBe("RETRY_PENDING");
    expect(rowB2.attempt_count).toBe(2);
    expect(rowB2.next_retry_at_ms).toBe(nowMs + 12200 + 10_000);

    // 7. Retry 2 (Attempt 3 total): after another 10s
    const retryJobB2 = await repo.claimOrRenew(AGENT_ID, nowMs + 23000);
    expect(retryJobB2?.orderId).toBe("22222222-2222-2222-2222-222222222222");

    // Retry 2 fails again -> max 3 attempts reached (1 original + 2 retries) -> NEEDS_ADMIN!
    await repo.startStep({
      orderId: retryJobB2!.orderId,
      stepId: retryJobB2!.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: retryJobB2!.claimId,
      nowMs: nowMs + 23100,
    });
    await repo.recordResult({
      orderId: retryJobB2!.orderId,
      stepId: retryJobB2!.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: retryJobB2!.claimId,
      spoolerJobId: null,
      status: "FAILED",
      failureCode: "INVALID_PDF",
      failureDetail: "Permanent parse error",
      nowMs: nowMs + 23200,
    });

    const rowB3 = rawDb
      .prepare(
        "SELECT status, attempt_count, next_retry_at_ms, raw_error FROM orders WHERE id = ?",
      )
      .get("22222222-2222-2222-2222-222222222222") as {
      status: string;
      attempt_count: number;
      next_retry_at_ms: number | null;
      raw_error: string;
    };
    expect(rowB3.status).toBe("NEEDS_ADMIN");
    expect(rowB3.attempt_count).toBe(3);
    expect(rowB3.next_retry_at_ms).toBeNull();
    expect(rowB3.raw_error).toBe("Permanent parse error");

    // Admin can see it in live orders
    const live = await repo.listLiveOrders(nowMs + 23300);
    const liveB = live.find(
      (o) => o.orderId === "22222222-2222-2222-2222-222222222222",
    );
    expect(liveB?.status).toBe("NEEDS_ADMIN");
    expect(liveB?.attemptCount).toBe(3);
    expect(liveB?.rawError).toBe("Permanent parse error");

    // Admin clicks [ Retry Print ]
    const retryRes = await repo.retryOrder({
      orderId: "22222222-2222-2222-2222-222222222222",
      adminId: "admin_1",
      nowMs: nowMs + 24000,
    });
    expect(retryRes.status).toBe("QUEUED");

    const rowBReset = rawDb
      .prepare(
        "SELECT status, attempt_count, raw_error FROM orders WHERE id = ?",
      )
      .get("22222222-2222-2222-2222-222222222222") as {
      status: string;
      attempt_count: number;
      raw_error: string | null;
    };
    expect(rowBReset.status).toBe("QUEUED");
    expect(rowBReset.attempt_count).toBe(0);
    expect(rowBReset.raw_error).toBeNull();
  });

  it("Printer-wide Failure: pauses the printer queue without failing C/D, and manual check does not blindly resume", async () => {
    const rawDb = createTestDatabase();
    const d1 = asD1(rawDb);
    const printRepo = new D1PrintingRepository(d1);
    const agentRepo = new D1AgentRepository(d1);
    const nowMs = 1_000_000;
    seedAgentAndPrinter(rawDb, nowMs);

    // Queue: B (id: bbbb...), C (id: cccc...)
    insertPaidOrder(rawDb, "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", {
      queuedAtMs: 1000,
      nowMs,
    });
    insertPaidOrder(rawDb, "cccccccc-cccc-cccc-cccc-cccccccccccc", {
      queuedAtMs: 2000,
      nowMs,
    });

    // Claim B
    const jobB = await printRepo.claimOrRenew(AGENT_ID, nowMs);
    expect(jobB?.orderId).toBe("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");

    await printRepo.startStep({
      orderId: jobB!.orderId,
      stepId: jobB!.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: jobB!.claimId,
      nowMs: nowMs + 100,
    });

    // Printer reports PAPER_JAM (a printer-wide failure)
    await printRepo.recordResult({
      orderId: jobB!.orderId,
      stepId: jobB!.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: jobB!.claimId,
      spoolerJobId: null,
      status: "BLOCKED",
      failureCode: "PAPER_JAM",
      failureDetail: "Paper jam in internal tray",
      nowMs: nowMs + 200,
    });

    // 1. Printer is paused!
    const printer = rawDb
      .prepare(
        "SELECT is_paused, paused_reason, paused_at_ms FROM printers WHERE id = ?",
      )
      .get(PRINTER_ID) as {
      is_paused: number;
      paused_reason: string;
      paused_at_ms: number;
    };
    expect(printer.is_paused).toBe(1);
    expect(printer.paused_reason).toBe("PAPER_JAM");
    expect(printer.paused_at_ms).toBe(nowMs + 200);

    // 2. Order B is in PRINT_BLOCKED
    const orderB = rawDb
      .prepare(
        "SELECT status, error_category, raw_error FROM orders WHERE id = ?",
      )
      .get("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb") as {
      status: string;
      error_category: string;
      raw_error: string;
    };
    expect(orderB.status).toBe("PRINT_BLOCKED");
    expect(orderB.error_category).toBe("PAPER_JAM");

    // 3. Printer is paused, so C is NOT claimed!
    const pollResult = await printRepo.claimOrRenew(AGENT_ID, nowMs + 300);
    expect(pollResult?.orderId).not.toBe(
      "cccccccc-cccc-cccc-cccc-cccccccccccc",
    );

    // C is NOT failed; remains in QUEUED
    const orderC = rawDb
      .prepare("SELECT status FROM orders WHERE id = ?")
      .get("cccccccc-cccc-cccc-cccc-cccccccccccc") as { status: string };
    expect(orderC.status).toBe("QUEUED");

    // 4. Admin clicks [ Issue Solved / Check Again ] while printer is still jammed
    // Update printer table status_reason to reflect jam
    rawDb
      .prepare("UPDATE printers SET status_reason = 'Paper jam' WHERE id = ?")
      .run(PRINTER_ID);

    const healthCheck1 = await agentRepo.checkPrinterHealth(
      PRINTER_ID,
      "admin_1",
      nowMs + 400,
    );
    expect(healthCheck1.isPaused).toBe(true);
    expect(healthCheck1.message).toContain("still reporting issue");

    // Queue is STILL paused! Does NOT blindly resume!
    const printerStillPaused = rawDb
      .prepare("SELECT is_paused FROM printers WHERE id = ?")
      .get(PRINTER_ID) as { is_paused: number };
    expect(printerStillPaused.is_paused).toBe(1);

    // 5. Operator clears paper jam: printer reports ONLINE with no error
    rawDb
      .prepare(
        "UPDATE printers SET status = 'ONLINE', status_reason = NULL WHERE id = ?",
      )
      .run(PRINTER_ID);

    const healthCheck2 = await agentRepo.checkPrinterHealth(
      PRINTER_ID,
      "admin_1",
      nowMs + 500,
    );
    expect(healthCheck2.isPaused).toBe(false);
    expect(healthCheck2.message).toContain("healthy and online");

    // Queue is unpaused!
    const printerUnpaused = rawDb
      .prepare("SELECT is_paused, paused_reason FROM printers WHERE id = ?")
      .get(PRINTER_ID) as {
      is_paused: number;
      paused_reason: string | null;
    };
    expect(printerUnpaused.is_paused).toBe(0);
    expect(printerUnpaused.paused_reason).toBeNull();

    // Admin printer details endpoint reflects unpaused status
    const agents = await agentRepo.listAgentsWithPrinters(nowMs + 600);
    const pDetails = agents[0]?.printers.find((p) => p.id === PRINTER_ID);
    expect(pDetails?.isPaused).toBe(false);
    expect(pDetails?.pausedReason).toBeNull();
  });

  it("Interrupted / Partial Print (uncertain outcome) transitions to COMPLETION_UNKNOWN and is not auto-reprinted", async () => {
    const rawDb = createTestDatabase();
    const d1 = asD1(rawDb);
    const repo = new D1PrintingRepository(d1);
    const nowMs = 1_000_000;
    seedAgentAndPrinter(rawDb, nowMs);

    insertPaidOrder(rawDb, "55555555-5555-5555-5555-555555555555", { nowMs });

    const job = await repo.claimOrRenew(AGENT_ID, nowMs);
    expect(job?.orderId).toBe("55555555-5555-5555-5555-555555555555");

    await repo.startStep({
      orderId: job!.orderId,
      stepId: job!.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: job!.claimId,
      nowMs: nowMs + 100,
    });

    // Spool job reported as UNCERTAIN (cannot prove physical completion)
    await repo.recordResult({
      orderId: job!.orderId,
      stepId: job!.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: job!.claimId,
      spoolerJobId: null,
      status: "UNCERTAIN",
      failureCode: "UNKNOWN",
      failureDetail: "Agent restarted after submission; outcome uncertain",
      nowMs: nowMs + 200,
    });

    const orderRow = rawDb
      .prepare(
        "SELECT status, error_category, claimed_by_agent_id, claim_id FROM orders WHERE id = ?",
      )
      .get("55555555-5555-5555-5555-555555555555") as {
      status: string;
      error_category: string;
      claimed_by_agent_id: string | null;
      claim_id: string | null;
    };
    expect(orderRow.status).toBe("COMPLETION_UNKNOWN");
    expect(orderRow.error_category).toBe("COMPLETION_UNKNOWN");
    expect(orderRow.claimed_by_agent_id).toBeNull();
    expect(orderRow.claim_id).toBeNull();

    // Verify it is NOT automatically claimed or reprinted
    const nextClaim = await repo.claimOrRenew(AGENT_ID, nowMs + 500);
    expect(nextClaim).toBeNull();

    // Retrying without forceUncertain throws error to protect against unintentional duplicate prints
    await expect(
      repo.retryOrder({
        orderId: "55555555-5555-5555-5555-555555555555",
        adminId: "admin_1",
        forceUncertain: false,
        nowMs: nowMs + 600,
      }),
    ).rejects.toThrow("UNCERTAIN_RETRY_CONFIRMATION_REQUIRED");

    // With explicit confirmation, admin can retry
    const retried = await repo.retryOrder({
      orderId: "55555555-5555-5555-5555-555555555555",
      adminId: "admin_1",
      forceUncertain: true,
      nowMs: nowMs + 700,
    });
    expect(retried.status).toBe("QUEUED");
  });

  it("Order & Cleanup Safety: unfinished and uncertain jobs do not trigger completed-order cleanup", () => {
    const rawDb = createTestDatabase();
    const nowMs = 1_000_000;
    seedAgentAndPrinter(rawDb, nowMs);

    insertPaidOrder(rawDb, "66666666-6666-6666-6666-666666666666", {
      status: "RETRY_PENDING",
      nowMs,
    });
    insertPaidOrder(rawDb, "77777777-7777-7777-7777-777777777777", {
      status: "NEEDS_ADMIN",
      nowMs,
    });
    insertPaidOrder(rawDb, "88888888-8888-8888-8888-888888888888", {
      status: "COMPLETION_UNKNOWN",
      nowMs,
    });
    insertPaidOrder(rawDb, "99999999-9999-9999-9999-999999999999", {
      status: "PRINT_BLOCKED",
      nowMs,
    });

    // In all non-completed states, purge_at_ms must be NULL
    const orders = rawDb
      .prepare(
        "SELECT id, status, purge_at_ms FROM orders WHERE id LIKE '666%' OR id LIKE '777%' OR id LIKE '888%' OR id LIKE '999%'",
      )
      .all() as Array<{
      id: string;
      status: string;
      purge_at_ms: number | null;
    }>;
    expect(orders).toHaveLength(4);
    for (const o of orders) {
      expect(o.purge_at_ms).toBeNull();
    }
  });

  it("Public tracking shows safe statuses without leaking internal Windows errors", async () => {
    const rawDb = createTestDatabase();
    const d1 = asD1(rawDb);
    const customerRepo = new D1CustomerRepository(d1);
    const nowMs = 1_000_000;
    seedAgentAndPrinter(rawDb, nowMs);

    insertPaidOrder(rawDb, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", {
      status: "RETRY_PENDING",
      pickupCode: "PA-101",
      nowMs,
    });
    insertPaidOrder(rawDb, "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", {
      status: "PRINT_BLOCKED",
      pickupCode: "PA-102",
      nowMs,
    });
    insertPaidOrder(rawDb, "cccccccc-cccc-cccc-cccc-cccccccccccc", {
      status: "NEEDS_ADMIN",
      pickupCode: "PA-103",
      nowMs,
    });
    insertPaidOrder(rawDb, "dddddddd-dddd-dddd-dddd-dddddddddddd", {
      status: "COMPLETION_UNKNOWN",
      pickupCode: "PA-104",
      nowMs,
    });

    // Store raw internal errors in orders
    rawDb.exec(`
      UPDATE orders SET raw_error = 'Win32 Spooler Error 0x80070005 Access Denied' WHERE pickup_code = 'PA-101';
      UPDATE orders SET raw_error = 'PAPER_JAM in fuser roller 3' WHERE pickup_code = 'PA-102';
      UPDATE orders SET raw_error = 'PostScript syntax error /undefined in findfont' WHERE pickup_code = 'PA-103';
      UPDATE orders SET raw_error = 'Windows print daemon killed during spooling' WHERE pickup_code = 'PA-104';
    `);

    // 1. RETRY_PENDING -> Retrying
    const track1 = await customerRepo.findPublicTrackingByPickupCode(
      "PA-101",
      nowMs,
    );
    expect(track1?.status).toBe("RETRYING");
    expect(track1?.statusLabel).toBe("Retrying");
    expect(track1?.statusMessage).toBe(
      "The shop is resolving a print issue and retrying.",
    );
    expect(JSON.stringify(track1)).not.toContain("0x80070005");

    // 2. PRINT_BLOCKED -> Printer Issue
    const track2 = await customerRepo.findPublicTrackingByPickupCode(
      "PA-102",
      nowMs,
    );
    expect(track2?.status).toBe("PRINTER_ISSUE");
    expect(track2?.statusLabel).toBe("Printer Issue");
    expect(track2?.statusMessage).toContain("The printer needs attention.");
    expect(JSON.stringify(track2)).not.toContain("roller 3");

    // 3. NEEDS_ADMIN -> Waiting for Staff
    const track3 = await customerRepo.findPublicTrackingByPickupCode(
      "PA-103",
      nowMs,
    );
    expect(track3?.status).toBe("WAITING_FOR_STAFF");
    expect(track3?.statusLabel).toBe("Waiting for Staff");
    expect(JSON.stringify(track3)).not.toContain("PostScript");

    // 4. COMPLETION_UNKNOWN -> Waiting for Staff
    const track4 = await customerRepo.findPublicTrackingByPickupCode(
      "PA-104",
      nowMs,
    );
    expect(track4?.status).toBe("WAITING_FOR_STAFF");
    expect(track4?.statusLabel).toBe("Waiting for Staff");
    expect(JSON.stringify(track4)).not.toContain("daemon killed");
  });

  it("Domain toCustomerOrderStatus mappings for Phase 4 statuses", () => {
    expect(toCustomerOrderStatus("RETRY_PENDING").label).toBe(
      "Waiting to print",
    );
    expect(toCustomerOrderStatus("NEEDS_ADMIN").label).toBe(
      "Waiting for Staff",
    );
    expect(toCustomerOrderStatus("COMPLETION_UNKNOWN").label).toBe(
      "Waiting for Staff",
    );
    expect(toCustomerOrderStatus("MANUAL_PRINT").label).toBe(
      "Waiting for Staff",
    );
    expect(toCustomerOrderStatus("AWAITING_FINISHING").label).toBe("Finishing");
  });
});
