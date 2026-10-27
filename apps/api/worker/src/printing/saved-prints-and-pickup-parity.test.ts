import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { D1PrintingRepository } from "./repository.js";
import { D1SavedPrintsRepository } from "../saved-prints/repository.js";
import { D1AgentRepository } from "../agent/repository.js";
import { RetentionService } from "../retention/service.js";
import { D1RetentionRepository } from "../retention/repository.js";

const migrationFiles = readdirSync(
  new URL("../../../../../database/migrations", import.meta.url),
)
  .filter((f) => f.endsWith(".sql"))
  .sort();

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
    this.values = values as SQLInputValue[];
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
    return Promise.resolve(
      (this.db.prepare(this.sql).get(...this.values) as T | undefined) ?? null,
    );
  }
  all<T>(): Promise<D1Result<T>> {
    return Promise.resolve({
      success: true,
      meta: { changes: 0 },
      results: this.db.prepare(this.sql).all(...this.values) as T[],
    } as unknown as D1Result<T>);
  }
}

function asD1(db: DatabaseSync): D1Database {
  let batchLock: Promise<void> = Promise.resolve();
  return {
    prepare: (sql: string) => new Statement(db, sql),
    async batch(statements: Statement[]) {
      const previous = batchLock;
      let release!: () => void;
      batchLock = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      db.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
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

const mockIds = {
  agent: "44444444-4444-4444-4444-444444444444",
  printer: "55555555-5555-5555-5555-555555555555",
  savedDoc: "66666666-6666-4666-8666-666666666666",
  adminUser: "77777777-7777-4777-8777-777777777777",
};

describe("Saved Prints and Pick Up Tomorrow Parity Verification", () => {
  let db: DatabaseSync;
  let d1: D1Database;
  let printRepo: D1PrintingRepository;
  let savedRepo: D1SavedPrintsRepository;
  let agentRepo: D1AgentRepository;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    for (const migration of migrations) {
      db.exec(migration);
    }
    d1 = asD1(db);
    printRepo = new D1PrintingRepository(d1);
    savedRepo = new D1SavedPrintsRepository(d1);
    agentRepo = new D1AgentRepository(d1);

    const now = 100_000;
    // Seed installation
    db.prepare(
      `INSERT INTO installation (id, shop_name, identification_sheet_enabled,
       identification_sheet_placement, pickup_auto_print_enabled, pickup_at_opening_enabled,
       created_at_ms, updated_at_ms) VALUES (1, 'PrintGo Test Shop', 0, 'LAST', 0, 1, ?, ?)`,
    ).run(now, now);

    // Seed active agent and healthy printer
    db.prepare(
      `INSERT INTO agents (id, display_name, credential_hash, is_active, paired_at_ms,
       last_heartbeat_at_ms, created_at_ms, updated_at_ms) VALUES (?, 'Shop Agent', 'hash-test', 1, ?, ?, ?, ?)`,
    ).run(mockIds.agent, now, now, now, now);

    db.prepare(
      `INSERT INTO printers (id, agent_id, display_name, windows_printer_name,
       enabled, status, is_production_eligible, is_virtual, capabilities_json,
       last_status_at_ms, created_at_ms, updated_at_ms)
       VALUES (?, ?, 'Canon Laser', 'Canon_LBP_2900', 1, 'ONLINE', 1, 0, ?, ?, ?, ?)`,
    ).run(
      mockIds.printer,
      mockIds.agent,
      JSON.stringify({ colour: true, duplex: true, paperSizes: ["A4", "A3"] }),
      now,
      now,
      now,
    );

    // Seed a saved print master template
    db.prepare(
      `INSERT INTO saved_prints (id, name, original_filename, r2_object_key,
       file_size_bytes, page_count, created_at_ms, updated_at_ms)
       VALUES (?, 'Rental Agreement', 'agreement.pdf', 'saved-prints/doc-1.pdf', 1048576, 4, ?, ?)`,
    ).run(mockIds.savedDoc, now, now);
  });

  afterEach(() => {
    db.close();
  });

  it("1. Successfully creates a Saved Print order without D1 CHECK constraint violations", async () => {
    const now = 105_000;
    const result = await savedRepo.createSavedPrintOrder({
      documentId: mockIds.savedDoc,
      adminId: mockIds.adminUser,
      copies: 2,
      pageRange: "1-4",
      paperSize: "A4",
      colorMode: "BW",
      sides: "DOUBLE",
      nowMs: now,
    });

    expect(result.orderId).toBeDefined();
    expect(result.jobCode).toBeDefined();

    const order = db
      .prepare(
        `SELECT id, order_type, admin_authorized_by, customer_name, customer_phone, status, is_pickup
         FROM orders WHERE id = ?`,
      )
      .get(result.orderId) as {
      id: string;
      order_type: string;
      admin_authorized_by: string;
      customer_name: string;
      customer_phone: string;
      status: string;
      is_pickup: number;
    };

    expect(order.order_type).toBe("SAVED_PRINT");
    expect(order.admin_authorized_by).toBe(mockIds.adminUser);
    expect(order.customer_phone).toBe("SHOP_ADMIN");
    expect(order.status).toBe("QUEUED");
    expect(order.is_pickup).toBe(0);

    const file = db
      .prepare(
        `SELECT id, original_filename, r2_object_key, upload_status, print_status, copies, sides
         FROM order_files WHERE order_id = ?`,
      )
      .get(result.orderId) as {
      id: string;
      original_filename: string;
      r2_object_key: string;
      upload_status: string;
      print_status: string;
      copies: number;
      sides: string;
    };

    expect(file.print_status).toBe("PENDING");
    expect(file.upload_status).toBe("UPLOADED");
    expect(file.copies).toBe(2);
    expect(file.sides).toBe("DOUBLE");
  });

  it("2. Agent claims authorized Saved Print order without requiring payment row", async () => {
    const now = 110_000;
    const { orderId } = await savedRepo.createSavedPrintOrder({
      documentId: mockIds.savedDoc,
      adminId: mockIds.adminUser,
      copies: 1,
      pageRange: "ALL",
      paperSize: "A4",
      colorMode: "BW",
      sides: "SINGLE",
      nowMs: now,
    });

    // Verify agent claims the job
    const claimedJobs = await printRepo.claimOrRenewAll(mockIds.agent, now);
    expect(claimedJobs.length).toBe(1);
    expect(claimedJobs[0]?.orderId).toBe(orderId);
    expect(claimedJobs[0]?.objectKey).toBe("saved-prints/doc-1.pdf");
    expect(claimedJobs[0]?.copies).toBe(1);

    const updatedOrder = db
      .prepare(`SELECT status, claimed_by_agent_id FROM orders WHERE id = ?`)
      .get(orderId) as { status: string; claimed_by_agent_id: string };
    expect(updatedOrder.status).toBe("CLAIMED");
    expect(updatedOrder.claimed_by_agent_id).toBe(mockIds.agent);
  });

  it("3. Unpaid CUSTOMER order is strictly rejected from claim", async () => {
    const now = 115_000;
    const customerOrderId = "11111111-2222-4333-8444-555555555555";
    const fileId = "22222222-3333-4444-8555-666666666666";

    db.prepare(
      `INSERT INTO orders (id, order_type, customer_name, customer_phone, original_filename,
       source_page_count, selected_pages, copies, paper_size, color_mode, sides,
       printing_amount_paise, service_charge_paise, discount_amount_paise, total_amount_paise,
       currency, status, queued_at_ms, created_at_ms, updated_at_ms,
       public_job_code, cleanup_state, is_pickup)
       VALUES (?, 'CUSTOMER', 'Customer Unpaid', '+919876543210', 'unpaid.pdf',
       2, 'ALL', 1, 'A4', 'BW', 'SINGLE', 200, 0, 0, 200, 'INR', 'QUEUED', ?, ?, ?, 'JOB-UNPAID', 'ACTIVE', 0)`,
    ).run(customerOrderId, now, now, now);

    db.prepare(
      `INSERT INTO order_files (id, order_id, position, original_filename, r2_object_key,
       expected_size_bytes, size_bytes, source_page_count, selected_pages, selected_page_count,
       copies, paper_size, color_mode, sides, upload_status, print_status, uploaded_at_ms, created_at_ms, updated_at_ms)
       VALUES (?, ?, 1, 'unpaid.pdf', 'uploads/unpaid.pdf', 500, 500, 2, 'ALL', 2, 1, 'A4', 'BW', 'SINGLE', 'UPLOADED', 'PENDING', ?, ?, ?)`,
    ).run(fileId, customerOrderId, now, now, now);

    db.prepare(
      `INSERT INTO uploads (id, order_id, r2_object_key, original_filename, storage_status,
       retention_reason, delete_after_ms, expected_size_bytes, size_bytes, uploaded_at_ms, created_at_ms, updated_at_ms)
       VALUES (?, ?, 'uploads/unpaid.pdf', 'unpaid.pdf', 'UPLOADED', 'UNRESOLVED_PAID_FAILURE', ?, 500, 500, ?, ?, ?)`,
    ).run(crypto.randomUUID(), customerOrderId, now + 3600_000, now, now, now);

    // Agent attempts to claim
    const claimed = await printRepo.claimOrRenewAll(mockIds.agent, now);
    expect(claimed.length).toBe(0);

    const orderRow = db
      .prepare(`SELECT status FROM orders WHERE id = ?`)
      .get(customerOrderId) as { status: string };
    expect(orderRow.status).toBe("QUEUED");
  });

  it("4. Master Saved Print PDF is protected from retention deletion upon job completion", async () => {
    const createdTime = 100_000;
    const now = 200_000;
    const { orderId } = await savedRepo.createSavedPrintOrder({
      documentId: mockIds.savedDoc,
      adminId: mockIds.adminUser,
      copies: 1,
      pageRange: "ALL",
      paperSize: "A4",
      colorMode: "BW",
      sides: "SINGLE",
      nowMs: createdTime,
    });

    // Simulate order completed and retention window passed
    db.prepare(
      `UPDATE orders SET status = 'COMPLETED', updated_at_ms = ? WHERE id = ?`,
    ).run(now, orderId);
    db.prepare(
      `UPDATE uploads SET retention_reason = 'COMPLETED', delete_after_ms = ? WHERE order_id = ?`,
    ).run(now - 1_000, orderId);

    const deleteSpy = vi.fn().mockResolvedValue(undefined);
    const mockBucket = {
      delete: deleteSpy,
    } as unknown as R2Bucket;

    const retentionRepo = new D1RetentionRepository(d1);
    const retentionService = new RetentionService(
      retentionRepo,
      mockBucket,
      () => now,
    );

    await retentionService.runCleanup();
    // Verify R2 bucket delete was NEVER called for saved-prints/
    expect(deleteSpy).not.toHaveBeenCalled();

    // Verify master template record in saved_prints table is intact
    const masterDoc = db
      .prepare(`SELECT r2_object_key FROM saved_prints WHERE id = ?`)
      .get(mockIds.savedDoc) as { r2_object_key: string };
    expect(masterDoc.r2_object_key).toBe("saved-prints/doc-1.pdf");
  });

  it("5. Pickup order with Auto Print OFF holds until Admin clicks Print Now", async () => {
    const now = 130_000;
    const pickupOrderId = "33333333-4444-4555-8666-777777777777";
    const tomorrowOpeningMs = now + 12 * 3600 * 1000;

    // Create a paid pickup order scheduled for tomorrow
    db.prepare(
      `INSERT INTO orders (id, order_type, customer_name, customer_phone, original_filename,
       source_page_count, selected_pages, copies, paper_size, color_mode, sides,
       printing_amount_paise, service_charge_paise, discount_amount_paise, total_amount_paise,
       currency, status, queued_at_ms, created_at_ms, updated_at_ms,
       public_job_code, pickup_code, cleanup_state, is_pickup, pickup_target_time_ms, pickup_manual_print_requested)
       VALUES (?, 'CUSTOMER', 'Pickup Customer', '+919876543210', 'pickup.pdf',
       1, 'ALL', 1, 'A4', 'BW', 'SINGLE', 100, 0, 0, 100, 'INR', 'QUEUED', ?, ?, ?, 'JOB-PICKUP-1', 'PA-001', 'ACTIVE', 1, ?, 0)`,
    ).run(pickupOrderId, now, now, now, tomorrowOpeningMs);

    db.prepare(
      `INSERT INTO order_files (id, order_id, position, original_filename, r2_object_key,
       expected_size_bytes, size_bytes, source_page_count, selected_pages, selected_page_count,
       copies, paper_size, color_mode, sides, upload_status, print_status, uploaded_at_ms, created_at_ms, updated_at_ms)
       VALUES (?, ?, 1, 'pickup.pdf', 'uploads/pickup.pdf', 500, 500, 1, 'ALL', 1, 1, 'A4', 'BW', 'SINGLE', 'UPLOADED', 'PENDING', ?, ?, ?)`,
    ).run(crypto.randomUUID(), pickupOrderId, now, now, now);

    db.prepare(
      `INSERT INTO uploads (id, order_id, r2_object_key, original_filename, storage_status,
       retention_reason, delete_after_ms, expected_size_bytes, size_bytes, uploaded_at_ms, created_at_ms, updated_at_ms)
       VALUES (?, ?, 'uploads/pickup.pdf', 'pickup.pdf', 'UPLOADED', 'COMPLETED', ?, 500, 500, ?, ?, ?)`,
    ).run(crypto.randomUUID(), pickupOrderId, now + 3600_000, now, now, now);

    db.prepare(
      `INSERT INTO payments (id, order_id, amount_paise, currency, status, provider,
       provider_order_id, provider_payment_id, verified_at_ms, created_at_ms, updated_at_ms)
       VALUES (?, ?, 100, 'INR', 'PAID', 'RAZORPAY', 'p_order_pickup_1', 'pay_pickup_1', ?, ?, ?)`,
    ).run(crypto.randomUUID(), pickupOrderId, now, now, now);

    // Auto print is OFF (default). Check has_print_work:
    const agentBefore = await agentRepo.findAgentByCredentialHash(
      "hash-test",
      now,
    );
    expect(agentBefore?.hasPrintWork).toBe(false);

    // Agent attempts claim: Should claim nothing
    const emptyClaim = await printRepo.claimOrRenewAll(mockIds.agent, now);
    expect(emptyClaim.length).toBe(0);

    // Admin clicks "Print Now"
    await printRepo.requestPickupManualPrint(
      pickupOrderId,
      mockIds.adminUser,
      now,
    );

    // Now has_print_work should be true
    const agentAfter = await agentRepo.findAgentByCredentialHash(
      "hash-test",
      now,
    );
    expect(agentAfter?.hasPrintWork).toBe(true);

    // Agent claims work: Successfully claimed!
    const claimed = await printRepo.claimOrRenewAll(mockIds.agent, now);
    expect(claimed.length).toBe(1);
    expect(claimed[0]?.orderId).toBe(pickupOrderId);
  });

  it("6. Pickup order with Auto Print ON respects pickup target opening time", async () => {
    const now = 140_000;
    const pickupOrderId = "88888888-4444-4555-8666-999999999999";
    const tomorrowOpeningMs = now + 12 * 3600 * 1000;

    // Enable Auto Print
    db.prepare(
      `UPDATE installation SET pickup_auto_print_enabled = 1 WHERE id = 1`,
    ).run();

    // Create paid pickup order for tomorrow
    db.prepare(
      `INSERT INTO orders (id, order_type, customer_name, customer_phone, original_filename,
       source_page_count, selected_pages, copies, paper_size, color_mode, sides,
       printing_amount_paise, service_charge_paise, discount_amount_paise, total_amount_paise,
       currency, status, queued_at_ms, created_at_ms, updated_at_ms,
       public_job_code, pickup_code, cleanup_state, is_pickup, pickup_target_time_ms, pickup_manual_print_requested)
       VALUES (?, 'CUSTOMER', 'Scheduled Customer', '+919876543210', 'sched.pdf',
       1, 'ALL', 1, 'A4', 'BW', 'SINGLE', 100, 0, 0, 100, 'INR', 'QUEUED', ?, ?, ?, 'JOB-SCHED-1', 'PA-002', 'ACTIVE', 1, ?, 0)`,
    ).run(pickupOrderId, now, now, now, tomorrowOpeningMs);

    db.prepare(
      `INSERT INTO order_files (id, order_id, position, original_filename, r2_object_key,
       expected_size_bytes, size_bytes, source_page_count, selected_pages, selected_page_count,
       copies, paper_size, color_mode, sides, upload_status, print_status, uploaded_at_ms, created_at_ms, updated_at_ms)
       VALUES (?, ?, 1, 'sched.pdf', 'uploads/sched.pdf', 500, 500, 1, 'ALL', 1, 1, 'A4', 'BW', 'SINGLE', 'UPLOADED', 'PENDING', ?, ?, ?)`,
    ).run(crypto.randomUUID(), pickupOrderId, now, now, now);

    db.prepare(
      `INSERT INTO uploads (id, order_id, r2_object_key, original_filename, storage_status,
       retention_reason, delete_after_ms, expected_size_bytes, size_bytes, uploaded_at_ms, created_at_ms, updated_at_ms)
       VALUES (?, ?, 'uploads/sched.pdf', 'sched.pdf', 'UPLOADED', 'COMPLETED', ?, 500, 500, ?, ?, ?)`,
    ).run(crypto.randomUUID(), pickupOrderId, now + 3600_000, now, now, now);

    db.prepare(
      `INSERT INTO payments (id, order_id, amount_paise, currency, status, provider,
       provider_order_id, provider_payment_id, verified_at_ms, created_at_ms, updated_at_ms)
       VALUES (?, ?, 100, 'INR', 'PAID', 'RAZORPAY', 'p_order_sched_1', 'pay_sched_1', ?, ?, ?)`,
    ).run(crypto.randomUUID(), pickupOrderId, now, now, now);

    // At night (now < tomorrowOpeningMs): Order is held
    const nightAgent = await agentRepo.findAgentByCredentialHash(
      "hash-test",
      now,
    );
    expect(nightAgent?.hasPrintWork).toBe(false);

    const nightClaim = await printRepo.claimOrRenewAll(mockIds.agent, now);
    expect(nightClaim.length).toBe(0);

    // In the morning when target opening time arrives (now = tomorrowOpeningMs):
    // Agent reconnects and sends heartbeat
    db.prepare(`UPDATE agents SET last_heartbeat_at_ms = ? WHERE id = ?`).run(
      tomorrowOpeningMs,
      mockIds.agent,
    );
    const morningAgent = await agentRepo.findAgentByCredentialHash(
      "hash-test",
      tomorrowOpeningMs,
    );
    expect(morningAgent?.hasPrintWork).toBe(true);

    const morningClaim = await printRepo.claimOrRenewAll(
      mockIds.agent,
      tomorrowOpeningMs,
    );
    expect(morningClaim.length).toBe(1);
    expect(morningClaim[0]?.orderId).toBe(pickupOrderId);
  });

  it("7. Normal customer orders continue to execute without regression or extra latency", async () => {
    const now = 150_000;
    const normalOrderId = "99999999-9999-4999-8999-999999999999";

    db.prepare(
      `INSERT INTO orders (id, order_type, customer_name, customer_phone, original_filename,
       source_page_count, selected_pages, copies, paper_size, color_mode, sides,
       printing_amount_paise, service_charge_paise, discount_amount_paise, total_amount_paise,
       currency, status, queued_at_ms, created_at_ms, updated_at_ms,
       public_job_code, cleanup_state, is_pickup)
       VALUES (?, 'CUSTOMER', 'Regular Customer', '+919876543210', 'regular.pdf',
       1, 'ALL', 1, 'A4', 'BW', 'SINGLE', 100, 0, 0, 100, 'INR', 'QUEUED', ?, ?, ?, 'JOB-REG-1', 'ACTIVE', 0)`,
    ).run(normalOrderId, now, now, now);

    db.prepare(
      `INSERT INTO order_files (id, order_id, position, original_filename, r2_object_key,
       expected_size_bytes, size_bytes, source_page_count, selected_pages, selected_page_count,
       copies, paper_size, color_mode, sides, upload_status, print_status, uploaded_at_ms, created_at_ms, updated_at_ms)
       VALUES (?, ?, 1, 'regular.pdf', 'uploads/regular.pdf', 500, 500, 1, 'ALL', 1, 1, 'A4', 'BW', 'SINGLE', 'UPLOADED', 'PENDING', ?, ?, ?)`,
    ).run(crypto.randomUUID(), normalOrderId, now, now, now);

    db.prepare(
      `INSERT INTO uploads (id, order_id, r2_object_key, original_filename, storage_status,
       retention_reason, delete_after_ms, expected_size_bytes, size_bytes, uploaded_at_ms, created_at_ms, updated_at_ms)
       VALUES (?, ?, 'uploads/regular.pdf', 'regular.pdf', 'UPLOADED', 'COMPLETED', ?, 500, 500, ?, ?, ?)`,
    ).run(crypto.randomUUID(), normalOrderId, now + 3600_000, now, now, now);

    db.prepare(
      `INSERT INTO payments (id, order_id, amount_paise, currency, status, provider,
       provider_order_id, provider_payment_id, verified_at_ms, created_at_ms, updated_at_ms)
       VALUES (?, ?, 100, 'INR', 'PAID', 'RAZORPAY', 'p_order_reg_1', 'pay_reg_1', ?, ?, ?)`,
    ).run(crypto.randomUUID(), normalOrderId, now, now, now);

    const agent = await agentRepo.findAgentByCredentialHash("hash-test", now);
    expect(agent?.hasPrintWork).toBe(true);

    const claimed = await printRepo.claimOrRenewAll(mockIds.agent, now);
    expect(claimed.length).toBe(1);
    expect(claimed[0]?.orderId).toBe(normalOrderId);
  });

  it("8. Saved PDF printing preserves custom copies, page range, duplex, and color mode", async () => {
    const now = 160_000;
    const { orderId } = await savedRepo.createSavedPrintOrder({
      documentId: mockIds.savedDoc,
      adminId: mockIds.adminUser,
      copies: 5,
      pageRange: "2-3",
      paperSize: "A4",
      colorMode: "COLOR",
      sides: "DOUBLE",
      nowMs: now,
    });

    const claimed = await printRepo.claimOrRenewAll(mockIds.agent, now);
    expect(claimed.length).toBe(1);
    expect(claimed[0]?.orderId).toBe(orderId);
    expect(claimed[0]?.copies).toBe(5);
    expect(claimed[0]?.pageRange).toBe("2-3");
    expect(claimed[0]?.colorMode).toBe("COLOR");
    expect(claimed[0]?.sides).toBe("DOUBLE");
  });

  it("9. Offline printer recovery: queue holds jobs while printer is offline and resumes on recovery", async () => {
    const now = 170_000;
    // Set printer status to OFFLINE
    db.prepare(`UPDATE printers SET status = 'OFFLINE' WHERE id = ?`).run(
      mockIds.printer,
    );

    const { orderId } = await savedRepo.createSavedPrintOrder({
      documentId: mockIds.savedDoc,
      adminId: mockIds.adminUser,
      copies: 1,
      pageRange: "ALL",
      paperSize: "A4",
      colorMode: "BW",
      sides: "SINGLE",
      nowMs: now,
    });

    // Printer offline: claim returns empty
    const offlineClaim = await printRepo.claimOrRenewAll(mockIds.agent, now);
    expect(offlineClaim.length).toBe(0);

    // Printer recovers ONLINE
    db.prepare(`UPDATE printers SET status = 'ONLINE' WHERE id = ?`).run(
      mockIds.printer,
    );

    // Recheck: claim succeeds
    const recoveredClaim = await printRepo.claimOrRenewAll(mockIds.agent, now);
    expect(recoveredClaim.length).toBe(1);
    expect(recoveredClaim[0]?.orderId).toBe(orderId);
  });

  it("10. Multiple Print Now requests are idempotent and never trigger duplicate claims", async () => {
    const now = 180_000;
    const pickupOrderId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const tomorrowOpeningMs = now + 12 * 3600 * 1000;

    db.prepare(
      `INSERT INTO orders (id, order_type, customer_name, customer_phone, original_filename,
       source_page_count, selected_pages, copies, paper_size, color_mode, sides,
       printing_amount_paise, service_charge_paise, discount_amount_paise, total_amount_paise,
       currency, status, queued_at_ms, created_at_ms, updated_at_ms,
       public_job_code, pickup_code, cleanup_state, is_pickup, pickup_target_time_ms, pickup_manual_print_requested)
       VALUES (?, 'CUSTOMER', 'Multi-click Customer', '+919876543210', 'doc.pdf',
       1, 'ALL', 1, 'A4', 'BW', 'SINGLE', 100, 0, 0, 100, 'INR', 'QUEUED', ?, ?, ?, 'JOB-MULTI-1', 'PA-003', 'ACTIVE', 1, ?, 0)`,
    ).run(pickupOrderId, now, now, now, tomorrowOpeningMs);

    db.prepare(
      `INSERT INTO order_files (id, order_id, position, original_filename, r2_object_key,
       expected_size_bytes, size_bytes, source_page_count, selected_pages, selected_page_count,
       copies, paper_size, color_mode, sides, upload_status, print_status, uploaded_at_ms, created_at_ms, updated_at_ms)
       VALUES (?, ?, 1, 'doc.pdf', 'uploads/doc.pdf', 500, 500, 1, 'ALL', 1, 1, 'A4', 'BW', 'SINGLE', 'UPLOADED', 'PENDING', ?, ?, ?)`,
    ).run(crypto.randomUUID(), pickupOrderId, now, now, now);

    db.prepare(
      `INSERT INTO uploads (id, order_id, r2_object_key, original_filename, storage_status,
       retention_reason, delete_after_ms, expected_size_bytes, size_bytes, uploaded_at_ms, created_at_ms, updated_at_ms)
       VALUES (?, ?, 'uploads/doc.pdf', 'doc.pdf', 'UPLOADED', 'COMPLETED', ?, 500, 500, ?, ?, ?)`,
    ).run(crypto.randomUUID(), pickupOrderId, now + 3600_000, now, now, now);

    db.prepare(
      `INSERT INTO payments (id, order_id, amount_paise, currency, status, provider,
       provider_order_id, provider_payment_id, verified_at_ms, created_at_ms, updated_at_ms)
       VALUES (?, ?, 100, 'INR', 'PAID', 'RAZORPAY', 'p_order_multi_1', 'pay_multi_1', ?, ?, ?)`,
    ).run(crypto.randomUUID(), pickupOrderId, now, now, now);

    // Click Print Now twice
    await printRepo.requestPickupManualPrint(
      pickupOrderId,
      mockIds.adminUser,
      now,
    );
    await printRepo.requestPickupManualPrint(
      pickupOrderId,
      mockIds.adminUser,
      now + 100,
    );

    // Only one claim occurs
    const claimed = await printRepo.claimOrRenewAll(mockIds.agent, now);
    expect(claimed.length).toBe(1);
    expect(claimed[0]?.orderId).toBe(pickupOrderId);

    // Print attempts table has exactly 1 attempt
    const attempts = db
      .prepare(
        `SELECT COUNT(*) as count FROM print_attempts WHERE order_id = ?`,
      )
      .get(pickupOrderId) as { count: number };
    expect(attempts.count).toBe(1);
  });
});
