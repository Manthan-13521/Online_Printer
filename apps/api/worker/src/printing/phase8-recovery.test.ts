import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";

import { hashSessionToken } from "@printgo/auth";
import { D1PrintingRepository } from "./repository.js";
import { DevelopmentPrinterAdapter } from "../../../../agent/windows/src/printing/windows-printer-adapter.js";

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

const AGENT_ID = "80000000-0000-4000-8000-000000000001";
const AGENT_SECRET = "sec_test_secret_for_phase8_acceptance_test_8000";
const ADMIN_ID = "adm_test_admin_phase8";
const PRINTER_1_ID = "80000000-0000-4000-8000-000000000010";

describe("PRINTGO — PHASE 8 ACCEPTANCE TEST SUITE: SMART PRINT RECOVERY & QUEUE MANAGEMENT", () => {
  let db: DatabaseSync;
  let d1: D1Database;
  let metrics: QueryMetrics;
  let printingRepo: D1PrintingRepository;

  const initialNowMs = 1_700_000_000_000;
  let currentSimulatedTime = initialNowMs;

  beforeEach(async () => {
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
    printingRepo = new D1PrintingRepository(d1);

    const secretHash = await hashSessionToken(AGENT_SECRET);
    db.exec(`
      INSERT INTO installation (
        id, shop_name, contact_phone, address, customer_notice,
        online_printing_enabled, max_pdf_size_bytes, max_order_upload_bytes,
        identification_sheet_enabled, default_production_printer_id,
        created_at_ms, updated_at_ms
      ) VALUES (
        1, 'PrintGo Recovery Shop', '+919876543210', 'Recovery Station 1', 'Welcome',
        1, 26214400, 104857600,
        0, '${PRINTER_1_ID}',
        ${initialNowMs}, ${initialNowMs}
      );

      INSERT INTO agents (
        id, display_name, credential_hash, is_active, paired_at_ms,
        last_heartbeat_at_ms, created_at_ms, updated_at_ms
      ) VALUES (
        '${AGENT_ID}', 'Shop Recovery Agent', '${secretHash}', 1, ${initialNowMs},
        ${initialNowMs}, ${initialNowMs}, ${initialNowMs}
      );

      INSERT INTO printers (
        id, agent_id, display_name, windows_printer_name, enabled, status,
        status_reason, capabilities_json, is_production_eligible, is_virtual,
        priority, physical_device_id, last_status_at_ms, created_at_ms, updated_at_ms
      ) VALUES (
        '${PRINTER_1_ID}', '${AGENT_ID}', 'HP LaserJet Pro M404n', 'HP LaserJet Pro M404n',
        1, 'ONLINE', 'READY',
        '{"colour":false,"duplex":true,"paperSizes":["A4"]}',
        1, 0, 1, 'PHYSICAL_HP_M404',
        ${initialNowMs}, ${initialNowMs}, ${initialNowMs}
      );
    `);
  });

  function insertOrder(
    index: number,
    options: {
      status?: string;
      isPriority?: boolean;
      fileCount?: number;
      printerId?: string | null;
      physicalDeviceId?: string | null;
      updatedAtMs?: number;
      queuedAtMs?: number;
    } = {},
  ) {
    const orderId = crypto.randomUUID();
    const status = options.status ?? "QUEUED";
    const isPriority = options.isPriority ? 1 : 0;
    const updatedAt = options.updatedAtMs ?? currentSimulatedTime;
    const queuedAt = options.queuedAtMs ?? currentSimulatedTime + index * 1000;
    const createdAt = Math.min(queuedAt, updatedAt);
    const printerIdVal = options.printerId ? `'${options.printerId}'` : "NULL";
    const physDevVal = options.physicalDeviceId
      ? `'${options.physicalDeviceId}'`
      : "NULL";

    const needsClaim = [
      "CLAIMED",
      "SPOOLING",
      "PRINTING",
      "PRINT_BLOCKED",
      "PRINT_FAILED",
      "ADMIN_ACTION_REQUIRED",
      "PRINTED",
      "COMPLETION_UNKNOWN",
      "NEEDS_ADMIN",
    ].includes(status);
    const claimedByVal = needsClaim ? `'${AGENT_ID}'` : "NULL";
    const claimIdVal = needsClaim ? `'${crypto.randomUUID()}'` : "NULL";
    const claimExpiresVal = needsClaim ? updatedAt + 300_000 : "NULL";
    const claimedAtVal = needsClaim ? updatedAt : "NULL";

    db.exec(`
      INSERT INTO orders (
        id, customer_name, customer_phone, original_filename, printing_amount_paise,
        service_charge_paise, total_amount_paise, currency, status,
        is_priority, identification_required, selected_pages, copies, paper_size,
        color_mode, sides, public_job_code, pickup_code, printer_id, physical_device_id,
        claimed_by_agent_id, claim_id, claim_expires_at_ms, claimed_at_ms,
        cleanup_state, queued_at_ms, paid_at_ms, created_at_ms, updated_at_ms
      ) VALUES (
        '${orderId}', 'Customer ${index}', '+9198765432${String(index % 100).padStart(2, "0")}',
        'document.pdf', 500, 0, 500, 'INR', '${status}',
        ${isPriority}, 0, '1-2', 1, 'A4',
        'BW', 'SINGLE', 'JOB${String(index).padStart(3, "0")}', 'PK${String(index).padStart(2, "0")}',
        ${printerIdVal}, ${physDevVal},
        ${claimedByVal}, ${claimIdVal}, ${claimExpiresVal}, ${claimedAtVal},
        'ACTIVE', ${queuedAt}, ${createdAt}, ${createdAt}, ${updatedAt}
      );

      INSERT INTO payments (
        id, order_id, amount_paise, currency, status, provider,
        provider_order_id, provider_payment_id, verified_at_ms, created_at_ms, updated_at_ms
      ) VALUES (
        '${crypto.randomUUID()}', '${orderId}', 500, 'INR', 'PAID', 'RAZORPAY',
        'order_rzp_${index}_${Math.random()}', 'pay_rzp_${index}_${Math.random()}', ${createdAt}, ${createdAt}, ${createdAt}
      );
    `);

    const fileCount = options.fileCount ?? 1;
    let firstR2Key = "";
    for (let f = 1; f <= fileCount; f++) {
      const fileId = crypto.randomUUID();
      const r2Key = `uploads/${orderId}/${fileId}.pdf`;
      if (f === 1) firstR2Key = r2Key;
      db.exec(`
        INSERT INTO order_files (
          id, order_id, position, original_filename, size_bytes, expected_size_bytes, source_page_count,
          selected_pages, copies, paper_size, color_mode, sides, printing_amount_paise,
          service_charge_paise, r2_object_key, upload_status, print_status, uploaded_at_ms, created_at_ms, updated_at_ms
        ) VALUES (
          '${fileId}', '${orderId}', ${f}, 'document_${f}.pdf', 10240, 10240, 2,
          '1-2', 1, 'A4', 'BW', 'SINGLE', 500,
          0, '${r2Key}', 'UPLOADED', 'PENDING', ${createdAt}, ${createdAt}, ${createdAt}
        );
      `);
    }

    db.exec(`
      INSERT INTO uploads (
        id, order_id, r2_object_key, original_filename, storage_status, size_bytes, expected_size_bytes,
        created_at_ms, uploaded_at_ms, updated_at_ms
      ) VALUES (
        '${crypto.randomUUID()}', '${orderId}', '${firstR2Key}', 'primary.pdf', 'UPLOADED', 10240, 10240,
        ${createdAt}, ${createdAt}, ${createdAt}
      );
    `);

    return orderId;
  }

  it("Scenario 8.1: 25 Queued Orders — Printer Power Loss & Safe Recovery without losing orders or reprinting", async () => {
    // Insert 25 paid queued orders
    for (let i = 1; i <= 25; i++) {
      insertOrder(i, { status: "QUEUED" });
    }

    // Printer experiences power loss (offline)
    db.exec(`
      UPDATE printers
      SET status = 'OFFLINE', status_reason = 'POWER_OFF / UNREACHABLE'
      WHERE id = '${PRINTER_1_ID}'
    `);

    // Advance time by 6 minutes (360,000 ms)
    currentSimulatedTime += 6 * 60 * 1000;

    // Stall detection must identify genuine stall
    const stallDetails =
      await printingRepo.getQueueStallDetails(currentSimulatedTime);
    expect(stallDetails.isStalled).toBe(true);
    expect(stallDetails.waitingCount).toBe(25);
    expect(stallDetails.activeCount).toBe(0);
    expect(stallDetails.stalledDurationMs).toBeGreaterThanOrEqual(
      5 * 60 * 1000,
    );
    expect(stallDetails.printerIssue).toContain("OFFLINE");

    // Power restored: printer becomes ONLINE
    db.exec(`
      UPDATE printers
      SET status = 'ONLINE', status_reason = 'READY'
      WHERE id = '${PRINTER_1_ID}'
    `);

    // Admin executes Print Recovery
    const recoveryResult = await printingRepo.recoverQueue({
      adminId: ADMIN_ID,
      nowMs: currentSimulatedTime,
    });

    expect(recoveryResult.printerOnline).toBe(true);
    expect(recoveryResult.resumedOrdersCount).toBe(25);
    expect(recoveryResult.uncertainOrdersCount).toBe(0);

    // Agent heartbeats as it recovers
    db.exec(`
      UPDATE agents
      SET last_heartbeat_at_ms = ${currentSimulatedTime}
      WHERE id = '${AGENT_ID}'
    `);

    // Agent claims first job immediately
    const claimedJobs = await printingRepo.claimOrRenewAll(
      AGENT_ID,
      currentSimulatedTime,
    );
    expect(claimedJobs.length).toBe(1);
    expect(claimedJobs[0]?.jobCode).toBe("JOB001");

    // Verify all 25 orders remain safely preserved in DB
    const countRow = db
      .prepare(
        "SELECT COUNT(*) as c FROM orders WHERE cleanup_state = 'ACTIVE'",
      )
      .get() as { c: number };
    expect(countRow.c).toBe(25);
  });

  it("Scenario 8.2: Paper Jam During Printing — Quarantines in-flight job and unblocks remaining 20+ orders", async () => {
    // Order 1 is currently printing and had reached submission
    const order1Id = insertOrder(1, {
      status: "PRINTING",
      printerId: PRINTER_1_ID,
      physicalDeviceId: "PHYSICAL_HP_M404",
      updatedAtMs: currentSimulatedTime,
    });

    // Create print attempt step in SUBMISSION_STARTED for Order 1
    const att1Id = crypto.randomUUID();
    const step1Id = crypto.randomUUID();
    db.exec(`
      INSERT INTO print_attempts (
        id, order_id, agent_id, printer_id, attempt_number, status, created_at_ms, updated_at_ms
      ) VALUES (
        '${att1Id}', '${order1Id}', '${AGENT_ID}', '${PRINTER_1_ID}', 1, 'PRINTING',
        ${currentSimulatedTime}, ${currentSimulatedTime}
      );

      INSERT INTO print_attempt_steps (
        id, print_attempt_id, order_id, sequence_number, step_type, status, submission_started_at_ms, created_at_ms, updated_at_ms
      ) VALUES (
        '${step1Id}', '${att1Id}', '${order1Id}', 1, 'CUSTOMER_DOCUMENT', 'SUBMISSION_STARTED',
        ${currentSimulatedTime}, ${currentSimulatedTime}, ${currentSimulatedTime}
      );
    `);

    // Insert 20 waiting orders behind it
    for (let i = 2; i <= 21; i++) {
      insertOrder(i, { status: "QUEUED" });
    }

    // Printer experiences paper jam and halts
    db.exec(`
      UPDATE printers
      SET status = 'OFFLINE', status_reason = 'PAPER_JAM'
      WHERE id = '${PRINTER_1_ID}'
    `);

    // 5 minutes elapse without progress
    currentSimulatedTime += 5 * 60 * 1000 + 1000;

    const stall = await printingRepo.getQueueStallDetails(currentSimulatedTime);
    expect(stall.isStalled).toBe(true);
    expect(stall.activeCount).toBe(1);
    expect(stall.stalledOrderId).toBe(order1Id);

    // Operator fixes jam and restores printer to ONLINE
    db.exec(`
      UPDATE printers
      SET status = 'ONLINE', status_reason = 'READY'
      WHERE id = '${PRINTER_1_ID}'
    `);

    // Admin clicks Print Recovery
    const recovery = await printingRepo.recoverQueue({
      adminId: ADMIN_ID,
      nowMs: currentSimulatedTime,
    });

    // Order 1 was in submission, so it MUST NOT be auto-reprinted.
    // It is moved to ADMIN_ACTION_REQUIRED for physical operator verification.
    expect(recovery.uncertainOrdersCount).toBeGreaterThanOrEqual(1);

    const order1Row = db
      .prepare(
        "SELECT status, physical_device_id, recovery_reason FROM orders WHERE id = ?",
      )
      .get(order1Id) as {
      status: string;
      physical_device_id: string | null;
      recovery_reason: string | null;
    };
    expect(order1Row.status).toBe("ADMIN_ACTION_REQUIRED");
    // CRITICAL: physical_device_id MUST be cleared so subsequent orders are not blocked!
    expect(order1Row.physical_device_id).toBeNull();

    // CRITICAL: Verify automatic selective CLEAR_SPOOLER was dispatched so the
    // Windows spooler is cleared of the stuck in-flight job before Order 2 prints!
    const spoolCmd = db
      .prepare(
        "SELECT command_type, status, printer_id FROM agent_control_commands WHERE agent_id = ? ORDER BY created_at_ms DESC LIMIT 1",
      )
      .get(AGENT_ID) as
      { command_type: string; status: string; printer_id: string } | undefined;
    expect(spoolCmd).toBeDefined();
    expect(spoolCmd?.command_type).toBe("CLEAR_SPOOLER");
    expect(spoolCmd?.printer_id).toBe(PRINTER_1_ID);

    // Agent heartbeats
    db.exec(`
      UPDATE agents
      SET last_heartbeat_at_ms = ${currentSimulatedTime}
      WHERE id = '${AGENT_ID}'
    `);

    // CRITICAL SAFETY GATE: Verify waiting orders CANNOT claim the printer while CLEAR_SPOOLER is PENDING!
    const blockedClaim = await printingRepo.claimOrRenewAll(
      AGENT_ID,
      currentSimulatedTime,
    );
    expect(blockedClaim.length).toBe(0);

    // Agent receives command, clears Windows spooler, and reports SUCCEEDED
    db.exec(`
      UPDATE agent_control_commands
      SET status = 'SUCCEEDED', finished_at_ms = ${currentSimulatedTime}
      WHERE command_type = 'CLEAR_SPOOLER' AND agent_id = '${AGENT_ID}'
    `);

    // NOW subsequent waiting orders can claim the printer safely!
    const claimed = await printingRepo.claimOrRenewAll(
      AGENT_ID,
      currentSimulatedTime,
    );
    expect(claimed.length).toBe(1);
    expect(claimed[0]?.jobCode).toBe("JOB002"); // Order 2 claims safely after spooler is confirmed clean!
  });

  it("Scenario 8.3: USB Unplug & Reconnect — Safely reclaims pre-submission job back to QUEUED", async () => {
    // Order 1 was claimed but never reached printer submission (pre-submission error)
    const order1Id = insertOrder(1, {
      status: "CLAIMED",
      printerId: PRINTER_1_ID,
      physicalDeviceId: "PHYSICAL_HP_M404",
      updatedAtMs: currentSimulatedTime - 60_000,
    });

    // Attempt has no started steps
    const attPreId = crypto.randomUUID();
    db.exec(`
      INSERT INTO print_attempts (
        id, order_id, agent_id, printer_id, attempt_number, status, created_at_ms, updated_at_ms
      ) VALUES (
        '${attPreId}', '${order1Id}', '${AGENT_ID}', '${PRINTER_1_ID}', 1, 'CREATED',
        ${currentSimulatedTime}, ${currentSimulatedTime}
      );
    `);

    // Recover queue
    const result = await printingRepo.recoverQueue({
      adminId: ADMIN_ID,
      nowMs: currentSimulatedTime,
    });

    expect(result.recoveredOrdersCount).toBe(1);

    // Order 1 should be safely back in QUEUED
    const order1 = db
      .prepare("SELECT status, claim_id FROM orders WHERE id = ?")
      .get(order1Id) as { status: string; claim_id: string | null };
    expect(order1.status).toBe("QUEUED");
    expect(order1.claim_id).toBeNull();
  });

  it("Scenario 8.4: Agent Crash & Daemon Restart — Cleans up stale leases and resumes queue", async () => {
    const order1Id = insertOrder(1, {
      status: "CLAIMED",
      queuedAtMs: currentSimulatedTime - 350_000,
      updatedAtMs: currentSimulatedTime - 350_000,
    });
    insertOrder(2, { status: "QUEUED" });

    // Stale lease recovery
    await printingRepo.recoverQueue({
      adminId: ADMIN_ID,
      nowMs: currentSimulatedTime,
    });

    const order1 = db
      .prepare("SELECT status FROM orders WHERE id = ?")
      .get(order1Id) as { status: string };
    expect(order1.status).toBe("QUEUED");

    // Daemon restarts and heartbeats
    db.exec(`
      UPDATE agents
      SET last_heartbeat_at_ms = ${currentSimulatedTime}
      WHERE id = '${AGENT_ID}'
    `);

    // Daemon restarts and claims jobs
    const nextJobs = await printingRepo.claimOrRenewAll(
      AGENT_ID,
      currentSimulatedTime,
    );
    expect(nextJobs.length).toBe(1);
    expect(nextJobs[0]?.jobCode).toBe("JOB001");
  });

  it("Scenario 8.5: Legitimate Long Print Job vs Genuine 5-Minute Stall", async () => {
    const activeOrderId = insertOrder(1, {
      status: "PRINTING",
      queuedAtMs: currentSimulatedTime - 10 * 60 * 1000,
      updatedAtMs: currentSimulatedTime - 10_000, // Updated 10 seconds ago by active heartbeat
    });
    insertOrder(2, { status: "QUEUED" });

    // Active heartbeat within 5 minutes -> NOT stalled
    const activeStall =
      await printingRepo.getQueueStallDetails(currentSimulatedTime);
    expect(activeStall.isStalled).toBe(false);

    // Now simulate active job hanging with no updates for 5 minutes + 1s
    db.exec(`
      UPDATE orders
      SET updated_at_ms = ${currentSimulatedTime - (5 * 60 * 1000 + 1000)}
      WHERE id = '${activeOrderId}'
    `);

    const hangingStall =
      await printingRepo.getQueueStallDetails(currentSimulatedTime);
    expect(hangingStall.isStalled).toBe(true);
    expect(hangingStall.stalledOrderId).toBe(activeOrderId);
  });

  it("Scenario 8.6: Multi-File Partial Completion — File 1 completed, File 2 recovered without reprinting File 1", async () => {
    const multiOrderId = insertOrder(1, {
      fileCount: 2,
      status: "PRINT_BLOCKED",
    });

    // Mark File 1 as PRINTED
    db.exec(`
      UPDATE order_files
      SET print_status = 'PRINTED'
      WHERE order_id = '${multiOrderId}' AND position = 1;
    `);

    // Recovery runs
    await printingRepo.recoverQueue({
      adminId: ADMIN_ID,
      nowMs: currentSimulatedTime,
    });

    // When agent claims the order, it must pick File 2, NOT File 1
    const claimed = await printingRepo.claimOrRenewAll(
      AGENT_ID,
      currentSimulatedTime,
    );
    expect(claimed.length).toBe(1);
    expect(claimed[0]?.filePosition).toBe(2);
    expect(claimed[0]?.originalFilename).toBe("document_2.pdf");

    // Confirm File 1 is still PRINTED
    const file1 = db
      .prepare(
        "SELECT print_status FROM order_files WHERE order_id = ? AND position = 1",
      )
      .get(multiOrderId) as { print_status: string };
    expect(file1.print_status).toBe("PRINTED");
  });

  it("Scenario 8.7: Concurrent Recovery Calls — Idempotent and thread-safe", async () => {
    insertOrder(1, { status: "PRINT_BLOCKED" });
    insertOrder(2, { status: "QUEUED" });

    // Two rapid concurrent calls to recoverQueue
    const [res1, res2] = await Promise.all([
      printingRepo.recoverQueue({
        adminId: ADMIN_ID,
        nowMs: currentSimulatedTime,
      }),
      printingRepo.recoverQueue({
        adminId: ADMIN_ID,
        nowMs: currentSimulatedTime,
      }),
    ]);

    expect(res1.resumedOrdersCount).toBe(2);
    expect(res2.resumedOrdersCount).toBe(2);

    const activeOrders = db
      .prepare("SELECT status FROM orders WHERE status = 'QUEUED'")
      .all();
    expect(activeOrders.length).toBe(2);
  });

  it("Scenario 8.8: Selective Spooler Clear — Agent clears PrintGo jobs only, preserving unrelated jobs & D1/R2", async () => {
    const adapter = new DevelopmentPrinterAdapter();

    // Submit a PrintGo job and a simulated non-PrintGo document
    await adapter.submitPdfJob({
      printerId: "Shop LaserJet Pro M404dn",
      localPdfPath: "/tmp/printgo-test.pdf",
      documentTitle: "printgo-ord_001",
      copies: 1,
      settings: {
        printerName: "Shop LaserJet Pro M404dn",
        copies: 1,
        paperSize: "A4",
        colorMode: "BLACK_AND_WHITE",
        sides: "ONE_SIDED",
      },
    });

    await adapter.submitPdfJob({
      printerId: "Shop LaserJet Pro M404dn",
      localPdfPath: "/tmp/other-doc.pdf",
      documentTitle: "ThirdPartyInvoice.pdf", // NOT a PrintGo title!
      copies: 1,
      settings: {
        printerName: "Shop LaserJet Pro M404dn",
        copies: 1,
        paperSize: "A4",
        colorMode: "BLACK_AND_WHITE",
        sides: "ONE_SIDED",
      },
    });

    // Clear PrintGo spool jobs
    const clearResult = await adapter.clearPrintGoSpoolJobs(
      "Shop LaserJet Pro M404dn",
    );
    expect(clearResult.cancelledJobIds.length).toBe(1);

    // Dispatch clear spooler command on worker
    const commandResult = await printingRepo.createClearSpoolerCommand({
      printerId: PRINTER_1_ID,
      adminId: ADMIN_ID,
      nowMs: currentSimulatedTime,
    });
    expect(commandResult.status).toBe("PENDING");
    expect(commandResult.windowsPrinterName).toBe("HP LaserJet Pro M404n");

    // Verify command exists in agent_control_commands
    const commandRow = db
      .prepare(
        "SELECT status, command_type FROM agent_control_commands WHERE id = ?",
      )
      .get(commandResult.commandId) as { status: string; command_type: string };
    expect(commandRow.status).toBe("PENDING");
    expect(commandRow.command_type).toBe("CLEAR_SPOOLER");
  });

  it("Scenario 8.9: Top Stat Cards & UI Stagnation Detection State", async () => {
    // 3 queued, 1 printing, 2 needs review, 1 stuck >= 5m
    insertOrder(1, { status: "QUEUED", queuedAtMs: currentSimulatedTime });
    insertOrder(2, { status: "QUEUED", queuedAtMs: currentSimulatedTime });
    insertOrder(3, { status: "QUEUED", queuedAtMs: currentSimulatedTime });
    insertOrder(4, { status: "PRINTING", updatedAtMs: currentSimulatedTime });
    insertOrder(5, {
      status: "ADMIN_ACTION_REQUIRED",
      updatedAtMs: currentSimulatedTime - 400_000,
    });
    insertOrder(6, {
      status: "PRINT_BLOCKED",
      updatedAtMs: currentSimulatedTime,
    });

    const stats = await printingRepo.getQueueStallDetails(currentSimulatedTime);
    expect(stats.waitingCount).toBe(3);
    expect(stats.activeCount).toBe(1);
    expect(stats.needsReviewCount).toBe(2);
  });

  it("Scenario 8.10: Spooler Clear Failure (FAILED) Permanently Gates Printer Until Admin Retries", async () => {
    // 5 queued orders waiting
    for (let i = 1; i <= 5; i++) {
      insertOrder(i, { status: "QUEUED" });
    }

    // Admin or recovery issues CLEAR_SPOOLER command
    const cmd = await printingRepo.createClearSpoolerCommand({
      printerId: PRINTER_1_ID,
      adminId: ADMIN_ID,
      nowMs: currentSimulatedTime,
    });
    expect(cmd.status).toBe("PENDING");

    // Agent heartbeats
    db.exec(`
      UPDATE agents
      SET last_heartbeat_at_ms = ${currentSimulatedTime}
      WHERE id = '${AGENT_ID}'
    `);

    // While pending, printer is gated (0 jobs claimed)
    const claimedWhilePending = await printingRepo.claimOrRenewAll(
      AGENT_ID,
      currentSimulatedTime,
    );
    expect(claimedWhilePending.length).toBe(0);

    // Agent attempts spooler clear but Windows Spooler reports Access Denied / Error
    db.exec(`
      UPDATE agent_control_commands
      SET status = 'FAILED', failure_detail = 'Access Denied: Spooler lock contention', finished_at_ms = ${currentSimulatedTime}
      WHERE id = '${cmd.commandId}'
    `);

    // CRITICAL: Printer MUST REMAIN GATED even after time elapses!
    currentSimulatedTime += 10_000;
    const claimedAfterFailure = await printingRepo.claimOrRenewAll(
      AGENT_ID,
      currentSimulatedTime,
    );
    expect(claimedAfterFailure.length).toBe(0);

    // Admin retries recovery / clear spooler
    const retryCmd = await printingRepo.createClearSpoolerCommand({
      printerId: PRINTER_1_ID,
      adminId: ADMIN_ID,
      nowMs: currentSimulatedTime,
    });
    expect(retryCmd.status).toBe("PENDING");

    // Previous failed command was expired, new command is pending
    const oldCmdStatus = db
      .prepare("SELECT status FROM agent_control_commands WHERE id = ?")
      .get(cmd.commandId) as { status: string };
    expect(oldCmdStatus.status).toBe("EXPIRED");

    // Agent clears spooler successfully on retry
    db.exec(`
      UPDATE agent_control_commands
      SET status = 'SUCCEEDED', finished_at_ms = ${currentSimulatedTime}
      WHERE id = '${retryCmd.commandId}'
    `);

    // Queue resumes safely
    const claimedAfterSuccess = await printingRepo.claimOrRenewAll(
      AGENT_ID,
      currentSimulatedTime,
    );
    expect(claimedAfterSuccess.length).toBe(1);
    expect(claimedAfterSuccess[0]?.jobCode).toBe("JOB001");
  });

  it("Scenario 8.11: Agent Disconnect & Delayed Heartbeat — Printer Gated Until Succeeded", async () => {
    insertOrder(1, { status: "QUEUED" });
    insertOrder(2, { status: "QUEUED" });

    // CLEAR_SPOOLER command is created
    const cmd = await printingRepo.createClearSpoolerCommand({
      printerId: PRINTER_1_ID,
      adminId: ADMIN_ID,
      nowMs: currentSimulatedTime,
    });

    // Time passes without agent heartbeating (agent disconnected > 90s timeout)
    currentSimulatedTime += 120_000;

    // Printer cannot claim while agent is offline
    const claimedOffline = await printingRepo.claimOrRenewAll(
      AGENT_ID,
      currentSimulatedTime,
    );
    expect(claimedOffline.length).toBe(0);

    // Agent reconnects after 30 seconds
    currentSimulatedTime += 30_000;
    db.exec(`
      UPDATE agents
      SET last_heartbeat_at_ms = ${currentSimulatedTime}
      WHERE id = '${AGENT_ID}'
    `);

    // Printer still gated because CLEAR_SPOOLER is still PENDING!
    const claimedReconnected = await printingRepo.claimOrRenewAll(
      AGENT_ID,
      currentSimulatedTime,
    );
    expect(claimedReconnected.length).toBe(0);

    // Agent executes and reports SUCCEEDED
    db.exec(`
      UPDATE agent_control_commands
      SET status = 'SUCCEEDED', finished_at_ms = ${currentSimulatedTime}
      WHERE id = '${cmd.commandId}'
    `);

    // Now prints resume safely
    const claimedAfterReport = await printingRepo.claimOrRenewAll(
      AGENT_ID,
      currentSimulatedTime,
    );
    expect(claimedAfterReport.length).toBe(1);
    expect(claimedAfterReport[0]?.jobCode).toBe("JOB001");
  });

  it("Scenario 8.12: Concurrent Recovery Invocations — Idempotent and Thread-Safe", async () => {
    // Order in PRINTING
    const stalledOrder = insertOrder(1, {
      status: "PRINTING",
      printerId: PRINTER_1_ID,
      physicalDeviceId: "PHYSICAL_HP_M404",
      updatedAtMs: currentSimulatedTime - 360_000,
    });

    // Attempt has submitted step
    const attId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    db.exec(`
      INSERT INTO print_attempts (
        id, order_id, agent_id, printer_id, attempt_number, status, created_at_ms, updated_at_ms
      ) VALUES (
        '${attId}', '${stalledOrder}', '${AGENT_ID}', '${PRINTER_1_ID}', 1, 'PRINTING',
        ${currentSimulatedTime}, ${currentSimulatedTime}
      );
      INSERT INTO print_attempt_steps (
        id, print_attempt_id, order_id, sequence_number, step_type, status, submission_started_at_ms, created_at_ms, updated_at_ms
      ) VALUES (
        '${stepId}', '${attId}', '${stalledOrder}', 1, 'CUSTOMER_DOCUMENT', 'SUBMISSION_STARTED',
        ${currentSimulatedTime}, ${currentSimulatedTime}, ${currentSimulatedTime}
      );
    `);

    // Two admin operators click Print Recovery concurrently
    const [rec1, rec2] = await Promise.all([
      printingRepo.recoverQueue({
        adminId: ADMIN_ID,
        nowMs: currentSimulatedTime,
      }),
      printingRepo.recoverQueue({
        adminId: ADMIN_ID,
        nowMs: currentSimulatedTime,
      }),
    ]);

    // Both succeed without crash or double-quarantine
    expect(rec1.printerOnline).toBe(true);
    expect(rec2.printerOnline).toBe(true);

    const orderRow = db
      .prepare("SELECT status, physical_device_id FROM orders WHERE id = ?")
      .get(stalledOrder) as {
      status: string;
      physical_device_id: string | null;
    };
    expect(orderRow.status).toBe("ADMIN_ACTION_REQUIRED");
    expect(orderRow.physical_device_id).toBeNull();
  });

  it("Scenario 8.13: Disabled printer or inactive agent printer is 100% ignored in stall detector and live orders", async () => {
    // Insert disabled printer on active agent (e.g. Xprinter XP-TT426B)
    const disabledPrinterId = crypto.randomUUID();
    db.exec(`
      INSERT INTO printers (
        id, agent_id, display_name, windows_printer_name, enabled, status,
        status_reason, capabilities_json, is_production_eligible, is_virtual,
        priority, physical_device_id, last_status_at_ms, created_at_ms, updated_at_ms
      ) VALUES (
        '${disabledPrinterId}', '${AGENT_ID}', 'Xprinter XP-TT426B', 'Xprinter XP-TT426B',
        0, 'OFFLINE', 'Printer is set to work offline',
        '{"colour":false,"duplex":false,"paperSizes":["A4"]}',
        1, 0, 2, 'PHYSICAL_XPRINTER',
        ${currentSimulatedTime}, ${currentSimulatedTime}, ${currentSimulatedTime}
      );
    `);

    // Insert an orphaned printer from an inactive agent with enabled = 1
    const inactiveAgentId = crypto.randomUUID();
    const orphanedPrinterId = crypto.randomUUID();
    db.exec(`
      INSERT INTO agents (
        id, display_name, credential_hash, is_active, paired_at_ms,
        last_heartbeat_at_ms, created_at_ms, updated_at_ms
      ) VALUES (
        '${inactiveAgentId}', 'Revoked Agent', 'dummy_hash', 0, ${currentSimulatedTime},
        ${currentSimulatedTime}, ${currentSimulatedTime}, ${currentSimulatedTime}
      );
      INSERT INTO printers (
        id, agent_id, display_name, windows_printer_name, enabled, status,
        status_reason, capabilities_json, is_production_eligible, is_virtual,
        priority, physical_device_id, last_status_at_ms, created_at_ms, updated_at_ms
      ) VALUES (
        '${orphanedPrinterId}', '${inactiveAgentId}', 'Old Xprinter', 'Old Xprinter',
        1, 'OFFLINE', 'Printer is offline',
        '{"colour":false,"duplex":false,"paperSizes":["A4"]}',
        1, 0, 2, 'PHYSICAL_OLD_XPRINTER',
        ${currentSimulatedTime}, ${currentSimulatedTime}, ${currentSimulatedTime}
      );
    `);

    const stallDetails =
      await printingRepo.getQueueStallDetails(currentSimulatedTime);
    // Disabled printer and orphaned printer MUST NOT pollute printerIssue banner
    expect(stallDetails.printerIssue).toBeNull();
  });

  it("Scenario 8.14: Capability Starvation — Duplex order on simplex-only printer is detected by stall detector and recovered to Needs Review", async () => {
    // Reconfigure active printer to simplex-only (duplex = false)
    db.exec(`
      UPDATE printers
      SET capabilities_json = '{"colour":false,"duplex":false,"paperSizes":["A4"]}',
          verified_capabilities_json = '{"verified":{"bw":true,"color":false,"duplex":false,"a4":true,"a3":false}}',
          enabled_services_json = '{"bw":true,"color":false,"duplex":false,"a4":true,"a3":false}'
      WHERE id = '${PRINTER_1_ID}';
    `);

    // Insert order with sides = DOUBLE
    const duplexOrderId = insertOrder(10, {
      status: "QUEUED",
      queuedAtMs: currentSimulatedTime - 360_000,
    });
    db.exec(`
      UPDATE order_files SET sides = 'DOUBLE' WHERE order_id = '${duplexOrderId}';
    `);

    // Insert subsequent single-sided order
    const nextOrderId = insertOrder(11, {
      status: "QUEUED",
      queuedAtMs: currentSimulatedTime - 300_000,
    });

    // Verify stall detector detects capability starvation
    const stall = await printingRepo.getQueueStallDetails(currentSimulatedTime);
    expect(stall.isStalled).toBe(true);
    expect(stall.reason).toContain("Double-sided (Duplex) printing");

    // Recover queue
    const rec = await printingRepo.recoverQueue({
      adminId: ADMIN_ID,
      nowMs: currentSimulatedTime,
    });
    expect(rec.uncertainOrdersCount).toBeGreaterThanOrEqual(1);
    expect(
      rec.details.some(
        (d) => d.includes("Needs Review") && d.includes("Duplex"),
      ),
    ).toBe(true);

    // Verify duplex order moved to ADMIN_ACTION_REQUIRED
    const duplexRow = db
      .prepare("SELECT status, error_category FROM orders WHERE id = ?")
      .get(duplexOrderId) as { status: string; error_category: string };
    expect(duplexRow.status).toBe("ADMIN_ACTION_REQUIRED");
    expect(duplexRow.error_category).toBe("PRINTER_CAPABILITY_UNSUPPORTED");

    // Verify subsequent single-sided order is claimed and unblocked!
    const claimed = await printingRepo.claimOrRenewAll(
      AGENT_ID,
      currentSimulatedTime,
    );
    expect(claimed.length).toBe(1);
    expect(claimed[0]?.orderId).toBe(nextOrderId);
  });

  it("Scenario 8.15: Convert Order to Single-Sided — Unblocks capability-starved order and prints on simplex printer", async () => {
    // Start with order in ADMIN_ACTION_REQUIRED with duplex requirement
    const orderId = insertOrder(20, { status: "ADMIN_ACTION_REQUIRED" });
    db.exec(`
      UPDATE order_files SET sides = 'DOUBLE' WHERE order_id = '${orderId}';
      UPDATE orders SET error_category = 'PRINTER_CAPABILITY_UNSUPPORTED' WHERE id = '${orderId}';
    `);

    // Admin converts to single-sided
    const result = await printingRepo.convertOrderToSingleSided({
      orderId,
      adminId: ADMIN_ID,
      nowMs: currentSimulatedTime,
    });
    expect(result.status).toBe("QUEUED");

    // Verify order_files has sides = SINGLE
    const fileRow = db
      .prepare("SELECT sides FROM order_files WHERE order_id = ?")
      .get(orderId) as { sides: string };
    expect(fileRow.sides).toBe("SINGLE");

    const orderRow = db
      .prepare("SELECT status, error_category FROM orders WHERE id = ?")
      .get(orderId) as { status: string; error_category: string | null };
    expect(orderRow.status).toBe("QUEUED");
    expect(orderRow.error_category).toBeNull();

    // Verify printer can now claim it
    const claimed = await printingRepo.claimOrRenewAll(
      AGENT_ID,
      currentSimulatedTime,
    );
    expect(claimed.length).toBe(1);
    expect(claimed[0]?.orderId).toBe(orderId);
  });

  it("Scenario 8.16: UNKNOWN printer readiness — Print Recovery returns honest message with hardware probe dispatched", async () => {
    // Set printer to UNKNOWN
    db.exec(`
      UPDATE printers
      SET status = 'UNKNOWN',
          status_reason = 'Printer readiness is not reported by Windows',
          updated_at_ms = ${currentSimulatedTime}
      WHERE id = '${PRINTER_1_ID}';
    `);

    insertOrder(1, { status: "QUEUED" });

    const recovery = await printingRepo.recoverQueue({
      adminId: ADMIN_ID,
      nowMs: currentSimulatedTime,
    });

    expect(recovery.printerOnline).toBe(false);
    expect(recovery.message).toContain("UNKNOWN");
    expect(recovery.message).toContain("Dispatched hardware probe to Agent");
    expect(recovery.details).toContainEqual(
      expect.stringContaining("Dispatched hardware probe to Windows Agent"),
    );

    // Verify claimOrRenewAll fails closed while printer is UNKNOWN
    const claimed = await printingRepo.claimOrRenewAll(
      AGENT_ID,
      currentSimulatedTime,
    );
    expect(claimed.length).toBe(0);
  });

  it("Scenario 8.17: Incompatible disabled thermal printer is never chosen as fallback for A4 order", async () => {
    // Primary HP printer is UNKNOWN
    db.exec(`
      UPDATE printers
      SET status = 'UNKNOWN',
          updated_at_ms = ${currentSimulatedTime}
      WHERE id = '${PRINTER_1_ID}';
    `);

    // Secondary printer is a disabled thermal label printer (no A4 support)
    const thermalPrinterId = crypto.randomUUID();
    db.exec(`
      INSERT INTO printers (
        id, agent_id, display_name, windows_printer_name, enabled, status,
        capabilities_json, is_production_eligible, is_virtual, port_name,
        created_at_ms, updated_at_ms
      ) VALUES (
        '${thermalPrinterId}', '${AGENT_ID}', 'Xprinter XP-TT426B', 'Xprinter XP-TT426B',
        0, 'ONLINE', '{"colour":false,"duplex":false,"paperSizes":["CUSTOM"]}',
        1, 0, 'USB001', ${currentSimulatedTime}, ${currentSimulatedTime}
      );
    `);

    const orderId = insertOrder(1, { status: "QUEUED" });

    // Claim should reject thermal printer because it's disabled and lacks A4
    const claimed = await printingRepo.claimOrRenewAll(
      AGENT_ID,
      currentSimulatedTime,
    );
    expect(claimed.length).toBe(0);

    // When primary HP printer recovers to ONLINE, order is immediately claimed!
    db.exec(`
      UPDATE printers
      SET status = 'ONLINE',
          status_reason = NULL,
          updated_at_ms = ${currentSimulatedTime}
      WHERE id = '${PRINTER_1_ID}';
    `);

    const claimedAfterRecovery = await printingRepo.claimOrRenewAll(
      AGENT_ID,
      currentSimulatedTime,
    );
    expect(claimedAfterRecovery.length).toBe(1);
    expect(claimedAfterRecovery[0]?.orderId).toBe(orderId);
    expect(claimedAfterRecovery[0]?.printerId).toBe(PRINTER_1_ID);
  });
});
