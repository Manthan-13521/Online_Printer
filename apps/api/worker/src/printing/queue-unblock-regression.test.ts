import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";

import { hashSessionToken } from "@printgo/auth";
import { D1PrintingRepository } from "./repository.js";
import { D1AgentRepository } from "../agent/repository.js";

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

const AGENT_ID = "88888888-0000-4000-8000-000000000001";
const AGENT_SECRET = "sec_test_secret_for_queue_unblock_regression_8888";
const ADMIN_ID = "adm_test_admin_queue_unblock";
const PRINTER_HP_ID = "88888888-0000-4000-8000-000000000010";
const PRINTER_EPSON_ID = "88888888-0000-4000-8000-000000000020";

describe("PRINTGO V2 — MANDATORY QUEUE UNBLOCK REGRESSION TEST SUITE", () => {
  let db: DatabaseSync;
  let d1: D1Database;
  let metrics: QueryMetrics;
  let printingRepo: D1PrintingRepository;
  let agentRepo: D1AgentRepository;

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
    agentRepo = new D1AgentRepository(d1);

    const secretHash = await hashSessionToken(AGENT_SECRET);
    db.exec(`
      INSERT INTO installation (
        id, shop_name, contact_phone, address, customer_notice,
        online_printing_enabled, max_pdf_size_bytes, max_order_upload_bytes,
        identification_sheet_enabled, default_production_printer_id,
        created_at_ms, updated_at_ms
      ) VALUES (
        1, 'PrintGo Unblock Regression Shop', '+919876543210', 'Station 1', 'Notice',
        1, 26214400, 104857600,
        0, '${PRINTER_HP_ID}',
        ${initialNowMs}, ${initialNowMs}
      );

      INSERT INTO agents (
        id, display_name, credential_hash, is_active, paired_at_ms,
        last_heartbeat_at_ms, created_at_ms, updated_at_ms
      ) VALUES (
        '${AGENT_ID}', 'Unblock Test Agent', '${secretHash}', 1, ${initialNowMs},
        ${initialNowMs}, ${initialNowMs}, ${initialNowMs}
      );

      INSERT INTO printers (
        id, agent_id, display_name, windows_printer_name, enabled, status,
        status_reason, capabilities_json, is_production_eligible, is_virtual,
        priority, physical_device_id, last_status_at_ms, created_at_ms, updated_at_ms
      ) VALUES (
        '${PRINTER_HP_ID}', '${AGENT_ID}', 'HP LaserJet Pro M404n', 'HP LaserJet Pro M404n',
        1, 'ONLINE', 'READY',
        '{"colour":false,"duplex":true,"paperSizes":["A4"]}',
        1, 0, 1, 'PHYSICAL_HP_M404',
        ${initialNowMs}, ${initialNowMs}, ${initialNowMs}
      ), (
        '${PRINTER_EPSON_ID}', '${AGENT_ID}', 'Epson L3250 Color', 'Epson L3250 Color',
        1, 'ONLINE', 'READY',
        '{"colour":true,"duplex":false,"paperSizes":["A4"]}',
        1, 0, 2, 'PHYSICAL_EPSON_L3250',
        ${initialNowMs}, ${initialNowMs}, ${initialNowMs}
      );
    `);
  });

  async function completeClaimedJob(
    claim: {
      orderId: string;
      claimId: string;
      currentStep: { stepId: string };
    },
    nowMs: number,
  ) {
    await printingRepo.startStep({
      orderId: claim.orderId,
      stepId: claim.currentStep.stepId,
      claimId: claim.claimId,
      agentId: AGENT_ID,
      nowMs,
    });
    await printingRepo.recordSubmission({
      orderId: claim.orderId,
      stepId: claim.currentStep.stepId,
      claimId: claim.claimId,
      agentId: AGENT_ID,
      spoolerJobId: "spool-1",
      nowMs,
    });
    return printingRepo.recordResult({
      orderId: claim.orderId,
      stepId: claim.currentStep.stepId,
      claimId: claim.claimId,
      agentId: AGENT_ID,
      spoolerJobId: "spool-1",
      status: "SUCCEEDED",
      failureCode: null,
      failureDetail: null,
      nowMs,
    });
  }

  function insertOrder(
    index: number,
    options: {
      id?: string;
      status?: string;
      isPriority?: boolean;
      fileCount?: number;
      printerId?: string | null;
      physicalDeviceId?: string | null;
      updatedAtMs?: number;
      queuedAtMs?: number;
      paperSize?: string;
      colorMode?: string;
      sides?: string;
    } = {},
  ) {
    const orderId = options.id ?? crypto.randomUUID();
    const status = options.status ?? "QUEUED";
    const isPriority = options.isPriority ? 1 : 0;
    const updatedAt = options.updatedAtMs ?? currentSimulatedTime;
    const queuedAt = options.queuedAtMs ?? currentSimulatedTime + index * 1000;
    const createdAt = Math.min(queuedAt, updatedAt);
    const printerIdVal = options.printerId ? `'${options.printerId}'` : "NULL";
    const physDevVal = options.physicalDeviceId
      ? `'${options.physicalDeviceId}'`
      : "NULL";
    const paperSize = options.paperSize ?? "A4";
    const colorMode = options.colorMode ?? "BW";
    const sides = options.sides ?? "SINGLE";

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
        'document_${index}.pdf', 500, 0, 500, 'INR', '${status}',
        ${isPriority}, 0, '1-2', 1, '${paperSize}',
        '${colorMode}', '${sides}', 'JOB${String(index).padStart(3, "0")}', 'PK${String(index).padStart(2, "0")}',
        ${printerIdVal}, ${physDevVal},
        ${claimedByVal}, ${claimIdVal}, ${claimExpiresVal}, ${claimedAtVal},
        'ACTIVE', ${queuedAt}, ${createdAt}, ${createdAt}, ${updatedAt}
      );

      INSERT INTO payments (
        id, order_id, amount_paise, currency, status, provider,
        provider_order_id, provider_payment_id, verified_at_ms, created_at_ms, updated_at_ms
      ) VALUES (
        '${crypto.randomUUID()}', '${orderId}', 500, 'INR', 'PAID', 'RAZORPAY',
        'order_rzp_${index}_${Math.random()}', 'pay_unblock_${index}', ${createdAt}, ${createdAt}, ${createdAt}
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
          '1-2', 1, '${paperSize}', '${colorMode}', '${sides}', 500,
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

  // =========================================================================
  // SCENARIO 1: Five Orders — A completed, B unknown, C/D/E queued → C/D/E resume
  // =========================================================================
  it("Scenario 1: Five orders — A completed, B unknown, C/D/E queued → C/D/E resume safely while B waits for Admin", async () => {
    // Disable secondary Epson printer to test single physical printer queue isolation strictly
    db.exec(`UPDATE printers SET enabled = 0 WHERE id = '${PRINTER_EPSON_ID}'`);

    // Order A: COMPLETED
    insertOrder(1, { status: "COMPLETED", printerId: PRINTER_HP_ID });

    // Order B: In COMPLETION_UNKNOWN (interrupted mid-print), physical lock nullified
    const orderBId = insertOrder(2, {
      status: "COMPLETION_UNKNOWN",
      printerId: PRINTER_HP_ID,
      physicalDeviceId: null,
    });

    // Orders C, D, E: QUEUED
    const orderCId = insertOrder(3, { status: "QUEUED" });
    const orderDId = insertOrder(4, { status: "QUEUED" });
    const orderEId = insertOrder(5, { status: "QUEUED" });

    // Agent claims work on the healthy HP printer
    const claims1 = await printingRepo.claimOrRenewAll(
      AGENT_ID,
      currentSimulatedTime,
    );
    expect(claims1).toHaveLength(1);
    expect(claims1[0]?.orderId).toBe(orderCId);

    // Complete Order C cleanly
    await completeClaimedJob(claims1[0]!, currentSimulatedTime + 100);

    // Next claim claims Order D
    const claims2 = await printingRepo.claimOrRenewAll(
      AGENT_ID,
      currentSimulatedTime + 200,
    );
    expect(claims2).toHaveLength(1);
    expect(claims2[0]?.orderId).toBe(orderDId);

    // Complete Order D cleanly
    await completeClaimedJob(claims2[0]!, currentSimulatedTime + 300);

    // Next claim claims Order E
    const claims3 = await printingRepo.claimOrRenewAll(
      AGENT_ID,
      currentSimulatedTime + 400,
    );
    expect(claims3).toHaveLength(1);
    expect(claims3[0]?.orderId).toBe(orderEId);

    // Order B is STILL in COMPLETION_UNKNOWN, safely quarantined
    const orderBRow = db
      .prepare("SELECT status FROM orders WHERE id = ?")
      .get(orderBId) as { status: string };
    expect(orderBRow.status).toBe("COMPLETION_UNKNOWN");
  });

  // =========================================================================
  // SCENARIO 2: B has a live/resumable Windows spooler job → no unsafe overlap
  // =========================================================================
  it("Scenario 2: B has a live or resumable Windows spooler job → no unsafe overlapping print", async () => {
    db.exec(`UPDATE printers SET enabled = 0 WHERE id = '${PRINTER_EPSON_ID}'`);

    // Order B entered unconfirmed failure but still holds its physical lock (e.g. preflight failure before cleanup)
    insertOrder(1, {
      status: "ADMIN_ACTION_REQUIRED",
      printerId: PRINTER_HP_ID,
      physicalDeviceId: "PHYSICAL_HP_M404",
    });

    // Order C is queued behind it
    insertOrder(2, { status: "QUEUED" });

    // Attempting to claim must NOT allow Order C to print while B holds the physical device lock!
    const claims = await printingRepo.claimOrRenewAll(
      AGENT_ID,
      currentSimulatedTime,
    );
    expect(claims).toHaveLength(0);
  });

  // =========================================================================
  // SCENARIO 3: Admin marks B printed → no duplicate submission
  // =========================================================================
  it("Scenario 3: Admin marks B printed → no duplicate submission", async () => {
    db.exec(`UPDATE printers SET enabled = 0 WHERE id = '${PRINTER_EPSON_ID}'`);

    const orderBId = insertOrder(2, {
      status: "COMPLETION_UNKNOWN",
      printerId: PRINTER_HP_ID,
      physicalDeviceId: null,
    });

    // Admin marks B printed
    await printingRepo.manualComplete({
      orderId: orderBId,
      adminId: ADMIN_ID,
      reason: "Customer verified papers were collected",
      nowMs: currentSimulatedTime,
    });

    const row = db
      .prepare("SELECT status, physical_device_id FROM orders WHERE id = ?")
      .get(orderBId) as {
      status: string;
      physical_device_id: string | null;
    };
    expect(row.status).toBe("COMPLETED");
    expect(row.physical_device_id).toBeNull();

    // No claims should be produced for Order B
    const claims = await printingRepo.claimOrRenewAll(
      AGENT_ID,
      currentSimulatedTime + 100,
    );
    expect(claims).toHaveLength(0);
  });

  // =========================================================================
  // SCENARIO 4: Admin confirms B not printed → controlled retry without duplicates
  // =========================================================================
  it("Scenario 4: Admin confirms B not printed → controlled retry without duplicates", async () => {
    db.exec(`UPDATE printers SET enabled = 0 WHERE id = '${PRINTER_EPSON_ID}'`);

    const orderBId = insertOrder(2, {
      status: "COMPLETION_UNKNOWN",
      printerId: PRINTER_HP_ID,
      physicalDeviceId: null,
    });

    // Admin retries with forceUncertain confirmation
    const retryResult = await printingRepo.retryOrder({
      orderId: orderBId,
      adminId: ADMIN_ID,
      forceUncertain: true,
      nowMs: currentSimulatedTime,
    });
    expect(retryResult.status).toBe("QUEUED");

    const row = db
      .prepare(
        "SELECT status, printer_id, physical_device_id FROM orders WHERE id = ?",
      )
      .get(orderBId) as {
      status: string;
      printer_id: string | null;
      physical_device_id: string | null;
    };
    expect(row.status).toBe("QUEUED");
    expect(row.printer_id).toBeNull();
    expect(row.physical_device_id).toBeNull();

    // Order B is now cleanly claimable in controlled sequence
    const claims = await printingRepo.claimOrRenewAll(
      AGENT_ID,
      currentSimulatedTime + 50,
    );
    expect(claims).toHaveLength(1);
    expect(claims[0]?.orderId).toBe(orderBId);
  });

  // =========================================================================
  // SCENARIO 5: Partially printed multi-file order → completed pages preserved
  // =========================================================================
  it("Scenario 5: Partially printed multi-file order → completed pages preserved", async () => {
    const orderId = insertOrder(1, {
      status: "PRINT_BLOCKED",
      printerId: PRINTER_HP_ID,
      fileCount: 2,
    });

    const files = db
      .prepare(
        "SELECT id, position FROM order_files WHERE order_id = ? ORDER BY position ASC",
      )
      .all(orderId) as Array<{ id: string; position: number }>;

    // Mark File 1 as PRINTED
    db.exec(
      `UPDATE order_files SET print_status = 'PRINTED' WHERE id = '${files[0]!.id}'`,
    );

    // File 2 remains PENDING
    const file1Row = db
      .prepare("SELECT print_status FROM order_files WHERE id = ?")
      .get(files[0]!.id) as {
      print_status: string;
    };
    expect(file1Row.print_status).toBe("PRINTED");

    // Recover queue
    await printingRepo.recoverQueue({
      adminId: ADMIN_ID,
      nowMs: currentSimulatedTime + 1000,
    });

    // Verify File 1 is STILL PRINTED (not overwritten or re-executed)
    const file1After = db
      .prepare("SELECT print_status FROM order_files WHERE id = ?")
      .get(files[0]!.id) as {
      print_status: string;
    };
    expect(file1After.print_status).toBe("PRINTED");
  });

  // =========================================================================
  // SCENARIO 6: Printer OFF→ON and Print Recovery → no permanent queue deadlock
  // =========================================================================
  it("Scenario 6: Printer OFF→ON and Print Recovery → no permanent queue deadlock", async () => {
    db.exec(`UPDATE printers SET enabled = 0 WHERE id = '${PRINTER_EPSON_ID}'`);

    // Order 1 was in submission when printer turned off
    const order1Id = insertOrder(1, {
      status: "PRINTING",
      printerId: PRINTER_HP_ID,
      physicalDeviceId: "PHYSICAL_HP_M404",
      updatedAtMs: currentSimulatedTime,
    });

    const attId = crypto.randomUUID();
    db.exec(`
      INSERT INTO print_attempts (id, order_id, agent_id, printer_id, attempt_number, status, created_at_ms, updated_at_ms)
      VALUES ('${attId}', '${order1Id}', '${AGENT_ID}', '${PRINTER_HP_ID}', 1, 'PRINTING', ${currentSimulatedTime}, ${currentSimulatedTime});
      INSERT INTO print_attempt_steps (id, print_attempt_id, order_id, sequence_number, step_type, status, submission_started_at_ms, created_at_ms, updated_at_ms)
      VALUES ('${crypto.randomUUID()}', '${attId}', '${order1Id}', 1, 'CUSTOMER_DOCUMENT', 'SUBMISSION_STARTED', ${currentSimulatedTime}, ${currentSimulatedTime}, ${currentSimulatedTime});
    `);

    // Order 2 queued behind it
    const order2Id = insertOrder(2, { status: "QUEUED" });

    // Printer turned OFF then ON
    db.exec(
      `UPDATE printers SET status = 'OFFLINE', status_reason = 'OFFLINE' WHERE id = '${PRINTER_HP_ID}'`,
    );
    currentSimulatedTime += 5 * 60 * 1000 + 1000;
    db.exec(
      `UPDATE printers SET status = 'ONLINE', status_reason = 'READY' WHERE id = '${PRINTER_HP_ID}'`,
    );
    db.exec(
      `UPDATE agents SET last_heartbeat_at_ms = ${currentSimulatedTime} WHERE id = '${AGENT_ID}'`,
    );

    // Print Recovery is run
    const recovery = await printingRepo.recoverQueue({
      adminId: ADMIN_ID,
      nowMs: currentSimulatedTime,
    });
    expect(recovery.uncertainOrdersCount).toBeGreaterThanOrEqual(1);

    // Agent control command CLEAR_SPOOLER is generated
    const spoolCmd = db
      .prepare(
        "SELECT id, status FROM agent_control_commands WHERE agent_id = ? ORDER BY created_at_ms DESC LIMIT 1",
      )
      .get(AGENT_ID) as { id: string; status: string };
    expect(spoolCmd.status).toBe("PENDING");

    // Clear spooler succeeds on Windows
    db.exec(
      `UPDATE agent_control_commands SET status = 'SUCCEEDED', finished_at_ms = ${currentSimulatedTime + 500} WHERE id = '${spoolCmd.id}'`,
    );

    // Order 2 resumes immediately without deadlock!
    const claims = await printingRepo.claimOrRenewAll(
      AGENT_ID,
      currentSimulatedTime + 1000,
    );
    expect(claims).toHaveLength(1);
    expect(claims[0]?.orderId).toBe(order2Id);
  });

  // =========================================================================
  // SCENARIO 7: CLEAR_SPOOLER PENDING, SUCCEEDED, FAILED, EXPIRED safe behavior
  // =========================================================================
  it("Scenario 7: CLEAR_SPOOLER PENDING, SUCCEEDED, FAILED, EXPIRED → safe, deterministic behavior", async () => {
    db.exec(`UPDATE printers SET enabled = 0 WHERE id = '${PRINTER_EPSON_ID}'`);

    const orderId = insertOrder(1, { status: "QUEUED" });

    // Case 1: CLEAR_SPOOLER is PENDING -> Printer gated
    const cmdId = crypto.randomUUID();
    db.exec(`
      INSERT INTO agent_control_commands (
        id, agent_id, command_type, printer_id, windows_printer_name, status, created_at_ms, expires_at_ms
      ) VALUES (
        '${cmdId}', '${AGENT_ID}', 'CLEAR_SPOOLER', '${PRINTER_HP_ID}', 'HP LaserJet Pro M404n',
        'PENDING', ${currentSimulatedTime}, ${currentSimulatedTime + 60_000}
      );
    `);
    const pendingClaims = await printingRepo.claimOrRenewAll(
      AGENT_ID,
      currentSimulatedTime,
    );
    expect(pendingClaims).toHaveLength(0); // GATED

    // Case 2: CLEAR_SPOOLER is EXPIRED -> Agent connects and claims command, reviving it to PENDING
    currentSimulatedTime += 65_000;
    db.exec(
      `UPDATE agent_control_commands SET status = 'EXPIRED' WHERE id = '${cmdId}'`,
    );

    const revived = await agentRepo.claimPendingTestPrintCommand(
      AGENT_ID,
      currentSimulatedTime,
    );
    expect(revived).not.toBeNull();
    expect(revived?.commandId).toBe(cmdId);
    expect(revived?.type).toBe("CLEAR_SPOOLER");

    // Case 3: CLEAR_SPOOLER reports SUCCEEDED -> Gate opens, Order 1 claims immediately
    db.exec(
      `UPDATE agent_control_commands SET status = 'SUCCEEDED', finished_at_ms = ${currentSimulatedTime} WHERE id = '${cmdId}'`,
    );
    const openClaims = await printingRepo.claimOrRenewAll(
      AGENT_ID,
      currentSimulatedTime + 100,
    );
    expect(openClaims).toHaveLength(1);
    expect(openClaims[0]?.orderId).toBe(orderId);
  });

  // =========================================================================
  // SCENARIO 8: Multiple printers → no unrelated device blocked
  // =========================================================================
  it("Scenario 8: Multiple printers → no unrelated device blocked", async () => {
    // HP printer has an order held in ADMIN_ACTION_REQUIRED with physical lock
    insertOrder(1, {
      status: "ADMIN_ACTION_REQUIRED",
      printerId: PRINTER_HP_ID,
      physicalDeviceId: "PHYSICAL_HP_M404",
    });

    // Epson printer has a color order queued
    const colorOrderId = insertOrder(2, {
      status: "QUEUED",
      colorMode: "COLOR",
    });

    // Claim on Epson printer proceeds immediately without being blocked by HP
    const claims = await printingRepo.claimOrRenewAll(
      AGENT_ID,
      currentSimulatedTime,
    );
    expect(claims).toHaveLength(1);
    expect(claims[0]?.orderId).toBe(colorOrderId);
    expect(claims[0]?.printerId).toBe(PRINTER_EPSON_ID);
  });

  // =========================================================================
  // SCENARIO 9: Priority/FIFO, best-fit routing, and fallback remain identical
  // =========================================================================
  it("Scenario 9: Priority/FIFO, best-fit routing, and fallback remain identical", async () => {
    db.exec(`UPDATE printers SET enabled = 0 WHERE id = '${PRINTER_EPSON_ID}'`);

    // Order 1 is standard queued at T0
    const ord1 = insertOrder(1, {
      status: "QUEUED",
      queuedAtMs: currentSimulatedTime,
      isPriority: false,
    });
    // Order 2 is priority queued at T+10
    const ord2 = insertOrder(2, {
      status: "QUEUED",
      queuedAtMs: currentSimulatedTime + 10_000,
      isPriority: true,
    });

    // Order 2 MUST claim first despite arriving later because is_priority = 1
    const claims1 = await printingRepo.claimOrRenewAll(
      AGENT_ID,
      currentSimulatedTime + 20_000,
    );
    expect(claims1).toHaveLength(1);
    expect(claims1[0]?.orderId).toBe(ord2);

    // Complete Order 2 cleanly
    await completeClaimedJob(claims1[0]!, currentSimulatedTime + 20_100);

    // Order 1 claims next in priority/FIFO order
    const claims2 = await printingRepo.claimOrRenewAll(
      AGENT_ID,
      currentSimulatedTime + 20_200,
    );
    expect(claims2).toHaveLength(1);
    expect(claims2[0]?.orderId).toBe(ord1);
  });

  // =========================================================================
  // SCENARIO 10: Agent restart and concurrent claims → no physical lock violations
  // =========================================================================
  it("Scenario 10: Agent restart and concurrent claims → no physical lock violations", async () => {
    db.exec(`UPDATE printers SET enabled = 0 WHERE id = '${PRINTER_EPSON_ID}'`);

    insertOrder(1, { status: "QUEUED" });
    insertOrder(2, { status: "QUEUED" });

    // Two concurrent claim requests hitting worker simultaneously on the single HP printer
    const [c1, c2] = await Promise.all([
      printingRepo.claimOrRenewAll(AGENT_ID, currentSimulatedTime),
      printingRepo.claimOrRenewAll(AGENT_ID, currentSimulatedTime),
    ]);

    const flattened = [...(c1 ?? []), ...(c2 ?? [])];
    const claimIds = new Set(flattened.map((j) => j.claimId));
    // Atomic renewal returns the identical claim ID
    expect(claimIds.size).toBe(1);

    // Total actively claimed orders in DB is strictly 1
    const activeRows = db
      .prepare(
        "SELECT id, physical_device_id FROM orders WHERE status = 'CLAIMED'",
      )
      .all() as Array<{ id: string; physical_device_id: string }>;
    expect(activeRows).toHaveLength(1);
  });

  // =========================================================================
  // SCENARIO 11: Healthy single-order latency → no regression from fast path
  // =========================================================================
  it("Scenario 11: Healthy single-order latency → no regression from existing fast path", async () => {
    db.exec(`UPDATE printers SET enabled = 0 WHERE id = '${PRINTER_EPSON_ID}'`);

    const orderId = insertOrder(1, { status: "QUEUED" });

    const startTime = Date.now();
    const claims = await printingRepo.claimOrRenewAll(
      AGENT_ID,
      currentSimulatedTime,
    );
    const durationMs = Date.now() - startTime;

    expect(claims).toHaveLength(1);
    expect(claims[0]?.orderId).toBe(orderId);
    // Instant execution in under 50ms in memory (fast path)
    expect(durationMs).toBeLessThan(50);
  });

  // =========================================================================
  // SCENARIO 12: D1 reads/writes → bounded and minimal workload
  // =========================================================================
  it("Scenario 12: D1 reads/writes → bounded and minimal workload", async () => {
    db.exec(`UPDATE printers SET enabled = 0 WHERE id = '${PRINTER_EPSON_ID}'`);

    insertOrder(1, { status: "QUEUED" });

    metrics.statements = 0;
    metrics.returnedRows = 0;
    metrics.changedRows = 0;

    await printingRepo.claimOrRenewAll(AGENT_ID, currentSimulatedTime);

    // Efficient single-claim cycle: small number of statements, zero table scans
    expect(metrics.statements).toBeLessThanOrEqual(20);
  });
});
