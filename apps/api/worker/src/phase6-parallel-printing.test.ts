import {
  readFileSync,
  rmSync,
  mkdtempSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { D1PrintingRepository } from "./printing/repository.js";
import { ExecutionJournalStore } from "../../../agent/windows/src/storage/execution-journal.js";

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
    "0018_phase6_history_cleanup.sql",
    "0023_identification_sheet_conditions.sql",
    "0024_printer_priority.sql",
    "0025_verified_printer_capabilities.sql",
    "0026_phase4_fallback_recovery.sql",
    "0027_parallel_physical_printer_locks.sql",
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

function seedAgentAndPrinters(
  rawDb: DatabaseSync,
  printers: Array<{
    id: string;
    displayName: string;
    windowsPrinterName: string;
    physicalDeviceId?: string | null;
    isDefault?: boolean;
    color?: boolean;
    duplex?: boolean;
    priority?: number;
  }>,
  nowMs = 1_000_000,
) {
  const defaultPrinterId =
    printers.find((p) => p.isDefault)?.id ?? printers[0]?.id;
  rawDb.exec(`
    INSERT OR REPLACE INTO installation (
      id, shop_name, contact_phone, address, customer_notice,
      online_printing_enabled, max_pdf_size_bytes, max_order_upload_bytes,
      identification_sheet_enabled, default_production_printer_id,
      created_at_ms, updated_at_ms
    ) VALUES (
      1, 'Test Shop', '+919876543210', 'Shop Address', 'Notice',
      1, 26214400, 104857600,
      0, ${defaultPrinterId ? `'${defaultPrinterId}'` : "NULL"},
      ${nowMs}, ${nowMs}
    );

    INSERT OR REPLACE INTO agents (
      id, display_name, credential_hash, is_active, paired_at_ms,
      last_heartbeat_at_ms, created_at_ms, updated_at_ms
    ) VALUES (
      '${AGENT_ID}', 'Counter PC', 'hash_credential', 1,
      ${nowMs}, ${nowMs}, ${nowMs}, ${nowMs}
    );
  `);

  for (const p of printers) {
    const caps = JSON.stringify({
      colour: p.color ? 1 : 0,
      duplex: p.duplex ? 1 : 0,
      paperSizes: ["A4"],
    });
    const verifiedCaps = JSON.stringify({
      verified: {
        bw: true,
        color: Boolean(p.color),
        duplex: Boolean(p.duplex),
        a4: true,
        a3: false,
      },
    });
    const enabledServices = JSON.stringify({
      bw: true,
      color: Boolean(p.color),
      duplex: Boolean(p.duplex),
      a4: true,
      a3: false,
    });
    rawDb
      .prepare(
        `
      INSERT OR REPLACE INTO printers (
        id, agent_id, display_name, windows_printer_name, enabled, status,
        is_production_eligible, is_virtual, capabilities_json, priority,
        physical_device_id, verified_capabilities_json, enabled_services_json,
        capabilities_updated_at_ms, created_at_ms, updated_at_ms
      ) VALUES (
        ?, '${AGENT_ID}', ?, ?, 1, 'ONLINE',
        1, 0, ?, ?,
        ?, ?, ?,
        ?, ?, ?
      )
    `,
      )
      .run(
        p.id,
        p.displayName,
        p.windowsPrinterName,
        caps,
        p.priority ?? 0,
        p.physicalDeviceId ?? null,
        verifiedCaps,
        enabledServices,
        nowMs,
        nowMs,
        nowMs,
      );
  }
}

function insertPaidOrder(
  rawDb: DatabaseSync,
  id: string,
  opts: {
    printerId?: string | null;
    physicalDeviceId?: string | null;
    status?: string;
    isPriority?: boolean;
    colorMode?: "BW" | "COLOR";
    sides?: "SINGLE" | "DOUBLE";
    nowMs?: number;
    fileCount?: number;
  } = {},
) {
  const now = opts.nowMs ?? 1_000_000;
  const status = opts.status ?? "QUEUED";
  const priority = opts.isPriority ? 1 : 0;
  const colorMode = opts.colorMode ?? "BW";
  const sides = opts.sides ?? "SINGLE";
  const printerIdVal = opts.printerId ? `'${opts.printerId}'` : "NULL";
  const physVal = opts.physicalDeviceId ? `'${opts.physicalDeviceId}'` : "NULL";

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

  const payId = crypto.randomUUID();

  rawDb.exec(`
    INSERT INTO orders (
      id, public_job_code, customer_name, customer_phone,
      original_filename, selected_pages, copies, color_mode, paper_size, sides,
      printing_amount_paise, service_charge_paise, total_amount_paise,
      status, is_priority, queued_at_ms, created_at_ms, updated_at_ms, cleanup_state,
      claimed_by_agent_id, claim_id, claim_expires_at_ms, claimed_at_ms,
      printer_id, physical_device_id
    ) VALUES (
      '${id}', 'PG-${id.slice(0, 6)}', 'Customer', '+919876543210',
      'doc.pdf', 'ALL', 1, '${colorMode}', 'A4', '${sides}',
      1000, 0, 1000,
      '${status}', ${priority}, ${now}, ${now}, ${now}, 'ACTIVE',
      ${claimedBy}, ${claimId}, ${claimExpires}, ${claimedAt},
      ${printerIdVal}, ${physVal}
    );

    INSERT INTO payments (
      id, order_id, provider, status, amount_paise, currency,
      provider_order_id, provider_payment_id, verified_at_ms, created_at_ms, updated_at_ms
    ) VALUES (
      '${payId}', '${id}', 'RAZORPAY', 'PAID', 1000, 'INR',
      'order_ext_${id}', 'pay_ext_${id}', ${now}, ${now}, ${now}
    );

    INSERT INTO uploads (
      id, order_id, r2_object_key, original_filename, mime_type, size_bytes,
      storage_status, uploaded_at_ms, created_at_ms, updated_at_ms
    ) VALUES (
      '${crypto.randomUUID()}', '${id}', 'uploads/${id}/doc_1.pdf', 'doc_1.pdf', 'application/pdf', 1024,
      'UPLOADED', ${now}, ${now}, ${now}
    );
  `);

  const count = opts.fileCount ?? 1;
  for (let i = 1; i <= count; i++) {
    const fileId = crypto.randomUUID();
    rawDb.exec(`
      INSERT INTO order_files (
        id, order_id, position, original_filename, r2_object_key,
        expected_size_bytes, size_bytes, source_page_count, selected_pages,
        copies, paper_size, color_mode, sides, printing_amount_paise,
        service_charge_paise, upload_status, print_status, uploaded_at_ms, created_at_ms, updated_at_ms
      ) VALUES (
        '${fileId}', '${id}', ${i}, 'doc_${i}.pdf', 'uploads/${id}/doc_${i}.pdf',
        1024, 1024, 1, 'ALL',
        1, 'A4', '${colorMode}', '${sides}', 1000,
        0, 'UPLOADED', 'PENDING', ${now}, ${now}, ${now}
      );
    `);
  }
}

describe("Phase 6: Safe Parallel Printing & Physical Printer Locking", () => {
  it("enforces physical device mutual exclusion: queues sharing the same hardware never execute concurrently", async () => {
    const rawDb = createTestDatabase();
    const d1 = asD1(rawDb);
    const repo = new D1PrintingRepository(d1);
    const nowMs = 1_000_000;

    const p1 = "00000000-0000-0000-0000-000000000011";
    const p2 = "00000000-0000-0000-0000-000000000012";

    // Two queues on the same physical device: hw-laser-1
    seedAgentAndPrinters(
      rawDb,
      [
        {
          id: p1,
          displayName: "Laser Simplex",
          windowsPrinterName: "HP_Simplex",
          physicalDeviceId: "hw-laser-1",
          isDefault: true,
          priority: 10,
        },
        {
          id: p2,
          displayName: "Laser Duplex",
          windowsPrinterName: "HP_Duplex",
          physicalDeviceId: "hw-laser-1",
          duplex: true,
          priority: 5,
        },
      ],
      nowMs,
    );

    // Order 1 is queued on p1
    insertPaidOrder(rawDb, "11111111-1111-1111-1111-111111111111", {
      printerId: p1,
      status: "QUEUED",
      nowMs,
    });

    // Order 2 is queued for the other queue on the SAME hardware
    insertPaidOrder(rawDb, "22222222-2222-2222-2222-222222222222", {
      printerId: p2,
      status: "QUEUED",
      nowMs,
    });

    // Attempting to claim for agent: only Order 1 is claimed; Order 2 CANNOT be claimed because hw-laser-1 is busy!
    const activeJobs = await repo.claimOrRenewAll(AGENT_ID, nowMs);
    expect(activeJobs).toHaveLength(1);
    expect(activeJobs[0]?.orderId).toBe("11111111-1111-1111-1111-111111111111");
    expect(activeJobs[0]?.physicalDeviceId).toBe("hw-laser-1");

    // Verify Order 2 remains safely in QUEUED state (not claimed)
    const ord2 = rawDb
      .prepare(
        "SELECT status FROM orders WHERE id = '22222222-2222-2222-2222-222222222222'",
      )
      .get() as { status: string };
    expect(ord2.status).toBe("QUEUED");
  });

  it("enforces engine-level SQLite partial unique index on orders(physical_device_id)", () => {
    const rawDb = createTestDatabase();
    const nowMs = 1_000_000;

    const p1 = "00000000-0000-0000-0000-000000000021";
    const p2 = "00000000-0000-0000-0000-000000000022";

    seedAgentAndPrinters(
      rawDb,
      [
        {
          id: p1,
          displayName: "Queue 1",
          windowsPrinterName: "Q1",
          physicalDeviceId: "hw-shared-lock",
        },
        {
          id: p2,
          displayName: "Queue 2",
          windowsPrinterName: "Q2",
          physicalDeviceId: "hw-shared-lock",
        },
      ],
      nowMs,
    );

    insertPaidOrder(rawDb, "11111111-1111-1111-1111-111111111111", {
      printerId: p1,
      physicalDeviceId: "hw-shared-lock",
      status: "PRINTING",
      nowMs,
    });

    // Direct insert of another active order with the same physical_device_id MUST fail with UNIQUE constraint
    expect(() => {
      insertPaidOrder(rawDb, "22222222-2222-2222-2222-222222222222", {
        printerId: p2,
        physicalDeviceId: "hw-shared-lock",
        status: "CLAIMED",
        nowMs,
      });
    }).toThrow(/UNIQUE constraint failed: orders\.physical_device_id/);
  });

  it("allows independent physical printers to claim and execute concurrently", async () => {
    const rawDb = createTestDatabase();
    const d1 = asD1(rawDb);
    const repo = new D1PrintingRepository(d1);
    const nowMs = 1_000_000;

    const pLaser = "00000000-0000-0000-0000-000000000031";
    const pColor = "00000000-0000-0000-0000-000000000032";

    // Two independent physical printers: hw-desk-1 and hw-desk-2
    seedAgentAndPrinters(
      rawDb,
      [
        {
          id: pLaser,
          displayName: "Laser 1",
          windowsPrinterName: "HP_Laser",
          physicalDeviceId: "hw-desk-1",
          isDefault: true,
        },
        {
          id: pColor,
          displayName: "Color 1",
          windowsPrinterName: "Canon_Color",
          physicalDeviceId: "hw-desk-2",
          color: true,
        },
      ],
      nowMs,
    );

    insertPaidOrder(rawDb, "11111111-1111-1111-1111-111111111111", {
      printerId: pLaser,
      status: "QUEUED",
      nowMs,
    });

    insertPaidOrder(rawDb, "22222222-2222-2222-2222-222222222222", {
      printerId: pColor,
      colorMode: "COLOR",
      status: "QUEUED",
      nowMs,
    });

    // Agent pulse claims all available independent jobs concurrently
    const activeJobs = await repo.claimOrRenewAll(AGENT_ID, nowMs);
    expect(activeJobs).toHaveLength(2);

    const orderIds = activeJobs.map((j) => j.orderId).sort();
    expect(orderIds).toEqual([
      "11111111-1111-1111-1111-111111111111",
      "22222222-2222-2222-2222-222222222222",
    ]);

    // Both orders are now CLAIMED with their respective physical devices
    const rows = rawDb
      .prepare("SELECT id, status, physical_device_id FROM orders ORDER BY id")
      .all() as Array<{
      id: string;
      status: string;
      physical_device_id: string;
    }>;
    expect(rows).toEqual([
      {
        id: "11111111-1111-1111-1111-111111111111",
        status: "CLAIMED",
        physical_device_id: "hw-desk-1",
      },
      {
        id: "22222222-2222-2222-2222-222222222222",
        status: "CLAIMED",
        physical_device_id: "hw-desk-2",
      },
    ]);
  });

  it("prevents head-of-line blocking: routes unassigned order to idle physical printer when default is busy (Subcase B3)", async () => {
    const rawDb = createTestDatabase();
    const d1 = asD1(rawDb);
    const repo = new D1PrintingRepository(d1);
    const nowMs = 1_000_000;

    const pDefault = "00000000-0000-0000-0000-000000000041";
    const pSecondary = "00000000-0000-0000-0000-000000000042";

    // Printer A is default on hw-device-A. Printer B is matching secondary on hw-device-B.
    seedAgentAndPrinters(
      rawDb,
      [
        {
          id: pDefault,
          displayName: "Default Printer",
          windowsPrinterName: "HP_Default",
          physicalDeviceId: "hw-device-A",
          isDefault: true,
          priority: 10,
        },
        {
          id: pSecondary,
          displayName: "Secondary Printer",
          windowsPrinterName: "HP_Secondary",
          physicalDeviceId: "hw-device-B",
          isDefault: false,
          priority: 5,
        },
      ],
      nowMs,
    );

    // Order 1 is queued on Default Printer (hw-device-A, priority 10)
    insertPaidOrder(rawDb, "11111111-1111-1111-1111-111111111111", {
      printerId: pDefault,
      status: "QUEUED",
      nowMs,
    });

    // Order 2 arrives without a predetermined printer assignment (printer_id = NULL)
    insertPaidOrder(rawDb, "22222222-2222-2222-2222-222222222222", {
      printerId: null,
      status: "QUEUED",
      nowMs,
    });

    // claimOrRenewAll should claim Order 1 on Default Printer AND claim Order 2 on Secondary printer (Subcase B3)
    const activeJobs = await repo.claimOrRenewAll(AGENT_ID, nowMs);
    expect(activeJobs).toHaveLength(2);

    const ord1Job = activeJobs.find(
      (j) => j.orderId === "11111111-1111-1111-1111-111111111111",
    );
    const ord2Job = activeJobs.find(
      (j) => j.orderId === "22222222-2222-2222-2222-222222222222",
    );

    expect(ord1Job).toBeDefined();
    expect(ord1Job?.printerId).toBe(pDefault);
    expect(ord1Job?.physicalDeviceId).toBe("hw-device-A");

    expect(ord2Job).toBeDefined();
    expect(ord2Job?.printerId).toBe(pSecondary);
    expect(ord2Job?.physicalDeviceId).toBe("hw-device-B");
  });

  it("conservatively serializes queues when physical_device_id is NULL (unknown hardware defaults to AGENT_LOCK)", async () => {
    const rawDb = createTestDatabase();
    const d1 = asD1(rawDb);
    const repo = new D1PrintingRepository(d1);
    const nowMs = 1_000_000;

    const p1 = "00000000-0000-0000-0000-000000000051";
    const p2 = "00000000-0000-0000-0000-000000000052";

    // Two printers with physical_device_id = NULL
    seedAgentAndPrinters(
      rawDb,
      [
        {
          id: p1,
          displayName: "Standalone 1",
          windowsPrinterName: "P1",
          physicalDeviceId: null,
          isDefault: true,
        },
        {
          id: p2,
          displayName: "Standalone 2",
          windowsPrinterName: "P2",
          physicalDeviceId: null,
          isDefault: false,
        },
      ],
      nowMs,
    );

    insertPaidOrder(rawDb, "11111111-1111-1111-1111-111111111111", {
      printerId: p1,
      status: "QUEUED",
      nowMs,
    });

    insertPaidOrder(rawDb, "22222222-2222-2222-2222-222222222222", {
      printerId: p2,
      status: "QUEUED",
      nowMs,
    });

    // When physical identity is unknown (NULL), it falls back to AGENT_LOCK_<agentId>.
    // Therefore, only 1 job can be claimed; the second is serialized and waits.
    const activeJobs = await repo.claimOrRenewAll(AGENT_ID, nowMs);
    expect(activeJobs).toHaveLength(1);
    expect(activeJobs[0]?.orderId).toBe("11111111-1111-1111-1111-111111111111");

    const row = rawDb
      .prepare(
        "SELECT id, physical_device_id FROM orders WHERE id = '11111111-1111-1111-1111-111111111111'",
      )
      .get() as {
      id: string;
      physical_device_id: string;
    };
    expect(row.physical_device_id).toBe(`AGENT_LOCK_${AGENT_ID}`);
  });

  it("preserves multi-file sequential order safety: order steps execute strictly in sequence number order", async () => {
    const rawDb = createTestDatabase();
    const nowMs = 1_000_000;
    const p1 = "00000000-0000-0000-0000-000000000061";

    seedAgentAndPrinters(
      rawDb,
      [
        {
          id: p1,
          displayName: "Printer 1",
          windowsPrinterName: "P1",
          physicalDeviceId: "hw-1",
          isDefault: true,
        },
      ],
      nowMs,
    );

    // Enable identification sheet so the order generates Step 1 (ID sheet) and Step 2 (Document)
    rawDb.exec(`
      UPDATE installation
      SET identification_sheet_enabled = 1,
          identification_sheet_placement = 'FIRST';
    `);

    insertPaidOrder(rawDb, "11111111-1111-1111-1111-111111111111", {
      printerId: p1,
      status: "QUEUED",
      nowMs,
    });

    const d1 = asD1(rawDb);
    const repo = new D1PrintingRepository(d1);

    // Initial claim must return step 1 (IDENTIFICATION_SHEET)
    const jobs = await repo.claimOrRenewAll(AGENT_ID, nowMs);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.currentStep.sequenceNumber).toBe(1);
    expect(jobs[0]?.currentStep.type).toBe("IDENTIFICATION_SHEET");

    // Complete step 1
    rawDb
      .prepare(
        "UPDATE print_attempt_steps SET status = 'SUCCEEDED' WHERE id = ?",
      )
      .run(jobs[0]!.currentStep.stepId);

    // Next pulse returns step 2 (CUSTOMER_DOCUMENT)
    const jobs2 = await repo.claimOrRenewAll(AGENT_ID, nowMs + 2000);
    expect(jobs2).toHaveLength(1);
    expect(jobs2[0]?.currentStep.sequenceNumber).toBe(2);
    expect(jobs2[0]?.currentStep.type).toBe("CUSTOMER_DOCUMENT");
  });

  it("ExecutionJournalStore supports per-lane journal isolation and migrates legacy active-print.json", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "printgo-lane-test-"));
    const legacyPath = path.join(tempDir, "active-print.json");
    const store = new ExecutionJournalStore(legacyPath);

    // 1. Write legacy journal entry
    const legacyEntry = {
      orderId: "legacy-order-1",
      attemptId: "att-1",
      stepId: "step-1",
      spoolerJobId: "spool-42",
      updatedAtMs: Date.now(),
    };
    writeFileSync(legacyPath, JSON.stringify(legacyEntry), "utf8");

    // 2. Perform migration
    await store.migrateLegacy();

    // Legacy file removed, new lane file created
    expect(existsSync(legacyPath)).toBe(false);
    const migratedLanePath = path.join(
      tempDir,
      "active-prints",
      "lane-legacy-order-1.json",
    );
    expect(existsSync(migratedLanePath)).toBe(true);

    // 3. Load migrated entry scoped to orderId
    const loadedLegacy = await store.load("legacy-order-1");
    expect(loadedLegacy?.spoolerJobId).toBe("spool-42");

    // 4. Save independent entry for a second order lane
    const order2Entry = {
      orderId: "order-2",
      attemptId: "att-2",
      stepId: "step-2",
      spoolerJobId: "spool-99",
      updatedAtMs: Date.now(),
    };
    await store.save(order2Entry);

    // Both lanes exist concurrently and independently
    const allLanes = await store.listAll();
    expect(allLanes).toHaveLength(2);

    // Clear lane 1 without affecting lane 2
    await store.clear("legacy-order-1");
    expect(await store.load("legacy-order-1")).toBeNull();

    const loadedOrder2 = await store.load("order-2");
    expect(loadedOrder2?.spoolerJobId).toBe("spool-99");

    // Clean up temp directory
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("handles finishOrphanedSuccess concurrently across multiple physical printers", async () => {
    const rawDb = createTestDatabase();
    const d1 = asD1(rawDb);
    const repo = new D1PrintingRepository(d1);
    const nowMs = 1_000_000;

    const p1 = "00000000-0000-0000-0000-000000000081";
    const p2 = "00000000-0000-0000-0000-000000000082";

    seedAgentAndPrinters(
      rawDb,
      [
        {
          id: p1,
          displayName: "Printer 1",
          windowsPrinterName: "P1",
          physicalDeviceId: "hw-1",
        },
        {
          id: p2,
          displayName: "Printer 2",
          windowsPrinterName: "P2",
          physicalDeviceId: "hw-2",
        },
      ],
      nowMs,
    );

    insertPaidOrder(rawDb, "11111111-1111-1111-1111-111111111111", {
      printerId: p1,
      status: "QUEUED",
      nowMs,
    });

    insertPaidOrder(rawDb, "22222222-2222-2222-2222-222222222222", {
      printerId: p2,
      status: "QUEUED",
      nowMs,
    });

    // Claim both concurrently
    const activeJobs = await repo.claimOrRenewAll(AGENT_ID, nowMs);
    expect(activeJobs).toHaveLength(2);

    // Transition orders to PRINTING with steps SUCCEEDED
    rawDb.prepare("UPDATE orders SET status = 'PRINTING'").run();
    rawDb.prepare("UPDATE print_attempts SET status = 'PRINTING'").run();
    rawDb.prepare("UPDATE print_attempt_steps SET status = 'SUCCEEDED'").run();

    // finishOrphanedSuccess marks both orders SUCCEEDED (COMPLETED) concurrently
    await repo.finishOrphanedSuccess(AGENT_ID, nowMs + 10_000);

    const rows = rawDb
      .prepare("SELECT id, status FROM orders ORDER BY id")
      .all() as Array<{
      id: string;
      status: string;
    }>;
    expect(rows).toEqual([
      { id: "11111111-1111-1111-1111-111111111111", status: "COMPLETED" },
      { id: "22222222-2222-2222-2222-222222222222", status: "COMPLETED" },
    ]);
  });

  it("maintains physical device lock when order enters unconfirmed failure states (ADMIN_ACTION_REQUIRED, RETRY_PENDING)", async () => {
    const rawDb = createTestDatabase();
    const d1 = asD1(rawDb);
    const repo = new D1PrintingRepository(d1);
    const nowMs = 1_000_000;

    const p1 = "00000000-0000-0000-0000-000000000011";

    seedAgentAndPrinters(
      rawDb,
      [
        {
          id: p1,
          displayName: "Laser",
          windowsPrinterName: "HP",
          physicalDeviceId: "hw-lock",
        },
      ],
      nowMs,
    );

    // Order 1 is in ADMIN_ACTION_REQUIRED on hw-lock
    insertPaidOrder(rawDb, "11111111-1111-1111-1111-111111111111", {
      printerId: p1,
      status: "ADMIN_ACTION_REQUIRED",
      nowMs,
    });
    // Manually set physical device ID as it is normally set during claim
    rawDb.exec(
      `UPDATE orders SET physical_device_id = 'hw-lock' WHERE id = '11111111-1111-1111-1111-111111111111'`,
    );

    // Order 2 is QUEUED for p1
    insertPaidOrder(rawDb, "22222222-2222-2222-2222-222222222222", {
      printerId: p1,
      status: "QUEUED",
      nowMs,
    });

    const claims = await repo.claimOrRenewAll(AGENT_ID, nowMs + 10);
    expect(claims).toHaveLength(0); // Order 2 should NOT be claimed because hw-lock is held by Order 1!
  });
});
