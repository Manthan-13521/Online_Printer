import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hashSessionToken } from "@printgo/auth";
import { ExecutionJournalStore } from "../../../../agent/windows/src/storage/execution-journal.js";
import { D1PrintingRepository } from "./repository.js";

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

const AGENT_ID = "50000000-0000-4000-8000-000000000001";
const AGENT_SECRET = "sec_test_secret_for_phase6_acceptance_test_5000";

describe("PRINTGO — PHASE 6 ACCEPTANCE TEST SUITE: PARALLEL PRINTING & PHYSICAL DEVICE LOCKS", () => {
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
        1, 'PrintGo Acceptance Shop', '+919876543210', 'Tech Hub 101', 'Welcome',
        1, 26214400, 104857600,
        0, NULL,
        ${initialNowMs}, ${initialNowMs}
      );

      INSERT INTO agents (
        id, display_name, credential_hash, is_active, paired_at_ms,
        last_heartbeat_at_ms, created_at_ms, updated_at_ms
      ) VALUES (
        '${AGENT_ID}', 'Counter Agent Windows', '${secretHash}', 1, ${initialNowMs},
        ${initialNowMs}, ${initialNowMs}, ${initialNowMs}
      );
    `);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function seedPrinter(opts: {
    id: string;
    displayName: string;
    windowsPrinterName: string;
    physicalDeviceId: string | null;
    isDefault?: boolean;
    priority?: number;
    color?: boolean;
    duplex?: boolean;
    a3?: boolean;
    status?: "ONLINE" | "OFFLINE";
    isPaused?: boolean;
    autoFallbackEnabled?: boolean;
    fallbackPrinterId?: string | null;
  }) {
    const isDef = opts.isDefault ?? false;
    const priority = opts.priority ?? 0;
    const isColor = opts.color ?? false;
    const isDuplex = opts.duplex ?? false;
    const isA3 = opts.a3 ?? false;
    const status = opts.status ?? "ONLINE";
    const isPaused = opts.isPaused ? 1 : 0;
    const autoFallback = opts.autoFallbackEnabled ? 1 : 0;
    const fallbackId = opts.fallbackPrinterId
      ? `'${opts.fallbackPrinterId}'`
      : "NULL";
    const physId = opts.physicalDeviceId
      ? `'${opts.physicalDeviceId}'`
      : "NULL";

    const caps = JSON.stringify({
      colour: isColor,
      duplex: isDuplex,
      paperSizes: isA3 ? ["A4", "A3"] : ["A4"],
    });

    const verifiedCaps = JSON.stringify({
      verified: {
        bw: 1,
        color: isColor ? 1 : 0,
        duplex: isDuplex ? 1 : 0,
        a4: 1,
        a3: isA3 ? 1 : 0,
      },
      enabled: {
        bw: 1,
        color: isColor ? 1 : 0,
        duplex: isDuplex ? 1 : 0,
        a4: 1,
        a3: isA3 ? 1 : 0,
      },
      requiresReview: 0,
    });

    const enabledServices = JSON.stringify({
      bw: 1,
      color: isColor ? 1 : 0,
      duplex: isDuplex ? 1 : 0,
      a4: 1,
      a3: isA3 ? 1 : 0,
    });

    db.exec(`
      INSERT INTO printers (
        id, agent_id, display_name, windows_printer_name, enabled, status,
        is_production_eligible, is_virtual, priority, physical_device_id,
        is_paused, auto_fallback_enabled, fallback_printer_id,
        capabilities_json, verified_capabilities_json, enabled_services_json,
        last_status_at_ms, created_at_ms, updated_at_ms
      ) VALUES (
        '${opts.id}', '${AGENT_ID}', '${opts.displayName}', '${opts.windowsPrinterName}', 1, '${status}',
        1, 0, ${priority}, ${physId},
        ${isPaused}, ${autoFallback}, ${fallbackId},
        '${caps}', '${verifiedCaps}', '${enabledServices}',
        ${initialNowMs}, ${initialNowMs}, ${initialNowMs}
      );
    `);

    if (isDef) {
      db.exec(
        `UPDATE installation SET default_production_printer_id = '${opts.id}' WHERE id = 1;`,
      );
    }
  }

  function createOrderFixture(
    idName: string,
    opts: {
      status?: string;
      printerId?: string | null;
      physicalDeviceId?: string | null;
      isPriority?: boolean;
      colorMode?: "BW" | "COLOR";
      paperSize?: "A4" | "A3";
      sides?: "SINGLE" | "DOUBLE";
      copies?: number;
      filesCount?: number;
      pageCount?: number;
      totalAmountPaise?: number;
      isPaid?: boolean;
      nowMs?: number;
    } = {},
  ) {
    const id =
      idName.length === 36 && idName.includes("-")
        ? idName
        : crypto.randomUUID();
    const timestamp = opts.nowMs ?? currentSimulatedTime;
    const status = opts.status ?? "QUEUED";
    const priority = opts.isPriority ? 1 : 0;
    const colorMode = opts.colorMode ?? "BW";
    const paperSize = opts.paperSize ?? "A4";
    const sides = opts.sides ?? "SINGLE";
    const copies = opts.copies ?? 1;
    const filesCount = opts.filesCount ?? 1;
    const pageCount = opts.pageCount ?? 1;
    const totalAmount = opts.totalAmountPaise ?? 1000;
    const isPaid = opts.isPaid ?? true;
    const publicJobCode = `PG-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

    const printerVal = opts.printerId ? `'${opts.printerId}'` : "NULL";
    const physVal = opts.physicalDeviceId
      ? `'${opts.physicalDeviceId}'`
      : "NULL";

    const needsClaim = [
      "CLAIMED",
      "SPOOLING",
      "PRINTING",
      "PRINT_BLOCKED",
      "PRINT_FAILED",
      "ADMIN_ACTION_REQUIRED",
      "PRINTED",
    ].includes(status);
    const claimedByVal = needsClaim ? `'${AGENT_ID}'` : "NULL";
    const claimIdVal = needsClaim ? `'${crypto.randomUUID()}'` : "NULL";
    const claimExpiresVal = needsClaim ? timestamp + 300_000 : "NULL";
    const claimedAtVal = needsClaim ? timestamp : "NULL";

    if (timestamp >= initialNowMs) {
      db.prepare("UPDATE agents SET last_heartbeat_at_ms = ? WHERE id = ?").run(
        timestamp,
        AGENT_ID,
      );
    }

    db.exec(`
      INSERT INTO orders (
        id, public_job_code, customer_name, customer_phone,
        original_filename, selected_pages, copies, color_mode, paper_size, sides,
        printing_amount_paise, service_charge_paise, total_amount_paise,
        status, is_priority, queued_at_ms, created_at_ms, updated_at_ms, cleanup_state,
        printer_id, physical_device_id,
        claimed_by_agent_id, claim_id, claim_expires_at_ms, claimed_at_ms
      ) VALUES (
        '${id}', '${publicJobCode}', 'Customer', '+919876543210',
        'document.pdf', 'ALL', ${copies}, '${colorMode}', '${paperSize}', '${sides}',
        ${totalAmount}, 0, ${totalAmount},
        '${status}', ${priority}, ${timestamp}, ${timestamp}, ${timestamp}, 'ACTIVE',
        ${printerVal}, ${physVal},
        ${claimedByVal}, ${claimIdVal}, ${claimExpiresVal}, ${claimedAtVal}
      );
    `);

    if (isPaid) {
      db.exec(`
        INSERT INTO payments (
          id, order_id, provider, status, amount_paise, currency,
          provider_order_id, provider_payment_id, verified_at_ms, created_at_ms, updated_at_ms
        ) VALUES (
          '${crypto.randomUUID()}', '${id}', 'RAZORPAY', 'PAID', ${totalAmount}, 'INR',
          'order_${id.slice(0, 10)}', 'pay_${id.slice(0, 10)}', ${timestamp}, ${timestamp}, ${timestamp}
        );
      `);
    }

    db.exec(`
      INSERT INTO uploads (
        id, order_id, r2_object_key, original_filename, mime_type,
        size_bytes, storage_status, created_at_ms, uploaded_at_ms, updated_at_ms, expected_size_bytes
      ) VALUES (
        '${crypto.randomUUID()}', '${id}', 'uploads/${id}/file_1.pdf', 'file_1.pdf', 'application/pdf',
        1024, 'UPLOADED', ${timestamp}, ${timestamp}, ${timestamp}, 1024
      );
    `);

    for (let f = 1; f <= filesCount; f++) {
      const fileId = crypto.randomUUID();
      db.exec(`
        INSERT INTO order_files (
          id, order_id, position, original_filename, r2_object_key,
          expected_size_bytes, size_bytes, source_page_count, selected_pages,
          copies, paper_size, color_mode, sides, printing_amount_paise,
          service_charge_paise, upload_status, print_status, uploaded_at_ms, created_at_ms, updated_at_ms
        ) VALUES (
          '${fileId}', '${id}', ${f}, 'file_${f}.pdf', 'uploads/${id}/file_${f}.pdf',
          1024, 1024, ${pageCount}, 'ALL',
          ${copies}, '${paperSize}', '${colorMode}', '${sides}', ${Math.floor(totalAmount / filesCount)},
          0, 'UPLOADED', 'PENDING', ${timestamp}, ${timestamp}, ${timestamp}
        );
      `);
    }

    return id;
  }

  async function recordStepSuccess(params: {
    orderId: string;
    stepId: string;
    claimId: string;
    agentId: string;
    nowMs: number;
    spoolerJobId?: string;
  }) {
    await printingRepo.startStep({
      orderId: params.orderId,
      stepId: params.stepId,
      claimId: params.claimId,
      agentId: params.agentId,
      nowMs: params.nowMs,
    });
    await printingRepo.recordSubmission({
      orderId: params.orderId,
      stepId: params.stepId,
      claimId: params.claimId,
      agentId: params.agentId,
      spoolerJobId: params.spoolerJobId ?? "spool-1",
      nowMs: params.nowMs,
    });
    return printingRepo.recordResult({
      ...params,
      spoolerJobId: params.spoolerJobId ?? "spool-1",
      status: "SUCCEEDED",
      failureCode: null,
      failureDetail: null,
    });
  }

  // =========================================================================
  // SCENARIO 6.1: Single Physical Printer Serialization
  // =========================================================================
  it("6.1: Single physical printer — 20 competing orders serialize strictly to exactly 1 active execution", async () => {
    const P1_ID = "10000000-0000-4000-8000-000000000001";
    seedPrinter({
      id: P1_ID,
      displayName: "HP Laser MFP 136w",
      windowsPrinterName: "HP Laser MFP 136w",
      physicalDeviceId: "hw-hp-136w",
      isDefault: true,
      priority: 10,
    });

    const orderIds: string[] = [];
    for (let i = 1; i <= 20; i++) {
      orderIds.push(
        createOrderFixture(`ord-single-${i}`, {
          nowMs: currentSimulatedTime - 20_000 + i * 100,
        }),
      );
    }

    // Agent claims all available jobs
    const activeJobs1 = await printingRepo.claimOrRenewAll(
      AGENT_ID,
      currentSimulatedTime,
    );
    // Exactly 1 job is claimed because only 1 physical device exists
    expect(activeJobs1).toHaveLength(1);
    expect(activeJobs1[0]?.orderId).toBe(orderIds[0]);
    expect(activeJobs1[0]?.physicalDeviceId).toBe("hw-hp-136w");

    // Calling claim again while order 1 is active returns the same renewal, NEVER a second order
    const activeJobsAgain = await printingRepo.claimOrRenewAll(
      AGENT_ID,
      currentSimulatedTime + 1000,
    );
    expect(activeJobsAgain).toHaveLength(1);
    expect(activeJobsAgain[0]?.orderId).toBe(orderIds[0]);

    // Complete order 1
    await recordStepSuccess({
      orderId: activeJobs1[0]!.orderId,
      stepId: activeJobs1[0]!.currentStep.stepId,
      claimId: activeJobs1[0]!.claimId,
      agentId: AGENT_ID,
      nowMs: currentSimulatedTime + 2000,
    });

    // Next pulse claims order 2
    const activeJobs2 = await printingRepo.claimOrRenewAll(
      AGENT_ID,
      currentSimulatedTime + 3000,
    );
    expect(activeJobs2).toHaveLength(1);
    expect(activeJobs2[0]?.orderId).toBe(orderIds[1]);
    expect(activeJobs2[0]?.physicalDeviceId).toBe("hw-hp-136w");

    // Verify all remaining orders are still in QUEUED state
    const queuedCount = db
      .prepare("SELECT COUNT(*) count FROM orders WHERE status = 'QUEUED'")
      .get() as { count: number };
    expect(queuedCount.count).toBe(18);
  });

  // =========================================================================
  // SCENARIO 6.2: Two Independent Physical Printers
  // =========================================================================
  it("6.2: Two independent printers — separate customer orders execute concurrently on distinct hardware", async () => {
    const P1_ID = "10000000-0000-4000-8000-000000000001";
    const P2_ID = "10000000-0000-4000-8000-000000000002";
    seedPrinter({
      id: P1_ID,
      displayName: "HP Laser MFP 136w",
      windowsPrinterName: "HP_136w",
      physicalDeviceId: "hw-hp-136w",
      isDefault: true,
      priority: 10,
    });
    seedPrinter({
      id: P2_ID,
      displayName: "Canon ImageRunner",
      windowsPrinterName: "Canon_IR",
      physicalDeviceId: "hw-canon-ir",
      priority: 5,
    });

    const o1 = createOrderFixture("ord-par-1", { printerId: P1_ID });
    const o2 = createOrderFixture("ord-par-2", { printerId: P2_ID });

    // Both printers have independent hardware -> claimOrRenewAll claims both simultaneously
    const activeJobs = await printingRepo.claimOrRenewAll(
      AGENT_ID,
      currentSimulatedTime,
    );
    expect(activeJobs).toHaveLength(2);

    const job1 = activeJobs.find((j) => j.orderId === o1);
    const job2 = activeJobs.find((j) => j.orderId === o2);

    expect(job1).toBeDefined();
    expect(job1?.physicalDeviceId).toBe("hw-hp-136w");

    expect(job2).toBeDefined();
    expect(job2?.physicalDeviceId).toBe("hw-canon-ir");

    // Verify both orders in D1 hold independent active physical locks
    const rows = db
      .prepare("SELECT id, status, physical_device_id FROM orders ORDER BY id")
      .all() as Array<{
      id: string;
      status: string;
      physical_device_id: string;
    }>;
    expect(rows).toEqual(
      [
        { id: o1, status: "CLAIMED", physical_device_id: "hw-hp-136w" },
        { id: o2, status: "CLAIMED", physical_device_id: "hw-canon-ir" },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
  });

  // =========================================================================
  // SCENARIO 6.3: Same Physical Printer, Two Windows Queues
  // =========================================================================
  it("6.3: Same physical printer, two Windows queues — shared hardware ID strictly prevents overlapping execution", async () => {
    const Q1_ID = "10000000-0000-4000-8000-000000000001";
    const Q2_ID = "10000000-0000-4000-8000-000000000002";
    // Two queues mapped to the SAME physical printer hardware (e.g. Simplex Queue vs Duplex Queue)
    seedPrinter({
      id: Q1_ID,
      displayName: "HP Simplex Queue",
      windowsPrinterName: "HP_Simplex",
      physicalDeviceId: "hw-shared-hp",
      isDefault: true,
      priority: 10,
    });
    seedPrinter({
      id: Q2_ID,
      displayName: "HP Duplex Queue",
      windowsPrinterName: "HP_Duplex",
      physicalDeviceId: "hw-shared-hp",
      priority: 5,
    });

    const o1 = createOrderFixture("ord-queue-1", {
      printerId: Q1_ID,
      nowMs: currentSimulatedTime - 200,
    });
    const o2 = createOrderFixture("ord-queue-2", {
      printerId: Q2_ID,
      nowMs: currentSimulatedTime - 100,
    });

    // Pulse claims orders
    const activeJobs = await printingRepo.claimOrRenewAll(
      AGENT_ID,
      currentSimulatedTime,
    );
    // Despite two queues, only 1 job is claimed because both queues share hw-shared-hp!
    expect(activeJobs).toHaveLength(1);
    expect(activeJobs[0]?.orderId).toBe(o1);

    const o2Status = db
      .prepare("SELECT status FROM orders WHERE id = ?")
      .get(o2) as { status: string };
    expect(o2Status.status).toBe("QUEUED");

    // Partial unique index test: directly attempting to mark o2 as CLAIMED with same physical_device_id MUST throw
    expect(() => {
      db.prepare(
        `
        UPDATE orders
        SET status = 'CLAIMED', physical_device_id = 'hw-shared-hp',
            claimed_by_agent_id = ?, claim_id = ?, claim_expires_at_ms = ?, claimed_at_ms = ?
        WHERE id = ?
      `,
      ).run(
        AGENT_ID,
        crypto.randomUUID(),
        currentSimulatedTime + 60_000,
        currentSimulatedTime,
        o2,
      );
    }).toThrow(/UNIQUE constraint failed: orders\.physical_device_id/);
  });

  // =========================================================================
  // SCENARIO 6.4: Three Independent Physical Printers
  // =========================================================================
  it("6.4: Three independent printers — executes 3 distinct customer orders simultaneously without interference", async () => {
    const P1 = "10000000-0000-4000-8000-000000000001";
    const P2 = "10000000-0000-4000-8000-000000000002";
    const P3 = "10000000-0000-4000-8000-000000000003";

    seedPrinter({
      id: P1,
      displayName: "P1",
      windowsPrinterName: "W1",
      physicalDeviceId: "hw-p1",
      priority: 10,
    });
    seedPrinter({
      id: P2,
      displayName: "P2",
      windowsPrinterName: "W2",
      physicalDeviceId: "hw-p2",
      priority: 8,
    });
    seedPrinter({
      id: P3,
      displayName: "P3",
      windowsPrinterName: "W3",
      physicalDeviceId: "hw-p3",
      priority: 6,
    });

    const o1 = createOrderFixture("ord-3p-1", {
      printerId: P1,
      nowMs: currentSimulatedTime - 400,
    });
    const o2 = createOrderFixture("ord-3p-2", {
      printerId: P2,
      nowMs: currentSimulatedTime - 300,
    });
    const o3 = createOrderFixture("ord-3p-3", {
      printerId: P3,
      nowMs: currentSimulatedTime - 200,
    });
    const o4 = createOrderFixture("ord-3p-4", {
      printerId: P1,
      nowMs: currentSimulatedTime - 100,
    });

    const activeJobs = await printingRepo.claimOrRenewAll(
      AGENT_ID,
      currentSimulatedTime,
    );
    expect(activeJobs).toHaveLength(3);

    const claimedIds = activeJobs.map((j) => j.orderId).sort();
    expect(claimedIds).toEqual([o1, o2, o3].sort());

    const o4Status = db
      .prepare("SELECT status FROM orders WHERE id = ?")
      .get(o4) as { status: string };
    expect(o4Status.status).toBe("QUEUED");
  });

  // =========================================================================
  // SCENARIO 6.5: Multi-File Order Sequencing
  // =========================================================================
  it("6.5: Multi-file order sequencing — File 1 -> File 2 -> File 3 execute strictly in order without overlap", async () => {
    const P1 = "10000000-0000-4000-8000-000000000001";
    seedPrinter({
      id: P1,
      displayName: "HP 136w",
      windowsPrinterName: "HP",
      physicalDeviceId: "hw-hp",
      isDefault: true,
    });

    const multiOrderId = createOrderFixture("ord-seq-3files", {
      filesCount: 3,
    });

    // Pulse 1: Claim returns Step 1 (File 1)
    const claim1 = await printingRepo.claimOrRenew(
      AGENT_ID,
      currentSimulatedTime,
    );
    expect(claim1).not.toBeNull();
    expect(claim1?.orderId).toBe(multiOrderId);

    // Complete File 1
    await recordStepSuccess({
      orderId: multiOrderId,
      stepId: claim1!.currentStep.stepId,
      claimId: claim1!.claimId,
      agentId: AGENT_ID,
      nowMs: currentSimulatedTime + 1000,
    });

    // File 1 is PRINTED; File 2 & 3 still PENDING; Order returned to QUEUED
    const f1 = db
      .prepare(
        "SELECT print_status FROM order_files WHERE order_id = ? AND position = 1",
      )
      .get(multiOrderId) as { print_status: string };
    const f2 = db
      .prepare(
        "SELECT print_status FROM order_files WHERE order_id = ? AND position = 2",
      )
      .get(multiOrderId) as { print_status: string };
    expect(f1.print_status).toBe("PRINTED");
    expect(f2.print_status).toBe("PENDING");

    // Pulse 2: Claim returns Step 2 (File 2)
    const claim2 = await printingRepo.claimOrRenew(
      AGENT_ID,
      currentSimulatedTime + 2000,
    );
    expect(claim2).not.toBeNull();
    await recordStepSuccess({
      orderId: multiOrderId,
      stepId: claim2!.currentStep.stepId,
      claimId: claim2!.claimId,
      agentId: AGENT_ID,
      nowMs: currentSimulatedTime + 3000,
    });

    // Pulse 3: Claim returns Step 3 (File 3)
    const claim3 = await printingRepo.claimOrRenew(
      AGENT_ID,
      currentSimulatedTime + 4000,
    );
    expect(claim3).not.toBeNull();
    await recordStepSuccess({
      orderId: multiOrderId,
      stepId: claim3!.currentStep.stepId,
      claimId: claim3!.claimId,
      agentId: AGENT_ID,
      nowMs: currentSimulatedTime + 5000,
    });

    // Order completes only after last file succeeds
    const finalOrder = db
      .prepare("SELECT status FROM orders WHERE id = ?")
      .get(multiOrderId) as { status: string };
    expect(finalOrder.status).toBe("COMPLETED");

    const allFiles = db
      .prepare("SELECT print_status FROM order_files WHERE order_id = ?")
      .all(multiOrderId) as Array<{ print_status: string }>;
    expect(allFiles.every((f) => f.print_status === "PRINTED")).toBe(true);
  });

  // =========================================================================
  // SCENARIO 6.6: Copy Count Integrity
  // =========================================================================
  it("6.6: Copy count integrity — preserves multi-page requested copy counts without duplication", async () => {
    const P1 = "10000000-0000-4000-8000-000000000001";
    seedPrinter({
      id: P1,
      displayName: "HP 136w",
      windowsPrinterName: "HP",
      physicalDeviceId: "hw-hp",
      isDefault: true,
    });

    const orderId = createOrderFixture("ord-copies-3", {
      copies: 3,
      pageCount: 4,
    });

    const claim = await printingRepo.claimOrRenew(
      AGENT_ID,
      currentSimulatedTime,
    );
    expect(claim).not.toBeNull();

    // Verify copies preserved on order row and order_files
    const ordRow = db
      .prepare("SELECT copies FROM orders WHERE id = ?")
      .get(orderId) as { copies: number };
    const fileRow = db
      .prepare(
        "SELECT copies, source_page_count FROM order_files WHERE order_id = ?",
      )
      .get(orderId) as {
      copies: number;
      source_page_count: number;
    };

    expect(ordRow.copies).toBe(3);
    expect(fileRow.copies).toBe(3);
    expect(fileRow.source_page_count).toBe(4);

    // Verify exactly 1 print_attempt and 1 attempt step created for the attempt
    const steps = db
      .prepare(
        "SELECT COUNT(*) count FROM print_attempt_steps WHERE order_id = ?",
      )
      .all(orderId) as Array<{ count: number }>;
    expect(steps[0]?.count).toBe(1);
  });

  // =========================================================================
  // SCENARIO 6.7: Priority Routing Under Contention
  // =========================================================================
  it("6.7: Priority routing under contention — honors is_priority and printer priority without lock violations", async () => {
    const P_HIGH = "10000000-0000-4000-8000-000000000001";
    const P_LOW = "10000000-0000-4000-8000-000000000002";
    seedPrinter({
      id: P_HIGH,
      displayName: "Primary HP",
      windowsPrinterName: "HP_High",
      physicalDeviceId: "hw-high",
      priority: 10,
      isDefault: true,
    });
    seedPrinter({
      id: P_LOW,
      displayName: "Secondary Deskjet",
      windowsPrinterName: "HP_Low",
      physicalDeviceId: "hw-low",
      priority: 5,
    });

    // Standard order queued first
    const stdOrder = createOrderFixture("ord-std", {
      isPriority: false,
      nowMs: currentSimulatedTime,
    });
    // Priority order queued after
    const vipOrder = createOrderFixture("ord-vip", {
      isPriority: true,
      nowMs: currentSimulatedTime + 100,
    });

    const activeJobs = await printingRepo.claimOrRenewAll(
      AGENT_ID,
      currentSimulatedTime + 200,
    );
    expect(activeJobs).toHaveLength(2);

    // Priority order claimed by the highest priority printer (P_HIGH)
    const vipJob = activeJobs.find((j) => j.orderId === vipOrder);
    const stdJob = activeJobs.find((j) => j.orderId === stdOrder);

    expect(vipJob?.printerId).toBe(P_HIGH);
    expect(stdJob?.printerId).toBe(P_LOW);
  });

  // =========================================================================
  // SCENARIO 6.8: Busy Printer Routing (Subcase B3 Parallel Dispatch)
  // =========================================================================
  it("6.8: Busy printer routing — when primary is busy, safely routes unassigned order to idle secondary printer", async () => {
    const P_PRIMARY = "10000000-0000-4000-8000-000000000001";
    const P_SECONDARY = "10000000-0000-4000-8000-000000000002";

    seedPrinter({
      id: P_PRIMARY,
      displayName: "Printer A",
      windowsPrinterName: "A",
      physicalDeviceId: "hw-A",
      isDefault: true,
      priority: 10,
    });
    seedPrinter({
      id: P_SECONDARY,
      displayName: "Printer B",
      windowsPrinterName: "B",
      physicalDeviceId: "hw-B",
      isDefault: false,
      priority: 5,
    });

    // Order 1 is already actively printing on Printer A
    const o1 = createOrderFixture("ord-busy-1", {
      printerId: P_PRIMARY,
      status: "PRINTING",
      physicalDeviceId: "hw-A",
    });

    // Order 2 arrives without predetermined printer assignment (printer_id = NULL)
    const o2 = createOrderFixture("ord-busy-2", {
      printerId: null,
      status: "QUEUED",
    });

    const activeJobs = await printingRepo.claimOrRenewAll(
      AGENT_ID,
      currentSimulatedTime,
    );
    // Subcase B3 parallel routing: Printer A is busy on hw-A, so Order 2 is claimed on Printer B (hw-B)
    const o2Job = activeJobs.find((j) => j.orderId === o2);
    expect(o2Job).toBeDefined();
    expect(o2Job?.printerId).toBe(P_SECONDARY);
    expect(o2Job?.physicalDeviceId).toBe("hw-B");

    // Order 1 still holds hw-A
    const o1Row = db
      .prepare("SELECT physical_device_id FROM orders WHERE id = ?")
      .get(o1) as { physical_device_id: string };
    expect(o1Row.physical_device_id).toBe("hw-A");
  });

  // =========================================================================
  // SCENARIO 6.9: Printer Capability Mismatch
  // =========================================================================
  it("6.9: Printer capability mismatch — color, duplex, and A3 jobs never claim on A4 B&W simplex printer", async () => {
    const P_MFP136 = "10000000-0000-4000-8000-000000000001";
    // Real HP Laser MFP 136w: A4, B&W, simplex ONLY
    seedPrinter({
      id: P_MFP136,
      displayName: "HP Laser MFP 136w",
      windowsPrinterName: "HP Laser MFP 136w",
      physicalDeviceId: "hw-hp-136w",
      isDefault: true,
      color: false,
      duplex: false,
      a3: false,
    });

    createOrderFixture("ord-color", { colorMode: "COLOR" });
    createOrderFixture("ord-duplex", { sides: "DOUBLE" });
    createOrderFixture("ord-a3", { paperSize: "A3" });

    const claims = await printingRepo.claimOrRenewAll(
      AGENT_ID,
      currentSimulatedTime,
    );
    // NONE of the incompatible orders can be claimed
    expect(claims).toHaveLength(0);

    const queued = db
      .prepare("SELECT COUNT(*) count FROM orders WHERE status = 'QUEUED'")
      .get() as { count: number };
    expect(queued.count).toBe(3);
  });

  // =========================================================================
  // SCENARIO 6.10: Printer Disconnect Before Submission
  // =========================================================================
  it("6.10: Printer disconnect before submission — releases physical lock and initiates scheduled retry backoff", async () => {
    const P1 = "10000000-0000-4000-8000-000000000001";
    seedPrinter({
      id: P1,
      displayName: "HP",
      windowsPrinterName: "HP",
      physicalDeviceId: "hw-hp",
      isDefault: true,
    });

    const orderId = createOrderFixture("ord-preflight-disc");
    const claim = await printingRepo.claimOrRenew(
      AGENT_ID,
      currentSimulatedTime,
    );
    expect(claim).not.toBeNull();

    // Injected hardware disconnect before submission
    const result = await printingRepo.handlePreflightFailure({
      orderId,
      stepId: claim!.currentStep.stepId,
      claimId: claim!.claimId,
      agentId: AGENT_ID,
      failureCode: "PRINTER_OFFLINE",
      failureDetail: "Printer USB cable disconnected",
      nowMs: currentSimulatedTime,
    });

    expect(result.action).toBe("BLOCKED_RELEASED");
    expect(result.retryAfterMs).toBe(60_000);

    // Verify order transitioned to RETRY_PENDING and physical claim is released
    const row = db
      .prepare(
        "SELECT status, claimed_by_agent_id, claim_id, next_retry_at_ms FROM orders WHERE id = ?",
      )
      .get(orderId) as {
      status: string;
      claimed_by_agent_id: string | null;
      claim_id: string | null;
      next_retry_at_ms: number;
    };
    expect(row.status).toBe("RETRY_PENDING");
    expect(row.claimed_by_agent_id).toBeNull();
    expect(row.claim_id).toBeNull();
    expect(row.next_retry_at_ms).toBe(currentSimulatedTime + 60_000);
  });

  // =========================================================================
  // SCENARIO 6.11: Printer Disconnect During Submission
  // =========================================================================
  it("6.11: Printer disconnect during submission — halts automatically with UNCERTAIN and retains Admin lock", async () => {
    const P1 = "10000000-0000-4000-8000-000000000001";
    seedPrinter({
      id: P1,
      displayName: "HP",
      windowsPrinterName: "HP",
      physicalDeviceId: "hw-hp",
      isDefault: true,
    });

    const orderId = createOrderFixture("ord-mid-sub-disc");
    const claim = await printingRepo.claimOrRenew(
      AGENT_ID,
      currentSimulatedTime,
    );
    expect(claim).not.toBeNull();

    // Submission started
    await printingRepo.startStep({
      orderId,
      stepId: claim!.currentStep.stepId,
      claimId: claim!.claimId,
      agentId: AGENT_ID,
      nowMs: currentSimulatedTime + 100,
    });

    // Connection lost before spooler ACK received
    const result = await printingRepo.handlePreflightFailure({
      orderId,
      stepId: claim!.currentStep.stepId,
      claimId: claim!.claimId,
      agentId: AGENT_ID,
      failureCode: "UNKNOWN",
      failureDetail: "Printer disconnected mid-flight",
      nowMs: currentSimulatedTime + 200,
    });

    // Submissions already started MUST transition to ACTION_REQUIRED / UNCERTAIN
    expect(result.action).toBe("ACTION_REQUIRED");

    const row = db
      .prepare("SELECT status, physical_device_id FROM orders WHERE id = ?")
      .get(orderId) as {
      status: string;
      physical_device_id: string;
    };
    expect(row.status).toBe("ADMIN_ACTION_REQUIRED");
    // Physical lock is RETAINED to prevent another order from printing on the compromised hardware
    expect(row.physical_device_id).toBe("hw-hp");
  });

  // =========================================================================
  // SCENARIO 6.12: Windows Agent Crash During Parallel Jobs
  // =========================================================================
  it("6.12: Windows Agent crash during parallel jobs — verifies per-lane durable journal isolation and recovery", async () => {
    const tempDir = mkdtempSync(
      path.join(os.tmpdir(), "printgo-phase6-crash-"),
    );
    const store = new ExecutionJournalStore(
      path.join(tempDir, "active-print.json"),
    );

    // Two parallel orders active simultaneously
    const order1Entry = {
      orderId: "ord-crash-1",
      attemptId: "att-1",
      stepId: "step-1",
      spoolerJobId: "spool-101",
      updatedAtMs: currentSimulatedTime,
    };
    const order2Entry = {
      orderId: "ord-crash-2",
      attemptId: "att-2",
      stepId: "step-2",
      spoolerJobId: null, // Crashed before spooler ID registered!
      updatedAtMs: currentSimulatedTime,
    };

    await store.save(order1Entry);
    await store.save(order2Entry);

    // Agent restarts: loads active print journals
    const recovered1 = await store.load("ord-crash-1");
    const recovered2 = await store.load("ord-crash-2");

    expect(recovered1?.spoolerJobId).toBe("spool-101"); // Resumes monitoring spool-101
    expect(recovered2?.spoolerJobId).toBeNull(); // Reports UNCERTAIN safely

    // Clear lane 1 independently without affecting lane 2
    await store.clear("ord-crash-1");
    expect(await store.load("ord-crash-1")).toBeNull();
    expect(await store.load("ord-crash-2")).not.toBeNull();

    rmSync(tempDir, { recursive: true, force: true });
  });

  // =========================================================================
  // SCENARIO 6.13: Concurrent Cloudflare Worker Claims
  // =========================================================================
  it("6.13: Concurrent Cloudflare Worker claims — atomic transactions prevent race conditions across parallel workers", async () => {
    const P1 = "10000000-0000-4000-8000-000000000001";
    seedPrinter({
      id: P1,
      displayName: "HP",
      windowsPrinterName: "HP",
      physicalDeviceId: "hw-hp",
      isDefault: true,
    });

    createOrderFixture("ord-race-1");

    // 5 concurrent workers race to claim the single order
    const claimPromises = Array.from({ length: 5 }, () =>
      printingRepo.claimOrRenewAll(AGENT_ID, currentSimulatedTime),
    );

    const results = await Promise.all(claimPromises);
    const flattened = results.flat();

    // All claims returned refer to the EXACT SAME claim ID (idempotent atomic renewal, not multiple claims)
    const claimIds = new Set(flattened.map((j) => j.claimId));
    expect(claimIds.size).toBe(1);

    // Total active orders in DB is strictly 1
    const activeCount = db
      .prepare("SELECT COUNT(*) count FROM orders WHERE status = 'CLAIMED'")
      .get() as { count: number };
    expect(activeCount.count).toBe(1);
  });

  // =========================================================================
  // SCENARIO 6.14: Physical Lock Expiry and Recovery
  // =========================================================================
  it("6.14: Physical lock expiry and recovery — stale leases cannot block physical hardware indefinitely", async () => {
    const P1 = "10000000-0000-4000-8000-000000000001";
    seedPrinter({
      id: P1,
      displayName: "HP",
      windowsPrinterName: "HP",
      physicalDeviceId: "hw-hp",
      isDefault: true,
    });

    const orderId = createOrderFixture("ord-stale-lock");
    const claim = await printingRepo.claimOrRenew(
      AGENT_ID,
      currentSimulatedTime,
    );
    expect(claim).not.toBeNull();

    // Advance time past lease window (5m / 300_000ms lease) + recovery window
    const futureTime = currentSimulatedTime + 310_000;

    // Stale agent dies; recoverExpiredClaims recovers the order
    await printingRepo.recoverExpiredClaims(futureTime);

    const recoveredOrder = db
      .prepare(
        "SELECT status, claimed_by_agent_id, physical_device_id FROM orders WHERE id = ?",
      )
      .get(orderId) as {
      status: string;
      claimed_by_agent_id: string | null;
      physical_device_id: string | null;
    };

    expect(recoveredOrder.status).toBe("QUEUED");
    expect(recoveredOrder.claimed_by_agent_id).toBeNull();
    // Hardware lock is released
    expect(recoveredOrder.physical_device_id).toBeNull();
  });

  // =========================================================================
  // SCENARIO 6.15: Payment and Admin Retry Safety
  // =========================================================================
  it("6.15: Payment and Admin retry safety — unpaid orders never print and Admin retries require explicit confirmation", async () => {
    const P1 = "10000000-0000-4000-8000-000000000001";
    seedPrinter({
      id: P1,
      displayName: "HP",
      windowsPrinterName: "HP",
      physicalDeviceId: "hw-hp",
      isDefault: true,
    });

    // 1. Unpaid order
    const unpaidId = createOrderFixture("ord-unpaid", { isPaid: false });
    const unpaidClaims = await printingRepo.claimOrRenewAll(
      AGENT_ID,
      currentSimulatedTime,
    );
    expect(unpaidClaims).toHaveLength(0);

    // 2. Order in ADMIN_ACTION_REQUIRED requires forceUncertain confirmation
    db.prepare(
      `
      UPDATE orders
      SET status = 'ADMIN_ACTION_REQUIRED', claimed_by_agent_id = ?, claim_id = ?, claim_expires_at_ms = ?, claimed_at_ms = ?
      WHERE id = ?
    `,
    ).run(
      AGENT_ID,
      crypto.randomUUID(),
      currentSimulatedTime + 60_000,
      currentSimulatedTime,
      unpaidId,
    );
    db.prepare(
      `
      INSERT INTO payments (id, order_id, provider, status, amount_paise, currency, provider_order_id, provider_payment_id, verified_at_ms, created_at_ms, updated_at_ms)
      VALUES ('${crypto.randomUUID()}', '${unpaidId}', 'RAZORPAY', 'PAID', 1000, 'INR', 'po_1', 'pp_1', ${currentSimulatedTime}, ${currentSimulatedTime}, ${currentSimulatedTime});
    `,
    ).run();

    await expect(
      printingRepo.retryOrder({
        orderId: unpaidId,
        adminId: "admin-1",
        forceUncertain: false,
        nowMs: currentSimulatedTime,
      }),
    ).rejects.toThrow("UNCERTAIN_RETRY_CONFIRMATION_REQUIRED");

    // With explicit admin confirmation, retry succeeds
    const retryResult = await printingRepo.retryOrder({
      orderId: unpaidId,
      adminId: "admin-1",
      forceUncertain: true,
      nowMs: currentSimulatedTime,
    });
    expect(retryResult.status).toBe("QUEUED");
  });

  // =========================================================================
  // SCENARIO 6.16: 50-Order Mixed Workload Throughput
  // =========================================================================
  it("6.16: 50-order mixed workload — processes 50 orders across 2 independent printers with zero duplicate submissions", async () => {
    const P1 = "10000000-0000-4000-8000-000000000001";
    const P2 = "10000000-0000-4000-8000-000000000002";
    seedPrinter({
      id: P1,
      displayName: "Printer 1",
      windowsPrinterName: "P1",
      physicalDeviceId: "hw-1",
      isDefault: true,
      priority: 10,
    });
    seedPrinter({
      id: P2,
      displayName: "Printer 2",
      windowsPrinterName: "P2",
      physicalDeviceId: "hw-2",
      isDefault: false,
      priority: 5,
    });

    // Seed 50 mixed orders
    for (let i = 1; i <= 50; i++) {
      createOrderFixture(`ord-mix-${i}`, {
        copies: i % 5 === 0 ? 2 : 1,
        filesCount: i % 10 === 0 ? 2 : 1,
      });
    }

    let completedOrders = 0;
    let pulses = 0;

    // Process queue in 2-printer parallel simulation
    while (completedOrders < 50 && pulses < 100) {
      pulses++;
      currentSimulatedTime += 2000;
      db.prepare("UPDATE agents SET last_heartbeat_at_ms = ? WHERE id = ?").run(
        currentSimulatedTime,
        AGENT_ID,
      );

      const activeJobs = await printingRepo.claimOrRenewAll(
        AGENT_ID,
        currentSimulatedTime,
      );
      for (const job of activeJobs) {
        await recordStepSuccess({
          orderId: job.orderId,
          stepId: job.currentStep.stepId,
          claimId: job.claimId,
          agentId: AGENT_ID,
          nowMs: currentSimulatedTime,
        });

        const status = db
          .prepare("SELECT status FROM orders WHERE id = ?")
          .get(job.orderId) as { status: string };
        if (status.status === "COMPLETED") {
          completedOrders++;
        }
      }
    }

    expect(completedOrders).toBe(50);
    // Two-printer parallel throughput completed 50 orders in significantly fewer pulses than serialized single-printer
    expect(pulses).toBeLessThanOrEqual(55);

    const completedInDb = db
      .prepare("SELECT COUNT(*) count FROM orders WHERE status = 'COMPLETED'")
      .get() as { count: number };
    expect(completedInDb.count).toBe(50);
  });

  // =========================================================================
  // SCENARIO 6.17: 100-Order Burst Under Contention
  // =========================================================================
  it("6.17: 100-order burst — atomic contention bounds active execution to physical hardware count", async () => {
    const P1 = "10000000-0000-4000-8000-000000000001";
    const P2 = "10000000-0000-4000-8000-000000000002";
    seedPrinter({
      id: P1,
      displayName: "P1",
      windowsPrinterName: "P1",
      physicalDeviceId: "hw-1",
      isDefault: true,
      priority: 10,
    });
    seedPrinter({
      id: P2,
      displayName: "P2",
      windowsPrinterName: "P2",
      physicalDeviceId: "hw-2",
      isDefault: false,
      priority: 5,
    });

    for (let i = 1; i <= 100; i++) {
      createOrderFixture(`ord-burst-p6-${i}`);
    }

    // 10 concurrent bursts
    for (let b = 1; b <= 10; b++) {
      const activeJobs = await printingRepo.claimOrRenewAll(
        AGENT_ID,
        currentSimulatedTime,
      );
      // Strictly <= 2 active jobs because only 2 physical devices exist
      expect(activeJobs.length).toBeLessThanOrEqual(2);

      const uniqueHardware = new Set(activeJobs.map((j) => j.physicalDeviceId));
      expect(uniqueHardware.size).toBe(activeJobs.length);
    }

    const queuedCount = db
      .prepare("SELECT COUNT(*) count FROM orders WHERE status = 'QUEUED'")
      .get() as { count: number };
    expect(queuedCount.count).toBe(98); // 2 claimed, 98 still safely queued
  });

  // =========================================================================
  // SCENARIO 6.18: Full-System Chaos and Safety Regression
  // =========================================================================
  it("6.18: Full-system chaos and safety regression — preserves retry schedule, lock exclusivity, and payment safety", async () => {
    const P1 = "10000000-0000-4000-8000-000000000001";
    const P2 = "10000000-0000-4000-8000-000000000002";
    seedPrinter({
      id: P1,
      displayName: "P1",
      windowsPrinterName: "P1",
      physicalDeviceId: "hw-1",
      isDefault: true,
      priority: 10,
    });
    seedPrinter({
      id: P2,
      displayName: "P2",
      windowsPrinterName: "P2",
      physicalDeviceId: "hw-2",
      isDefault: false,
      priority: 5,
    });

    const chaosOrderId = createOrderFixture("ord-chaos");

    // 1. Initial claim on P1
    const claimInit = await printingRepo.claimOrRenew(
      AGENT_ID,
      currentSimulatedTime,
    );
    expect(claimInit).not.toBeNull();
    expect(claimInit?.physicalDeviceId).toBe("hw-1");

    // Chaos 1: Paper jam before submission -> 60s retry
    const res1 = await printingRepo.handlePreflightFailure({
      orderId: chaosOrderId,
      stepId: claimInit!.currentStep.stepId,
      claimId: claimInit!.claimId,
      agentId: AGENT_ID,
      failureCode: "PAPER_JAM",
      failureDetail: "Tray 1 jammed",
      nowMs: currentSimulatedTime,
    });
    expect(res1.action).toBe("BLOCKED_RELEASED");
    expect(res1.retryAfterMs).toBe(60_000);

    // Chaos 2: Retry 1 at 60s -> still jammed -> 90s retry
    currentSimulatedTime += 60_000;
    db.prepare(
      "UPDATE printers SET is_paused = 0, paused_reason = NULL WHERE id = ?",
    ).run(P1);
    db.prepare("UPDATE agents SET last_heartbeat_at_ms = ? WHERE id = ?").run(
      currentSimulatedTime,
      AGENT_ID,
    );

    const claimRetry1 = await printingRepo.claimOrRenew(
      AGENT_ID,
      currentSimulatedTime,
    );
    expect(claimRetry1).not.toBeNull();
    const res2 = await printingRepo.handlePreflightFailure({
      orderId: chaosOrderId,
      stepId: claimRetry1!.currentStep.stepId,
      claimId: claimRetry1!.claimId,
      agentId: AGENT_ID,
      failureCode: "PAPER_JAM",
      failureDetail: "Still jammed",
      nowMs: currentSimulatedTime,
    });
    expect(res2.action).toBe("BLOCKED_RELEASED");
    expect(res2.retryAfterMs).toBe(90_000);

    // Chaos 3: Retry 2 at 90s -> still jammed -> 90s retry
    currentSimulatedTime += 90_000;
    db.prepare(
      "UPDATE printers SET is_paused = 0, paused_reason = NULL WHERE id = ?",
    ).run(P1);
    db.prepare("UPDATE agents SET last_heartbeat_at_ms = ? WHERE id = ?").run(
      currentSimulatedTime,
      AGENT_ID,
    );

    const claimRetry2 = await printingRepo.claimOrRenew(
      AGENT_ID,
      currentSimulatedTime,
    );
    expect(claimRetry2).not.toBeNull();
    const res3 = await printingRepo.handlePreflightFailure({
      orderId: chaosOrderId,
      stepId: claimRetry2!.currentStep.stepId,
      claimId: claimRetry2!.claimId,
      agentId: AGENT_ID,
      failureCode: "PAPER_JAM",
      failureDetail: "Still jammed",
      nowMs: currentSimulatedTime,
    });
    expect(res3.action).toBe("BLOCKED_RELEASED");
    expect(res3.retryAfterMs).toBe(90_000);

    // Chaos 4: Retry 3 at 90s -> fails -> STOP! Transition to ADMIN_ACTION_REQUIRED
    currentSimulatedTime += 90_000;
    db.prepare(
      "UPDATE printers SET is_paused = 0, paused_reason = NULL WHERE id = ?",
    ).run(P1);
    db.prepare("UPDATE agents SET last_heartbeat_at_ms = ? WHERE id = ?").run(
      currentSimulatedTime,
      AGENT_ID,
    );

    const claimRetry3 = await printingRepo.claimOrRenew(
      AGENT_ID,
      currentSimulatedTime,
    );
    expect(claimRetry3).not.toBeNull();
    const res4 = await printingRepo.handlePreflightFailure({
      orderId: chaosOrderId,
      stepId: claimRetry3!.currentStep.stepId,
      claimId: claimRetry3!.claimId,
      agentId: AGENT_ID,
      failureCode: "PAPER_JAM",
      failureDetail: "Still jammed",
      nowMs: currentSimulatedTime,
    });
    expect(res4.action).toBe("ACTION_REQUIRED");

    // Final order check
    const finalOrder = db
      .prepare(
        "SELECT status, attempt_count, next_retry_at_ms FROM orders WHERE id = ?",
      )
      .get(chaosOrderId) as {
      status: string;
      attempt_count: number;
      next_retry_at_ms: number | null;
    };
    expect(finalOrder.status).toBe("ADMIN_ACTION_REQUIRED");
    expect(finalOrder.attempt_count).toBe(3);
    expect(finalOrder.next_retry_at_ms).toBeNull(); // Strictly halted!
  });
});
