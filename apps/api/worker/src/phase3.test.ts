import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  indexToPickupCode,
  pickupCodeToIndex,
  TOTAL_PICKUP_CODES,
  toCustomerOrderStatus,
} from "@printgo/domain";
import {
  calculateDiscount,
  calculatePriorityFee,
  isIdentificationRequired,
} from "@printgo/pricing";
import { D1ConfigurationRepository } from "./config/repository.js";
import { D1CustomerRepository } from "./customer/repository.js";
import { D1DiscountRuleRepository } from "./discount-rules/repository.js";
import { D1PaymentRepository } from "./payments/repository.js";
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
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  } as unknown as D1Database;
}

function seedInstallation(db: DatabaseSync, nowMs = 1000) {
  db.prepare(
    `INSERT INTO installation (
      id, shop_name, contact_phone, address, customer_notice,
      online_printing_enabled, max_pdf_size_bytes, max_order_upload_bytes,
      identification_sheet_enabled, identification_sheet_placement,
      priority_printing_enabled, priority_fee_paise,
      id_requirement_mode, id_threshold_paise, next_pickup_code_index,
      created_at_ms, updated_at_ms
    ) VALUES (
      1, 'PrintGo Shop', '9876543210', 'Main Campus', 'Welcome',
      1, 26214400, 104857600,
      0, 'FIRST',
      1, 1500,
      'ABOVE_THRESHOLD', 50000, 0,
      ?, ?
    )`,
  ).run(nowMs, nowMs);

  db.prepare(
    `INSERT INTO print_rates (id, paper_size, color_mode, sides, price_per_page_paise, enabled, created_at_ms, updated_at_ms)
     VALUES ('10000000-0000-4000-8000-000000000001', 'A4', 'BW', 'SINGLE', 200, 1, ?, ?)`,
  ).run(nowMs, nowMs);

  db.prepare(
    `INSERT INTO file_size_service_charges (id, min_bytes_exclusive, max_bytes_inclusive, charge_paise, enabled, sort_order, created_at_ms, updated_at_ms)
     VALUES ('20000000-0000-4000-8000-000000000001', 0, 26214400, 100, 1, 1, ?, ?)`,
  ).run(nowMs, nowMs);
}

describe("Phase 3: Priority Printing", () => {
  it("calculates priority fee and prevents tampering", () => {
    // When enabled
    expect(
      calculatePriorityFee({
        isPriorityRequested: true,
        priorityPrintingEnabled: true,
        priorityFeePaise: 2000,
      }),
    ).toBe(2000);
    expect(
      calculatePriorityFee({
        isPriorityRequested: false,
        priorityPrintingEnabled: true,
        priorityFeePaise: 2000,
      }),
    ).toBe(0);
    // When disabled
    expect(
      calculatePriorityFee({
        isPriorityRequested: true,
        priorityPrintingEnabled: false,
        priorityFeePaise: 2000,
      }),
    ).toBe(0);
  });

  it("prioritizes priority orders in queue while maintaining FIFO within priority level", async () => {
    const rawDb = createTestDatabase();
    seedInstallation(rawDb, 1000);
    const d1 = asD1(rawDb);
    const printRepo = new D1PrintingRepository(d1);

    const agentId = "40000000-0000-4000-8000-000000000001";
    const printerId = "50000000-0000-4000-8000-000000000001";
    rawDb
      .prepare(
        `INSERT INTO agents (id, display_name, credential_hash, is_active, paired_at_ms, last_heartbeat_at_ms, created_at_ms, updated_at_ms)
       VALUES (?, 'Counter Agent', 'hash', 1, 1000, 2000, 1000, 1000)`,
      )
      .run(agentId);
    rawDb
      .prepare(
        `INSERT INTO printers (id, agent_id, display_name, windows_printer_name, enabled, status, is_production_eligible, is_virtual, capabilities_json, last_status_at_ms, created_at_ms, updated_at_ms)
       VALUES (?, ?, 'Laser Printer', 'HP_LaserJet', 1, 'ONLINE', 1, 0, ?, 1000, 1000, 1000)`,
      )
      .run(
        printerId,
        agentId,
        JSON.stringify({ colour: 1, duplex: 1, paperSizes: ["A4"] }),
      );

    const insertOrder = (
      id: string,
      code: string,
      isPriority: number,
      queuedAt: number,
    ) => {
      rawDb
        .prepare(
          `INSERT INTO orders (
          id, customer_name, customer_phone, original_filename,
          paper_size, color_mode, sides, total_amount_paise, printing_amount_paise,
          service_charge_paise, currency, status, public_job_code, pickup_code,
          is_priority, queued_at_ms, cleanup_state, created_at_ms, updated_at_ms
        ) VALUES (
          ?, 'Customer', '9999999999', 'test.pdf',
          'A4', 'BW', 'SINGLE', 300, 200,
          100, 'INR', 'QUEUED', ?, ?,
          ?, ?, 'ACTIVE', 1000, 1000
        )`,
        )
        .run(id, code, `P${code}`, isPriority, queuedAt);

      const fileId = crypto.randomUUID();
      rawDb
        .prepare(
          `INSERT INTO order_files (
          id, order_id, position, original_filename, r2_object_key,
          expected_size_bytes, size_bytes, mime_type, source_page_count,
          selected_pages, selected_page_count, copies, paper_size, color_mode, sides,
          printing_amount_paise, service_charge_paise, upload_status, print_status,
          uploaded_at_ms, created_at_ms, updated_at_ms
        ) VALUES (
          ?, ?, 1, 'test.pdf', ?,
          100, 100, 'application/pdf', 1,
          '1', 1, 1, 'A4', 'BW', 'SINGLE',
          200, 100, 'UPLOADED', 'PENDING',
          1000, 1000, 1000
        )`,
        )
        .run(fileId, id, `orders/${id}.pdf`);

      rawDb
        .prepare(
          `INSERT INTO uploads (
          id, order_id, r2_object_key, original_filename, size_bytes,
          mime_type, storage_status, created_at_ms, uploaded_at_ms, updated_at_ms, expected_size_bytes
        ) VALUES (
          ?, ?, ?, 'test.pdf', 100,
          'application/pdf', 'UPLOADED', 1000, 1000, 1000, 100
        )`,
        )
        .run(crypto.randomUUID(), id, `orders/${id}.pdf`);

      rawDb
        .prepare(
          `INSERT INTO payments (
          id, order_id, provider_order_id, provider_payment_id,
          amount_paise, status, verified_at_ms, created_at_ms, updated_at_ms
        ) VALUES (
          ?, ?, ?, ?,
          300, 'PAID', 1000, 1000, 1000
        )`,
        )
        .run(crypto.randomUUID(), id, `order_${id}`, `pay_${id}`);
    };

    insertOrder("60000000-0000-4000-8000-000000000001", "NORM1", 0, 1000);
    insertOrder("60000000-0000-4000-8000-000000000002", "NORM2", 0, 1100);
    insertOrder("60000000-0000-4000-8000-000000000003", "PRIO1", 1, 1200);
    insertOrder("60000000-0000-4000-8000-000000000004", "PRIO2", 1, 1300);

    // Agent claims next job: Priority order 1 (queued at 1200) must be claimed FIRST!
    const claim1 = await printRepo.claimOrRenew(agentId, 1400);
    expect(claim1).not.toBeNull();
    expect(claim1?.jobCode).toBe("PRIO1");
  });

  it("never interrupts an actively printing job when a new priority job arrives", async () => {
    const rawDb = createTestDatabase();
    seedInstallation(rawDb, 1000);
    const d1 = asD1(rawDb);
    const printRepo = new D1PrintingRepository(d1);

    const agentId = "40000000-0000-4000-8000-000000000002";
    const printerId = "50000000-0000-4000-8000-000000000002";
    rawDb
      .prepare(
        `INSERT INTO agents (id, display_name, credential_hash, is_active, paired_at_ms, last_heartbeat_at_ms, created_at_ms, updated_at_ms)
       VALUES (?, 'Counter Agent', 'hash', 1, 1000, 2000, 1000, 1000)`,
      )
      .run(agentId);
    rawDb
      .prepare(
        `INSERT INTO printers (id, agent_id, display_name, windows_printer_name, enabled, status, is_production_eligible, is_virtual, capabilities_json, last_status_at_ms, created_at_ms, updated_at_ms)
       VALUES (?, ?, 'Laser Printer', 'HP_LaserJet', 1, 'ONLINE', 1, 0, ?, 1000, 1000, 1000)`,
      )
      .run(
        printerId,
        agentId,
        JSON.stringify({ colour: 1, duplex: 1, paperSizes: ["A4"] }),
      );

    const activeOrderId = "60000000-0000-4000-8000-000000000010";
    const activeFileId = crypto.randomUUID();
    const activeAttemptId = crypto.randomUUID();
    const activeStepId = crypto.randomUUID();

    // Active order currently being printed by agent
    rawDb
      .prepare(
        `INSERT INTO orders (
        id, customer_name, customer_phone, original_filename,
        paper_size, color_mode, sides, total_amount_paise, printing_amount_paise,
        service_charge_paise, currency, status, public_job_code, pickup_code,
        is_priority, claimed_by_agent_id, claim_id, claimed_at_ms, claim_expires_at_ms,
        printer_id, queued_at_ms, cleanup_state, created_at_ms, updated_at_ms
      ) VALUES (
        ?, 'Customer', '9999999999', 'active.pdf',
        'A4', 'BW', 'SINGLE', 300, 200,
        100, 'INR', 'PRINTING', 'ACT01', 'PA-001',
        0, ?, 'claim-active-1', 1000, 70000,
        ?, 1000, 'ACTIVE', 1000, 1000
      )`,
      )
      .run(activeOrderId, agentId, printerId);

    rawDb
      .prepare(
        `INSERT INTO order_files (
        id, order_id, position, original_filename, r2_object_key,
        expected_size_bytes, size_bytes, mime_type, source_page_count,
        selected_pages, selected_page_count, copies, paper_size, color_mode, sides,
        printing_amount_paise, service_charge_paise, upload_status, print_status,
        uploaded_at_ms, created_at_ms, updated_at_ms
      ) VALUES (
        ?, ?, 1, 'active.pdf', 'orders/active.pdf',
        100, 100, 'application/pdf', 1,
        '1', 1, 1, 'A4', 'BW', 'SINGLE',
        200, 100, 'UPLOADED', 'PENDING',
        1000, 1000, 1000
      )`,
      )
      .run(activeFileId, activeOrderId);

    rawDb
      .prepare(
        `INSERT INTO print_attempts (
        id, order_id, attempt_number, agent_id, printer_id,
        status, identification_sheet_included, created_at_ms, updated_at_ms,
        order_file_id, file_position
      ) VALUES (
        ?, ?, 1, ?, ?,
        'PRINTING', 0, 1000, 1000,
        ?, 1
      )`,
      )
      .run(activeAttemptId, activeOrderId, agentId, printerId, activeFileId);

    rawDb
      .prepare(
        `INSERT INTO print_attempt_steps (
        id, print_attempt_id, order_id, sequence_number, step_type,
        status, spooler_job_id, created_at_ms, updated_at_ms
      ) VALUES (
        ?, ?, ?, 1, 'CUSTOMER_DOCUMENT',
        'SUBMITTED', 'job-1', 1000, 1000
      )`,
      )
      .run(activeStepId, activeAttemptId, activeOrderId);

    // A brand new priority order queues
    const prioOrderId = "60000000-0000-4000-8000-000000000011";
    rawDb
      .prepare(
        `INSERT INTO orders (
        id, customer_name, customer_phone, original_filename,
        paper_size, color_mode, sides, total_amount_paise, printing_amount_paise,
        service_charge_paise, currency, status, public_job_code, pickup_code,
        is_priority, queued_at_ms, cleanup_state, created_at_ms, updated_at_ms
      ) VALUES (
        ?, 'Customer VIP', '9999999999', 'prio.pdf',
        'A4', 'BW', 'SINGLE', 500, 200,
        300, 'INR', 'QUEUED', 'VIP01', 'PA-002',
        1, 1500, 'ACTIVE', 1500, 1500
      )`,
      )
      .run(prioOrderId);

    // Pulse/claim while active job is printing: Agent continues active job, never interrupted by priority order
    const pulse = await printRepo.claimOrRenew(agentId, 1600);
    expect(pulse).not.toBeNull();
    expect(pulse?.jobCode).toBe("ACT01");
  });
});

describe("Phase 3: Pickup Codes Sequence, Wrap, and Collision Avoidance", () => {
  it("correctly converts indices to codes and wraps around safely", () => {
    expect(indexToPickupCode(0)).toBe("PA-001");
    expect(indexToPickupCode(998)).toBe("PA-999");
    expect(indexToPickupCode(999)).toBe("PB-001");
    expect(indexToPickupCode(TOTAL_PICKUP_CODES - 1)).toBe("PZ-999");
    // Wrap around
    expect(indexToPickupCode(TOTAL_PICKUP_CODES)).toBe("PA-001");

    expect(pickupCodeToIndex("PA-001")).toBe(0);
    expect(pickupCodeToIndex("PA-999")).toBe(998);
    expect(pickupCodeToIndex("PB-001")).toBe(999);
    expect(pickupCodeToIndex("PZ-999")).toBe(TOTAL_PICKUP_CODES - 1);
  });

  it("avoids active pickup code collisions and increments safely", async () => {
    const rawDb = createTestDatabase();
    seedInstallation(rawDb, 1000);
    const d1 = asD1(rawDb);
    const paymentRepo = new D1PaymentRepository(d1);

    // Make PA-001 active
    rawDb
      .prepare(
        `INSERT INTO orders (
        id, customer_name, customer_phone, original_filename,
        paper_size, color_mode, sides, total_amount_paise, printing_amount_paise,
        service_charge_paise, currency, status, public_job_code, pickup_code,
        cleanup_state, queued_at_ms, created_at_ms, updated_at_ms
      ) VALUES (
        '60000000-0000-4000-8000-000000000020', 'Cust', '9999999999', 'test.pdf',
        'A4', 'BW', 'SINGLE', 300, 200,
        100, 'INR', 'QUEUED', 'JOB1', 'PA-001',
        'ACTIVE', 1000, 1000, 1000
      )`,
      )
      .run();

    // Now allocating a code must skip PA-001 and return PA-002
    const code = await (
      paymentRepo as unknown as {
        allocatePickupCode(nowMs: number): Promise<string>;
      }
    ).allocatePickupCode(2000);
    expect(code).toBe("PA-002");

    // Next code index in DB must be updated to 2 (PA-003)
    const installRow = rawDb
      .prepare(`SELECT next_pickup_code_index FROM installation WHERE id = 1`)
      .get() as { next_pickup_code_index: number };
    expect(installRow.next_pickup_code_index).toBe(2);
  });

  it("resets pickup code sequence to PA-001 without disturbing active orders", async () => {
    const rawDb = createTestDatabase();
    seedInstallation(rawDb, 1000);
    const d1 = asD1(rawDb);
    const configRepo = new D1ConfigurationRepository(d1);

    // Fast-forward next code to index 500 (PA-501)
    rawDb
      .prepare(
        `UPDATE installation SET next_pickup_code_index = 500 WHERE id = 1`,
      )
      .run();

    const resetCode = await configRepo.resetPickupCode("admin-1", 2000);
    expect(resetCode).toBe("PA-001");

    const row = rawDb
      .prepare(`SELECT next_pickup_code_index FROM installation WHERE id = 1`)
      .get() as { next_pickup_code_index: number };
    expect(row.next_pickup_code_index).toBe(0);
  });
});

describe("Phase 3: Customer Public Tracking & Status Mapping", () => {
  it("maps MANUAL_PRINT to WAITING_FOR_STAFF and AWAITING_FINISHING to FINISHING", () => {
    const manualStatus = toCustomerOrderStatus("MANUAL_PRINT");
    expect(manualStatus.code).toBe("WAITING_FOR_STAFF");
    expect(manualStatus.label).toBe("Waiting for Staff");

    const finishingStatus = toCustomerOrderStatus("AWAITING_FINISHING");
    expect(finishingStatus.code).toBe("FINISHING");
    expect(finishingStatus.label).toBe("Finishing");
  });

  it("serves public tracking by pickup code with complete privacy (no PII, no files, no amounts)", async () => {
    const rawDb = createTestDatabase();
    seedInstallation(rawDb, 1000);
    const d1 = asD1(rawDb);
    const customerRepo = new D1CustomerRepository(d1);

    // Create an order with pickup code PA-123
    rawDb
      .prepare(
        `INSERT INTO orders (
        id, customer_name, customer_phone, original_filename,
        paper_size, color_mode, sides, total_amount_paise, printing_amount_paise,
        service_charge_paise, currency, status, public_job_code, pickup_code,
        is_priority, identification_required, cleanup_state,
        queued_at_ms, created_at_ms, updated_at_ms
      ) VALUES (
        '60000000-0000-4000-8000-000000000030', 'Secret VIP Customer', '+919999988888', 'secret.pdf',
        'A4', 'BW', 'SINGLE', 5000, 4000,
        1000, 'INR', 'MANUAL_PRINT', 'JOB-PRIV-1', 'PA-123',
        1, 1, 'ACTIVE',
        1000, 1000, 1000
      )`,
      )
      .run();

    const tracking = await customerRepo.findPublicTrackingByPickupCode(
      "PA-123",
      2000,
    );
    expect(tracking).not.toBeNull();
    expect(tracking?.pickupCode).toBe("PA-123");
    expect(tracking?.status).toBe("WAITING_FOR_STAFF");
    expect(tracking?.statusLabel).toBe("Waiting for Staff");
    expect(tracking?.isPriority).toBe(true);
    expect(tracking?.identificationRequired).toBe(true);

    // Verify privacy: safe fields only
    const record = tracking as unknown as Record<string, unknown>;
    expect(record.customerName).toBeUndefined();
    expect(record.customerPhone).toBeUndefined();
    expect(record.totalAmountPaise).toBeUndefined();
    expect(record.files).toBeUndefined();
    expect(record.downloadUrl).toBeUndefined();
  });

  it("returns null when tracking an expired or non-existent order", async () => {
    const rawDb = createTestDatabase();
    seedInstallation(rawDb, 1000);
    const d1 = asD1(rawDb);
    const customerRepo = new D1CustomerRepository(d1);

    // Completed order whose purge_at_ms has expired (purge_at_ms = 1500, nowMs = 2000)
    rawDb
      .prepare(
        `INSERT INTO orders (
        id, customer_name, customer_phone, original_filename,
        paper_size, color_mode, sides, total_amount_paise, printing_amount_paise,
        service_charge_paise, currency, status, public_job_code, pickup_code,
        cleanup_state, purge_at_ms, queued_at_ms, created_at_ms, updated_at_ms
      ) VALUES (
        '60000000-0000-4000-8000-000000000040', 'Former Customer', '9999999999', 'purged.pdf',
        'A4', 'BW', 'SINGLE', 300, 200,
        100, 'INR', 'COMPLETED', 'JOB-EXPIRED', 'PA-999',
        'ACTIVE', 1500, 1000, 1000, 1000
      )`,
      )
      .run();

    const tracking = await customerRepo.findPublicTrackingByPickupCode(
      "PA-999",
      2000,
    );
    expect(tracking).toBeNull();
  });
});

describe("Phase 3: Identification Policy", () => {
  it("correctly evaluates identification requirement modes", () => {
    // OFF
    expect(
      isIdentificationRequired({
        mode: "OFF",
        thresholdPaise: 50000,
        onlineAmountPaise: 100000,
      }),
    ).toBe(false);

    // ALWAYS
    expect(
      isIdentificationRequired({
        mode: "ALWAYS",
        thresholdPaise: 50000,
        onlineAmountPaise: 100,
      }),
    ).toBe(true);

    // ABOVE_THRESHOLD
    expect(
      isIdentificationRequired({
        mode: "ABOVE_THRESHOLD",
        thresholdPaise: 50000,
        onlineAmountPaise: 49999,
      }),
    ).toBe(false);
    expect(
      isIdentificationRequired({
        mode: "ABOVE_THRESHOLD",
        thresholdPaise: 50000,
        onlineAmountPaise: 50000,
      }),
    ).toBe(true);
    expect(
      isIdentificationRequired({
        mode: "ABOVE_THRESHOLD",
        thresholdPaise: 50000,
        onlineAmountPaise: 75000,
      }),
    ).toBe(true);
  });
});

describe("Phase 3: Volume Discount Rules", () => {
  const rules = [
    { minSubtotalPaise: 50000, discountPercent: 5, enabled: true }, // > ₹500
    { minSubtotalPaise: 100000, discountPercent: 10, enabled: true }, // > ₹1000
    { minSubtotalPaise: 200000, discountPercent: 15, enabled: true }, // > ₹2000
  ];

  it("selects highest qualifying threshold and NEVER stacks discounts", () => {
    // Subtotal ₹400 -> No discount
    const d400 = calculateDiscount(40000, rules);
    expect(d400.discountAmountPaise).toBe(0);
    expect(d400.discountPercent).toBeNull();

    // Subtotal ₹750 -> 5% off ₹750 = ₹37.50 -> 3750 paise
    const d750 = calculateDiscount(75000, rules);
    expect(d750.discountAmountPaise).toBe(3750);
    expect(d750.discountPercent).toBe(5);
    expect(d750.discountThresholdPaise).toBe(50000);

    // Subtotal ₹1500 -> 10% off ₹1500 = ₹150 -> 15000 paise (does NOT stack 5% + 10%)
    const d1500 = calculateDiscount(150000, rules);
    expect(d1500.discountAmountPaise).toBe(15000);
    expect(d1500.discountPercent).toBe(10);

    // Subtotal ₹2500 -> 15% off ₹2500 = ₹375 -> 37500 paise
    const d2500 = calculateDiscount(250000, rules);
    expect(d2500.discountAmountPaise).toBe(37500);
    expect(d2500.discountPercent).toBe(15);
  });

  it("CRUD for discount rules via repository", async () => {
    const rawDb = createTestDatabase();
    seedInstallation(rawDb, 1000);
    const d1 = asD1(rawDb);
    const discountRepo = new D1DiscountRuleRepository(d1);

    // Create rule
    const created = await discountRepo.createRule(
      {
        minSubtotalPaise: 50000,
        discountPercent: 5,
        enabled: true,
      },
      1000,
    );
    expect(created.id).toBeTruthy();
    expect(created.discountPercent).toBe(5);

    // List rules
    const all = await discountRepo.listRules();
    expect(all).toHaveLength(1);

    // Toggle rule
    const toggled = await discountRepo.toggleRule(created.id, 2000);
    expect(toggled?.enabled).toBe(false);

    // Delete rule
    await discountRepo.deleteRule(created.id);

    const afterDelete = await discountRepo.listRules();
    expect(afterDelete).toHaveLength(0);
  });
});
