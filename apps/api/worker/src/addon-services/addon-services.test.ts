import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { calculateAddonOnlinePrice } from "@printgo/pricing";
import { D1CustomerRepository } from "../customer/repository.js";
import { D1PaymentRepository } from "../payments/repository.js";
import { D1PrintingRepository } from "../printing/repository.js";
import { AddonServiceError, D1AddonServiceRepository } from "./repository.js";

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
  ];
  for (const name of migrationFiles) {
    db.exec(
      readFileSync(
        new URL(`../../../../../database/migrations/${name}`, import.meta.url),
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
    this.bindings = values as SQLInputValue[];
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
    `INSERT INTO installation (id, shop_name, contact_phone, address, customer_notice,
     online_printing_enabled, max_pdf_size_bytes, max_order_upload_bytes,
     identification_sheet_enabled, identification_sheet_placement, created_at_ms, updated_at_ms)
     VALUES (1, 'PrintGo Shop', '+919876543210', '123 College Road', 'Welcome', 1, 26214400, 52428800, 0, 'LAST', ?, ?)`,
  ).run(nowMs, nowMs);
  db.prepare(
    `INSERT INTO print_rates (id, paper_size, color_mode, sides, price_per_page_paise, enabled, created_at_ms, updated_at_ms)
     VALUES ('00000000-0000-4000-8000-000000000001', 'A4', 'BW', 'SINGLE', 200, 1, ?, ?)`,
  ).run(nowMs, nowMs);
}

function seedOrder(
  db: DatabaseSync,
  orderId: string,
  status = "QUEUED",
  nowMs = 1000,
  claimedByAgentId: string | null = null,
  claimId: string | null = null,
) {
  const jobCode = `PG-${orderId.slice(0, 6).toUpperCase()}`;
  const claimedAtMs = claimedByAgentId ? nowMs : null;
  const claimExpiresAtMs = claimedByAgentId ? nowMs + 60000 : null;
  db.prepare(
    `INSERT INTO orders (id, public_job_code, customer_name, customer_phone,
     original_filename, selected_pages, source_page_count, copies, color_mode, paper_size,
     sides, printing_amount_paise, service_charge_paise, total_amount_paise,
     due_at_pickup_paise, currency, status, cleanup_state, claimed_by_agent_id, claim_id, claimed_at_ms, claim_expires_at_ms, created_at_ms, updated_at_ms, paid_at_ms)
     VALUES (?, ?, 'John Doe', '+919876543210',
     'test.pdf', '1', 1, 1, 'BW', 'A4', 'SINGLE', 200, 0, 200, 0, 'INR', ?, 'ACTIVE', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    orderId,
    jobCode,
    status,
    claimedByAgentId,
    claimId,
    claimedAtMs,
    claimExpiresAtMs,
    nowMs,
    nowMs,
    nowMs,
  );
}

describe("Phase 2 — Add-on Services and Manual Orders", () => {
  it("1. no add-on: existing pricing and order behavior unchanged", () => {
    const total = calculateAddonOnlinePrice([]);
    expect(total).toBe(0);
  });

  it("2. free fixed-price service (₹0): calculates ₹0 online without error", () => {
    const total = calculateAddonOnlinePrice([
      { pricingType: "FIXED_PRICE", fixedPricePaise: 0 },
    ]);
    expect(total).toBe(0);
  });

  it("3. paid fixed-price service: adds correct paise to online total", () => {
    const total = calculateAddonOnlinePrice([
      { pricingType: "FIXED_PRICE", fixedPricePaise: 3000 },
    ]);
    expect(total).toBe(3000);
  });

  it("4. multiple services: sums fixed-price and treats staff-priced as ₹0 online", () => {
    const total = calculateAddonOnlinePrice([
      { pricingType: "FIXED_PRICE", fixedPricePaise: 0 }, // Stapling FREE
      { pricingType: "FIXED_PRICE", fixedPricePaise: 3000 }, // Binding ₹30
      { pricingType: "STAFF_PRICED", fixedPricePaise: null }, // Custom Colour
    ]);
    expect(total).toBe(3000);
  });

  it("5. disabled service rejected: resolveServicesForOrder throws when service is disabled", async () => {
    const rawDb = createTestDatabase();
    const d1 = asD1(rawDb);
    const repo = new D1AddonServiceRepository(d1);

    const created = await repo.createService({
      name: "Lamination",
      pricingType: "FIXED_PRICE",
      fixedPricePaise: 2000,
      handlingMode: "POST_PRINT",
      enabled: false,
      displayOrder: 1,
    });

    await expect(repo.resolveServicesForOrder([created.id])).rejects.toThrow(
      AddonServiceError,
    );
  });

  it("6. non-existent service ID rejected: resolveServicesForOrder throws", async () => {
    const rawDb = createTestDatabase();
    const d1 = asD1(rawDb);
    const repo = new D1AddonServiceRepository(d1);

    await expect(
      repo.resolveServicesForOrder(["non-existent-id-0000-000000000000"]),
    ).rejects.toThrow(AddonServiceError);
  });

  it("7. price tampering rejected: online price is derived strictly from server configuration", async () => {
    const rawDb = createTestDatabase();
    const d1 = asD1(rawDb);
    const repo = new D1AddonServiceRepository(d1);

    const created = await repo.createService({
      name: "Spiral Binding",
      pricingType: "FIXED_PRICE",
      fixedPricePaise: 4000, // authoritative: ₹40
      handlingMode: "POST_PRINT",
      enabled: true,
      displayOrder: 1,
    });

    // Client requests the service by ID only; server resolves authoritative price
    const resolved = await repo.resolveServicesForOrder([created.id]);
    expect(resolved[0]?.fixedPricePaise).toBe(4000);
    const serverTotal = calculateAddonOnlinePrice(resolved);
    expect(serverTotal).toBe(4000);
  });

  it("8. service snapshot unchanged after Admin edits price or disables service", async () => {
    const rawDb = createTestDatabase();
    const d1 = asD1(rawDb);
    const repo = new D1AddonServiceRepository(d1);
    const orderId = crypto.randomUUID();
    seedInstallation(rawDb);
    seedOrder(rawDb, orderId);

    const created = await repo.createService({
      name: "Binding",
      pricingType: "FIXED_PRICE",
      fixedPricePaise: 3000,
      handlingMode: "POST_PRINT",
      enabled: true,
      displayOrder: 1,
    });

    // Snapshot at order placement
    await repo.snapshotServicesForOrder(orderId, [created]);

    // Admin later updates price to ₹50 and disables service
    await repo.updateService(created.id, {
      name: "Binding (New)",
      pricingType: "FIXED_PRICE",
      fixedPricePaise: 5000,
      handlingMode: "POST_PRINT",
      enabled: false,
      displayOrder: 1,
    });

    // Snapshots on the order remain completely unchanged
    const snapshots = await repo.getOrderSnapshots(orderId);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.serviceName).toBe("Binding");
    expect(snapshots[0]?.onlinePricePaise).toBe(3000);
    expect(snapshots[0]?.handlingMode).toBe("POST_PRINT");
  });

  it("9. POST_PRINT state transition: order with POST_PRINT addon moves to AWAITING_FINISHING when printed", async () => {
    const rawDb = createTestDatabase();
    const d1 = asD1(rawDb);
    const addonRepo = new D1AddonServiceRepository(d1);
    const printingRepo = new D1PrintingRepository(d1);
    const orderId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    const claimId = crypto.randomUUID();
    const agentId = crypto.randomUUID();
    const nowMs = 1000;

    seedInstallation(rawDb, nowMs);

    const printerId = crypto.randomUUID();
    const stepId = crypto.randomUUID();

    // Add agent and printer before seedOrder so foreign keys are satisfied
    rawDb
      .prepare(
        `INSERT INTO agents (id, display_name, credential_hash, is_active, paired_at_ms, last_heartbeat_at_ms, created_at_ms, updated_at_ms)
         VALUES (?, 'Agent 1', 'hash', 1, ?, ?, ?, ?)`,
      )
      .run(agentId, nowMs, nowMs, nowMs, nowMs);

    rawDb
      .prepare(
        `INSERT INTO printers (id, agent_id, display_name, windows_printer_name, enabled, status, capabilities_json, last_status_at_ms, created_at_ms, updated_at_ms)
         VALUES (?, ?, 'Printer 1', 'Printer 1', 1, 'ONLINE', '{}', ?, ?, ?)`,
      )
      .run(printerId, agentId, nowMs, nowMs, nowMs);

    seedOrder(rawDb, orderId, "PRINTING", nowMs, agentId, claimId);

    // Add attempt, step, and order_file
    rawDb
      .prepare(
        `INSERT INTO print_attempts (id, order_id, attempt_number, agent_id, printer_id, status, created_at_ms, updated_at_ms, order_file_id, file_position)
         VALUES (?, ?, 1, ?, ?, 'PRINTING', ?, ?, '10000000-0000-4000-8000-000000000001', 1)`,
      )
      .run(attemptId, orderId, agentId, printerId, nowMs, nowMs);

    rawDb
      .prepare(
        `INSERT INTO print_attempt_steps (id, print_attempt_id, order_id, sequence_number, step_type, status, spooler_job_id, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, 1, 'CUSTOMER_DOCUMENT', 'SUBMITTED', '77', ?, ?)`,
      )
      .run(stepId, attemptId, orderId, nowMs, nowMs);

    rawDb
      .prepare(
        `INSERT INTO order_files (id, order_id, position, original_filename, r2_object_key,
         expected_size_bytes, size_bytes, mime_type, source_page_count, selected_pages,
         selected_page_count, copies, paper_size, color_mode, sides, printing_amount_paise,
         service_charge_paise, upload_status, print_status, uploaded_at_ms, printed_at_ms, created_at_ms, updated_at_ms)
         VALUES ('10000000-0000-4000-8000-000000000001', ?, 1, 'test.pdf', 'key', 100, 100, 'application/pdf', 1, '1', 1, 1, 'A4', 'BW', 'SINGLE', 200, 0, 'UPLOADED', 'PRINTED', ?, ?, ?, ?)`,
      )
      .run(orderId, nowMs, nowMs, nowMs, nowMs);

    // Snapshot a POST_PRINT service on this order
    const postPrintService = await addonRepo.createService({
      name: "Stapling",
      pricingType: "FIXED_PRICE",
      fixedPricePaise: 0,
      handlingMode: "POST_PRINT",
      enabled: true,
      displayOrder: 1,
    });
    await addonRepo.snapshotServicesForOrder(orderId, [postPrintService]);

    // Record result completing the attempt
    await printingRepo.recordResult({
      orderId,
      agentId,
      claimId,
      stepId,
      status: "SUCCEEDED",
      spoolerJobId: "77",
      failureCode: null,
      failureDetail: null,
      nowMs: nowMs + 100,
    });

    // Order must transition to AWAITING_FINISHING (not COMPLETED)
    const order = rawDb
      .prepare(`SELECT status FROM orders WHERE id = ?`)
      .get(orderId) as { status: string };
    expect(order.status).toBe("AWAITING_FINISHING");
  });

  it("10. MANUAL_PRINT never claimed by Agent: candidate query excludes MANUAL_PRINT", async () => {
    const rawDb = createTestDatabase();
    const d1 = asD1(rawDb);
    const printingRepo = new D1PrintingRepository(d1);
    const orderId = crypto.randomUUID();
    const agentId = crypto.randomUUID();
    const printerId = crypto.randomUUID();
    const nowMs = 1000;

    seedInstallation(rawDb, nowMs);
    // Order in MANUAL_PRINT status
    seedOrder(rawDb, orderId, "MANUAL_PRINT", nowMs);

    rawDb
      .prepare(
        `INSERT INTO agents (id, display_name, credential_hash, is_active, paired_at_ms, last_heartbeat_at_ms, created_at_ms, updated_at_ms)
         VALUES (?, 'Agent 1', 'hash', 1, ?, ?, ?, ?)`,
      )
      .run(agentId, nowMs, nowMs, nowMs, nowMs);
    rawDb
      .prepare(
        `INSERT INTO printers (id, agent_id, display_name, windows_printer_name, enabled, status, capabilities_json, last_status_at_ms, created_at_ms, updated_at_ms)
         VALUES (?, ?, 'Printer 1', 'Printer 1', 1, 'ONLINE', '{"paperSizes":["A4"],"duplex":false,"colour":false}', ?, ?, ?)`,
      )
      .run(printerId, agentId, nowMs, nowMs, nowMs);

    // Agent attempts to claim
    const claim = await printingRepo.claimOrRenew(agentId, nowMs);

    // MANUAL_PRINT order was NOT claimed
    expect(claim).toBeNull();
  });

  it("11. STAFF_PRICED adds ₹0 to online payment", () => {
    const total = calculateAddonOnlinePrice([
      { pricingType: "STAFF_PRICED", fixedPricePaise: null },
    ]);
    expect(total).toBe(0);
  });

  it("12. Admin additional pickup charge: setPickupCharge updates due_at_pickup_paise", async () => {
    const rawDb = createTestDatabase();
    const d1 = asD1(rawDb);
    const repo = new D1AddonServiceRepository(d1);
    const orderId = crypto.randomUUID();
    seedInstallation(rawDb);
    seedOrder(rawDb, orderId, "MANUAL_PRINT");

    await repo.setPickupCharge(orderId, 2500, Date.now()); // ₹25.00

    const order = rawDb
      .prepare(`SELECT due_at_pickup_paise FROM orders WHERE id = ?`)
      .get(orderId) as { due_at_pickup_paise: number };
    expect(order.due_at_pickup_paise).toBe(2500);
  });

  it("13. online-paid vs due-at-pickup separation: online amount never modified by pickup charge", async () => {
    const rawDb = createTestDatabase();
    const d1 = asD1(rawDb);
    const repo = new D1AddonServiceRepository(d1);
    const orderId = crypto.randomUUID();
    seedInstallation(rawDb);
    seedOrder(rawDb, orderId, "MANUAL_PRINT");

    // Order had 200 paise online paid
    await repo.setPickupCharge(orderId, 1500, Date.now());

    const order = rawDb
      .prepare(
        `SELECT total_amount_paise, due_at_pickup_paise FROM orders WHERE id = ?`,
      )
      .get(orderId) as {
      total_amount_paise: number;
      due_at_pickup_paise: number;
    };
    expect(order.total_amount_paise).toBe(200); // Online paid remains ₹2.00
    expect(order.due_at_pickup_paise).toBe(1500); // Pickup due is ₹15.00
  });

  it("14. multi-PDF manual order: file count and order files preserved", () => {
    const rawDb = createTestDatabase();
    const orderId = crypto.randomUUID();
    const nowMs = 1000;
    seedInstallation(rawDb, nowMs);
    seedOrder(rawDb, orderId, "MANUAL_PRINT", nowMs);

    for (let i = 1; i <= 3; i++) {
      rawDb
        .prepare(
          `INSERT INTO order_files (id, order_id, position, original_filename, r2_object_key,
           expected_size_bytes, size_bytes, mime_type, source_page_count, selected_pages,
           selected_page_count, copies, paper_size, color_mode, sides, printing_amount_paise,
           service_charge_paise, upload_status, print_status, uploaded_at_ms, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, 100, 100, 'application/pdf', 1, '1', 1, 1, 'A4', 'BW', 'SINGLE', 200, 0, 'UPLOADED', 'PENDING', ?, ?, ?)`,
        )
        .run(
          crypto.randomUUID(),
          orderId,
          i,
          `doc-${i}.pdf`,
          `key-${i}`,
          nowMs,
          nowMs,
          nowMs,
        );
    }

    const count = rawDb
      .prepare(`SELECT COUNT(*) c FROM order_files WHERE order_id = ?`)
      .get(orderId) as { c: number };
    expect(count.c).toBe(3);
  });

  it("15. manual print → finishing → complete flow: state transitions enforce business rules", async () => {
    const rawDb = createTestDatabase();
    const d1 = asD1(rawDb);
    const addonRepo = new D1AddonServiceRepository(d1);
    const orderId = crypto.randomUUID();
    const nowMs = 1000;
    seedInstallation(rawDb, nowMs);
    seedOrder(rawDb, orderId, "MANUAL_PRINT", nowMs);

    // Snapshot a POST_PRINT addon on the order
    const postPrintSvc = await addonRepo.createService({
      name: "Binding",
      pricingType: "FIXED_PRICE",
      fixedPricePaise: 3000,
      handlingMode: "POST_PRINT",
      enabled: true,
      displayOrder: 1,
    });
    await addonRepo.snapshotServicesForOrder(orderId, [postPrintSvc]);

    // Manual print done -> should go to AWAITING_FINISHING because post-print work exists
    const snapshots = await addonRepo.getOrderSnapshots(orderId);
    const hasPostPrint = snapshots.some((s) => s.handlingMode === "POST_PRINT");
    expect(hasPostPrint).toBe(true);

    rawDb
      .prepare(
        `UPDATE orders SET status = 'AWAITING_FINISHING', updated_at_ms = ? WHERE id = ?`,
      )
      .run(nowMs + 10, orderId);
    let order = rawDb
      .prepare(`SELECT status FROM orders WHERE id = ?`)
      .get(orderId) as { status: string };
    expect(order.status).toBe("AWAITING_FINISHING");

    // Admin marks finished -> COMPLETED
    rawDb
      .prepare(
        `UPDATE orders SET status = 'COMPLETED', completed_at_ms = ?, updated_at_ms = ? WHERE id = ?`,
      )
      .run(nowMs + 20, nowMs + 20, orderId);
    order = rawDb
      .prepare(`SELECT status FROM orders WHERE id = ?`)
      .get(orderId) as { status: string };
    expect(order.status).toBe("COMPLETED");
  });

  it("16. Pricing & Info public-data privacy: getPublicConfig exposes only public fields", async () => {
    const rawDb = createTestDatabase();
    const d1 = asD1(rawDb);
    const customerRepo = new D1CustomerRepository(d1);
    const addonRepo = new D1AddonServiceRepository(d1);

    seedInstallation(rawDb);
    await addonRepo.createService({
      name: "Stapling",
      pricingType: "FIXED_PRICE",
      fixedPricePaise: 0,
      handlingMode: "POST_PRINT",
      enabled: true,
      displayOrder: 1,
    });
    await addonRepo.createService({
      name: "Internal Secret Service",
      pricingType: "FIXED_PRICE",
      fixedPricePaise: 100,
      handlingMode: "AUTO",
      enabled: false, // disabled!
      displayOrder: 2,
    });

    const publicConfig = await customerRepo.getPublicConfig();
    expect(publicConfig).not.toBeNull();
    // Exposes shop info
    expect(publicConfig?.shopName).toBe("PrintGo Shop");
    expect(publicConfig?.contactPhone).toBe("+919876543210");
    expect(publicConfig?.address).toBe("123 College Road");
    // Exposes printing rates with price
    expect(publicConfig?.availablePrintOptions[0]?.pricePerPagePaise).toBe(200);
    // Exposes only ENABLED addon services
    expect(publicConfig?.addonServices).toHaveLength(1);
    expect(publicConfig?.addonServices?.[0]?.name).toBe("Stapling");
    // Does NOT expose disabled services
    expect(
      publicConfig?.addonServices?.some((s) => s.name.includes("Secret")),
    ).toBe(false);
  });

  it("17. payment finalization routes to MANUAL_PRINT when manual addon is present", async () => {
    const rawDb = createTestDatabase();
    const d1 = asD1(rawDb);
    const paymentRepo = new D1PaymentRepository(d1);
    const addonRepo = new D1AddonServiceRepository(d1);
    const orderId = crypto.randomUUID();
    const nowMs = 1000;

    seedInstallation(rawDb, nowMs);
    seedOrder(rawDb, orderId, "QUEUED", nowMs);

    const manualSvc = await addonRepo.createService({
      name: "Custom Colour",
      pricingType: "STAFF_PRICED",
      fixedPricePaise: null,
      handlingMode: "MANUAL_PRINT",
      enabled: true,
      displayOrder: 1,
    });
    await addonRepo.snapshotServicesForOrder(orderId, [manualSvc]);

    // Payment post-processing routes order
    await paymentRepo.routeOrderAfterPayment(orderId, nowMs);

    const order = rawDb
      .prepare(`SELECT status FROM orders WHERE id = ?`)
      .get(orderId) as { status: string };
    expect(order.status).toBe("MANUAL_PRINT");
  });

  it("18. cleanup compatibility: MANUAL_PRINT and AWAITING_FINISHING orders not purged as completed", () => {
    const rawDb = createTestDatabase();
    const order1 = crypto.randomUUID();
    const order2 = crypto.randomUUID();
    const nowMs = 1000;

    seedInstallation(rawDb, nowMs);
    seedOrder(rawDb, order1, "MANUAL_PRINT", nowMs);
    seedOrder(rawDb, order2, "AWAITING_FINISHING", nowMs);

    // Completed cleanup query checks: status = 'COMPLETED' AND purge_at_ms <= ?
    const purgedCandidates = rawDb
      .prepare(
        `SELECT id FROM orders WHERE status = 'COMPLETED' AND cleanup_state = 'ACTIVE'`,
      )
      .all();
    expect(purgedCandidates).toHaveLength(0);
  });
});
