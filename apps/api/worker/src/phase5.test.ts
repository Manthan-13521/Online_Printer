import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { D1AgentRepository } from "./agent/repository.js";
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
    "0018_phase6_history_cleanup.sql",
    "0023_identification_sheet_conditions.sql",
    "0024_printer_priority.sql",
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
const PRIMARY_PRINTER_ID = "00000000-0000-0000-0000-000000000002";
const FALLBACK_PRINTER_ID = "00000000-0000-0000-0000-000000000003";

function seedAgentAndTwoPrinters(rawDb: DatabaseSync, nowMs = 1_000_000) {
  rawDb.exec(`
    INSERT OR REPLACE INTO installation (
      id, shop_name, contact_phone, address, customer_notice,
      online_printing_enabled, max_pdf_size_bytes, max_order_upload_bytes,
      identification_sheet_enabled, default_production_printer_id,
      created_at_ms, updated_at_ms
    ) VALUES (
      1, 'Test Shop', '+919876543210', 'Shop Address', 'Notice',
      1, 26214400, 104857600,
      0, '${PRIMARY_PRINTER_ID}',
      ${nowMs}, ${nowMs}
    );

    INSERT OR REPLACE INTO agents (id, display_name, credential_hash, is_active, paired_at_ms, last_heartbeat_at_ms, created_at_ms, updated_at_ms)
    VALUES ('${AGENT_ID}', 'Counter PC', 'hash_credential', 1, ${nowMs}, ${nowMs}, ${nowMs}, ${nowMs});

    INSERT OR REPLACE INTO printers (
      id, agent_id, display_name, windows_printer_name, enabled, status,
      is_production_eligible, is_virtual, capabilities_json, created_at_ms, updated_at_ms
    ) VALUES (
      '${PRIMARY_PRINTER_ID}', '${AGENT_ID}', 'Main HP Laser', 'HP LaserJet Pro', 1, 'ONLINE',
      1, 0, '{"colour":1,"duplex":1,"paperSizes":["A4","A3"]}', ${nowMs}, ${nowMs}
    );

    INSERT OR REPLACE INTO printers (
      id, agent_id, display_name, windows_printer_name, enabled, status,
      is_production_eligible, is_virtual, capabilities_json, created_at_ms, updated_at_ms
    ) VALUES (
      '${FALLBACK_PRINTER_ID}', '${AGENT_ID}', 'Backup Canon', 'Canon MF641', 1, 'ONLINE',
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
    nowMs?: number;
  } = {},
) {
  const now = opts.nowMs ?? 1_000_000;
  const status = opts.status ?? "QUEUED";
  const priority = opts.isPriority ? 1 : 0;
  const queuedAt = opts.queuedAtMs ?? now;

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
      id, public_job_code, customer_name, customer_phone,
      original_filename, selected_pages, copies, color_mode, paper_size, sides,
      printing_amount_paise, service_charge_paise, total_amount_paise,
      status, is_priority, queued_at_ms, created_at_ms, updated_at_ms, cleanup_state,
      claimed_by_agent_id, claim_id, claim_expires_at_ms, claimed_at_ms
    ) VALUES (
      '${id}', 'JOB-${id}', 'Alice', '+919876543210',
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

describe("Phase 5: Printer Fallback + Duplicate/Reprint Protection", () => {
  // ───────────────────────────────────────────────────────────────────
  // 1. PRINTER FALLBACK
  // ───────────────────────────────────────────────────────────────────

  it("uses primary printer when available (no fallback)", async () => {
    const rawDb = createTestDatabase();
    const d1 = asD1(rawDb);
    const repo = new D1PrintingRepository(d1);
    const nowMs = 1_000_000;
    seedAgentAndTwoPrinters(rawDb, nowMs);

    // Configure fallback: primary → fallback, auto enabled
    rawDb.exec(`
      UPDATE printers SET fallback_printer_id = '${FALLBACK_PRINTER_ID}', auto_fallback_enabled = 1
      WHERE id = '${PRIMARY_PRINTER_ID}'
    `);

    insertPaidOrder(rawDb, "11111111-1111-1111-1111-111111111111", { nowMs });

    const job = await repo.claimOrRenew(AGENT_ID, nowMs);
    expect(job).not.toBeNull();
    expect(job!.printerId).toBe(PRIMARY_PRINTER_ID);

    // Verify no fallback provenance recorded
    const attempt = rawDb
      .prepare(
        "SELECT fallback_from_printer_id FROM print_attempts WHERE order_id = ?",
      )
      .get("11111111-1111-1111-1111-111111111111") as {
      fallback_from_printer_id: string | null;
    };
    expect(attempt.fallback_from_printer_id).toBeNull();
  });

  it("falls back to secondary when primary is paused", async () => {
    const rawDb = createTestDatabase();
    const d1 = asD1(rawDb);
    const repo = new D1PrintingRepository(d1);
    const nowMs = 1_000_000;
    seedAgentAndTwoPrinters(rawDb, nowMs);

    // Configure fallback
    rawDb.exec(`
      UPDATE printers SET fallback_printer_id = '${FALLBACK_PRINTER_ID}', auto_fallback_enabled = 1
      WHERE id = '${PRIMARY_PRINTER_ID}'
    `);

    // Pause the primary printer
    rawDb.exec(`
      UPDATE printers SET is_paused = 1, paused_reason = 'PAPER_JAM'
      WHERE id = '${PRIMARY_PRINTER_ID}'
    `);

    insertPaidOrder(rawDb, "22222222-2222-2222-2222-222222222222", { nowMs });

    const job = await repo.claimOrRenew(AGENT_ID, nowMs);
    expect(job).not.toBeNull();
    expect(job!.printerId).toBe(FALLBACK_PRINTER_ID);

    // Verify fallback provenance
    const attempt = rawDb
      .prepare(
        "SELECT fallback_from_printer_id FROM print_attempts WHERE order_id = ?",
      )
      .get("22222222-2222-2222-2222-222222222222") as {
      fallback_from_printer_id: string | null;
    };
    expect(attempt.fallback_from_printer_id).toBe(PRIMARY_PRINTER_ID);
  });

  it("falls back to secondary when primary is offline", async () => {
    const rawDb = createTestDatabase();
    const d1 = asD1(rawDb);
    const repo = new D1PrintingRepository(d1);
    const nowMs = 1_000_000;
    seedAgentAndTwoPrinters(rawDb, nowMs);

    // Configure fallback
    rawDb.exec(`
      UPDATE printers SET fallback_printer_id = '${FALLBACK_PRINTER_ID}', auto_fallback_enabled = 1
      WHERE id = '${PRIMARY_PRINTER_ID}'
    `);

    // Primary goes offline
    rawDb.exec(`
      UPDATE printers SET status = 'OFFLINE' WHERE id = '${PRIMARY_PRINTER_ID}'
    `);

    insertPaidOrder(rawDb, "33333333-3333-3333-3333-333333333333", { nowMs });

    const job = await repo.claimOrRenew(AGENT_ID, nowMs);
    expect(job).not.toBeNull();
    expect(job!.printerId).toBe(FALLBACK_PRINTER_ID);
  });

  it("does NOT fallback when auto_fallback_enabled is OFF", async () => {
    const rawDb = createTestDatabase();
    const d1 = asD1(rawDb);
    const repo = new D1PrintingRepository(d1);
    const nowMs = 1_000_000;
    seedAgentAndTwoPrinters(rawDb, nowMs);

    // Configure fallback but leave auto OFF
    rawDb.exec(`
      UPDATE printers SET fallback_printer_id = '${FALLBACK_PRINTER_ID}', auto_fallback_enabled = 0
      WHERE id = '${PRIMARY_PRINTER_ID}'
    `);

    // Pause primary
    rawDb.exec(`
      UPDATE printers SET is_paused = 1 WHERE id = '${PRIMARY_PRINTER_ID}'
    `);

    insertPaidOrder(rawDb, "44444444-4444-4444-4444-444444444444", { nowMs });

    // No fallback: job stays queued
    const job = await repo.claimOrRenew(AGENT_ID, nowMs);
    expect(job).toBeNull();
  });

  it("does NOT fallback when fallback printer is also unavailable", async () => {
    const rawDb = createTestDatabase();
    const d1 = asD1(rawDb);
    const repo = new D1PrintingRepository(d1);
    const nowMs = 1_000_000;
    seedAgentAndTwoPrinters(rawDb, nowMs);

    // Configure fallback
    rawDb.exec(`
      UPDATE printers SET fallback_printer_id = '${FALLBACK_PRINTER_ID}', auto_fallback_enabled = 1
      WHERE id = '${PRIMARY_PRINTER_ID}'
    `);

    // Both printers paused
    rawDb.exec(`
      UPDATE printers SET is_paused = 1 WHERE id = '${PRIMARY_PRINTER_ID}';
      UPDATE printers SET is_paused = 1 WHERE id = '${FALLBACK_PRINTER_ID}';
    `);

    insertPaidOrder(rawDb, "55555555-5555-5555-5555-555555555555", { nowMs });

    const job = await repo.claimOrRenew(AGENT_ID, nowMs);
    expect(job).toBeNull();
  });

  it("prevents fallback loop (A → B → A)", async () => {
    const rawDb = createTestDatabase();
    const d1 = asD1(rawDb);
    const repo = new D1PrintingRepository(d1);
    const nowMs = 1_000_000;
    seedAgentAndTwoPrinters(rawDb, nowMs);

    // Create A→B and B→A circular fallback config
    rawDb.exec(`
      UPDATE printers SET fallback_printer_id = '${FALLBACK_PRINTER_ID}', auto_fallback_enabled = 1
      WHERE id = '${PRIMARY_PRINTER_ID}';
      UPDATE printers SET fallback_printer_id = '${PRIMARY_PRINTER_ID}', auto_fallback_enabled = 1
      WHERE id = '${FALLBACK_PRINTER_ID}';
    `);

    // Pause primary
    rawDb.exec(`
      UPDATE printers SET is_paused = 1 WHERE id = '${PRIMARY_PRINTER_ID}'
    `);

    insertPaidOrder(rawDb, "66666666-6666-6666-6666-666666666666", { nowMs });

    // The fallback printer (B) has B→A configured. The candidate query
    // filters out B because COALESCE(B.fallback_printer_id,'') <> primary_id
    // would be FALSE (B's fallback IS the primary), preventing the loop.
    const job = await repo.claimOrRenew(AGENT_ID, nowMs);
    expect(job).toBeNull();
  });

  it("does NOT move active/COMPLETION_UNKNOWN jobs to fallback", async () => {
    const rawDb = createTestDatabase();
    const d1 = asD1(rawDb);
    const repo = new D1PrintingRepository(d1);
    const nowMs = 1_000_000;
    seedAgentAndTwoPrinters(rawDb, nowMs);

    // Insert orders in non-claimable states
    insertPaidOrder(rawDb, "77777777-7777-7777-7777-777777777777", {
      status: "COMPLETION_UNKNOWN",
      nowMs,
    });

    // Configure fallback
    rawDb.exec(`
      UPDATE printers SET fallback_printer_id = '${FALLBACK_PRINTER_ID}', auto_fallback_enabled = 1
      WHERE id = '${PRIMARY_PRINTER_ID}';
      UPDATE printers SET is_paused = 1 WHERE id = '${PRIMARY_PRINTER_ID}';
    `);

    // COMPLETION_UNKNOWN is not in ('QUEUED', 'RETRY_PENDING'), so it will NOT be claimed
    const job = await repo.claimOrRenew(AGENT_ID, nowMs);
    expect(job).toBeNull();
  });

  it("falls back only when fallback has compatible capabilities", async () => {
    const rawDb = createTestDatabase();
    const d1 = asD1(rawDb);
    const repo = new D1PrintingRepository(d1);
    const nowMs = 1_000_000;
    seedAgentAndTwoPrinters(rawDb, nowMs);

    // Remove A3 from fallback capabilities
    rawDb.exec(`
      UPDATE printers SET capabilities_json = '{"colour":1,"duplex":1,"paperSizes":["A4"]}'
      WHERE id = '${FALLBACK_PRINTER_ID}';
      UPDATE printers SET fallback_printer_id = '${FALLBACK_PRINTER_ID}', auto_fallback_enabled = 1
      WHERE id = '${PRIMARY_PRINTER_ID}';
      UPDATE printers SET is_paused = 1 WHERE id = '${PRIMARY_PRINTER_ID}';
    `);

    // Insert A3 order
    const fileId = crypto.randomUUID();
    const uploadId = crypto.randomUUID();
    const payId = crypto.randomUUID();
    const orderId = "88888888-8888-8888-8888-888888888888";
    rawDb.exec(`
      INSERT INTO orders (
        id, public_job_code, customer_name, customer_phone,
        original_filename, selected_pages, copies, color_mode, paper_size, sides,
        printing_amount_paise, service_charge_paise, total_amount_paise,
        status, queued_at_ms, created_at_ms, updated_at_ms, cleanup_state
      ) VALUES (
        '${orderId}', 'JOB-A3', 'Alice', '+919876543210',
        'big_doc.pdf', 'ALL', 1, 'BW', 'A3', 'SINGLE',
        2000, 0, 2000,
        'QUEUED', ${nowMs}, ${nowMs}, ${nowMs}, 'ACTIVE'
      );
      INSERT INTO payments (
        id, order_id, provider, status, amount_paise, currency,
        provider_order_id, provider_payment_id, verified_at_ms, created_at_ms, updated_at_ms
      ) VALUES (
        '${payId}', '${orderId}', 'RAZORPAY', 'PAID', 2000, 'INR',
        'order_ext_a3', 'pay_ext_a3', ${nowMs}, ${nowMs}, ${nowMs}
      );
      INSERT INTO order_files (
        id, order_id, position, original_filename, r2_object_key,
        expected_size_bytes, size_bytes, source_page_count, selected_pages,
        copies, paper_size, color_mode, sides, printing_amount_paise,
        service_charge_paise, upload_status, print_status, uploaded_at_ms, created_at_ms, updated_at_ms
      ) VALUES (
        '${fileId}', '${orderId}', 1, 'big_doc.pdf', 'uploads/${orderId}/doc.pdf',
        2048, 2048, 1, 'ALL',
        1, 'A3', 'BW', 'SINGLE', 2000,
        0, 'UPLOADED', 'PENDING', ${nowMs}, ${nowMs}, ${nowMs}
      );
      INSERT INTO uploads (
        id, order_id, r2_object_key, original_filename, mime_type, size_bytes,
        storage_status, uploaded_at_ms, created_at_ms, updated_at_ms
      ) VALUES (
        '${uploadId}', '${orderId}', 'uploads/${orderId}/doc.pdf', 'big_doc.pdf', 'application/pdf', 2048,
        'UPLOADED', ${nowMs}, ${nowMs}, ${nowMs}
      );
    `);

    // Fallback doesn't support A3 → job stays queued
    const job = await repo.claimOrRenew(AGENT_ID, nowMs);
    expect(job).toBeNull();
  });

  // ───────────────────────────────────────────────────────────────────
  // 2. ADMIN FALLBACK CONFIGURATION
  // ───────────────────────────────────────────────────────────────────

  it("Admin can configure and remove fallback printer", async () => {
    const rawDb = createTestDatabase();
    const d1 = asD1(rawDb);
    const agentRepo = new D1AgentRepository(d1);
    const nowMs = 1_000_000;
    seedAgentAndTwoPrinters(rawDb, nowMs);

    // Configure fallback
    const result = await agentRepo.configureFallback({
      printerId: PRIMARY_PRINTER_ID,
      fallbackPrinterId: FALLBACK_PRINTER_ID,
      autoFallbackEnabled: true,
      adminId: "admin_1",
      nowMs,
    });
    expect(result.printerId).toBe(PRIMARY_PRINTER_ID);
    expect(result.fallbackPrinterId).toBe(FALLBACK_PRINTER_ID);
    expect(result.autoFallbackEnabled).toBe(true);

    // Verify DB
    const row = rawDb
      .prepare(
        "SELECT fallback_printer_id, auto_fallback_enabled FROM printers WHERE id = ?",
      )
      .get(PRIMARY_PRINTER_ID) as {
      fallback_printer_id: string;
      auto_fallback_enabled: number;
    };
    expect(row.fallback_printer_id).toBe(FALLBACK_PRINTER_ID);
    expect(row.auto_fallback_enabled).toBe(1);

    // Remove fallback
    const removed = await agentRepo.configureFallback({
      printerId: PRIMARY_PRINTER_ID,
      fallbackPrinterId: null,
      autoFallbackEnabled: false,
      adminId: "admin_1",
      nowMs: nowMs + 100,
    });
    expect(removed.fallbackPrinterId).toBeNull();
    expect(removed.autoFallbackEnabled).toBe(false);
  });

  it("rejects self-reference fallback", async () => {
    const rawDb = createTestDatabase();
    const d1 = asD1(rawDb);
    const agentRepo = new D1AgentRepository(d1);
    const nowMs = 1_000_000;
    seedAgentAndTwoPrinters(rawDb, nowMs);

    await expect(
      agentRepo.configureFallback({
        printerId: PRIMARY_PRINTER_ID,
        fallbackPrinterId: PRIMARY_PRINTER_ID,
        autoFallbackEnabled: true,
        adminId: "admin_1",
        nowMs,
      }),
    ).rejects.toThrow("FALLBACK_SELF_REFERENCE");
  });

  it("rejects non-existent fallback printer", async () => {
    const rawDb = createTestDatabase();
    const d1 = asD1(rawDb);
    const agentRepo = new D1AgentRepository(d1);
    const nowMs = 1_000_000;
    seedAgentAndTwoPrinters(rawDb, nowMs);

    await expect(
      agentRepo.configureFallback({
        printerId: PRIMARY_PRINTER_ID,
        fallbackPrinterId: "00000000-0000-0000-0000-nonexistent",
        autoFallbackEnabled: true,
        adminId: "admin_1",
        nowMs,
      }),
    ).rejects.toThrow("FALLBACK_PRINTER_NOT_FOUND");
  });

  it("rejects circular fallback loop at configuration time", async () => {
    const rawDb = createTestDatabase();
    const d1 = asD1(rawDb);
    const agentRepo = new D1AgentRepository(d1);
    const nowMs = 1_000_000;
    seedAgentAndTwoPrinters(rawDb, nowMs);

    // First: set fallback B → A
    await agentRepo.configureFallback({
      printerId: FALLBACK_PRINTER_ID,
      fallbackPrinterId: PRIMARY_PRINTER_ID,
      autoFallbackEnabled: true,
      adminId: "admin_1",
      nowMs,
    });

    // Then: try to set A → B (which would create A→B→A)
    await expect(
      agentRepo.configureFallback({
        printerId: PRIMARY_PRINTER_ID,
        fallbackPrinterId: FALLBACK_PRINTER_ID,
        autoFallbackEnabled: true,
        adminId: "admin_1",
        nowMs: nowMs + 100,
      }),
    ).rejects.toThrow("FALLBACK_LOOP_DETECTED");
  });

  it("fallback fields appear in listAgentsWithPrinters", async () => {
    const rawDb = createTestDatabase();
    const d1 = asD1(rawDb);
    const agentRepo = new D1AgentRepository(d1);
    const nowMs = 1_000_000;
    seedAgentAndTwoPrinters(rawDb, nowMs);

    rawDb.exec(`
      UPDATE printers SET fallback_printer_id = '${FALLBACK_PRINTER_ID}', auto_fallback_enabled = 1
      WHERE id = '${PRIMARY_PRINTER_ID}'
    `);

    const agents = await agentRepo.listAgentsWithPrinters(nowMs);
    const primary = agents[0]?.printers.find(
      (p) => p.id === PRIMARY_PRINTER_ID,
    );
    expect(primary?.fallbackPrinterId).toBe(FALLBACK_PRINTER_ID);
    expect(primary?.autoFallbackEnabled).toBe(true);

    const fallback = agents[0]?.printers.find(
      (p) => p.id === FALLBACK_PRINTER_ID,
    );
    expect(fallback?.fallbackPrinterId).toBeNull();
    expect(fallback?.autoFallbackEnabled).toBe(false);
  });

  // ───────────────────────────────────────────────────────────────────
  // 3. DUPLICATE/REPRINT PROTECTION
  // ───────────────────────────────────────────────────────────────────

  it("recordSubmission is idempotent for same spooler job ID", async () => {
    const rawDb = createTestDatabase();
    const d1 = asD1(rawDb);
    const repo = new D1PrintingRepository(d1);
    const nowMs = 1_000_000;
    seedAgentAndTwoPrinters(rawDb, nowMs);

    insertPaidOrder(rawDb, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", { nowMs });

    const job = await repo.claimOrRenew(AGENT_ID, nowMs);
    expect(job).not.toBeNull();

    await repo.startStep({
      orderId: job!.orderId,
      stepId: job!.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: job!.claimId,
      nowMs,
    });

    // First submission
    const sub1 = await repo.recordSubmission({
      orderId: job!.orderId,
      stepId: job!.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: job!.claimId,
      spoolerJobId: "spool-100",
      nowMs: nowMs + 100,
    });
    expect(sub1).not.toBeNull();

    // Duplicate submission with same spooler job ID = idempotent
    const sub2 = await repo.recordSubmission({
      orderId: job!.orderId,
      stepId: job!.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: job!.claimId,
      spoolerJobId: "spool-100",
      nowMs: nowMs + 200,
    });
    expect(sub2).not.toBeNull();
    expect(sub2!.step_status).toBe("SUBMITTED");
  });

  it("recordResult SUCCEEDED is idempotent", async () => {
    const rawDb = createTestDatabase();
    const d1 = asD1(rawDb);
    const repo = new D1PrintingRepository(d1);
    const nowMs = 1_000_000;
    seedAgentAndTwoPrinters(rawDb, nowMs);

    insertPaidOrder(rawDb, "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", { nowMs });

    const job = await repo.claimOrRenew(AGENT_ID, nowMs);
    expect(job).not.toBeNull();

    await repo.startStep({
      orderId: job!.orderId,
      stepId: job!.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: job!.claimId,
      nowMs,
    });
    await repo.recordSubmission({
      orderId: job!.orderId,
      stepId: job!.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: job!.claimId,
      spoolerJobId: "spool-200",
      nowMs: nowMs + 100,
    });

    // First success
    const res1 = await repo.recordResult({
      orderId: job!.orderId,
      stepId: job!.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: job!.claimId,
      spoolerJobId: "spool-200",
      status: "SUCCEEDED",
      failureCode: null,
      failureDetail: null,
      nowMs: nowMs + 200,
    });
    expect(res1).not.toBeNull();

    // Duplicate success acknowledgement = safe
    const res2 = await repo.recordResult({
      orderId: job!.orderId,
      stepId: job!.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: job!.claimId,
      spoolerJobId: "spool-200",
      status: "SUCCEEDED",
      failureCode: null,
      failureDetail: null,
      nowMs: nowMs + 300,
    });
    expect(res2).not.toBeNull();

    // Order should be COMPLETED (only once)
    const order = rawDb
      .prepare("SELECT status FROM orders WHERE id = ?")
      .get("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb") as { status: string };
    expect(order.status).toBe("COMPLETED");
  });

  it("retryOrder creates new attempt, does not duplicate old", async () => {
    const rawDb = createTestDatabase();
    const d1 = asD1(rawDb);
    const repo = new D1PrintingRepository(d1);
    const nowMs = 1_000_000;
    seedAgentAndTwoPrinters(rawDb, nowMs);

    insertPaidOrder(rawDb, "cccccccc-cccc-cccc-cccc-cccccccccccc", { nowMs });

    // Claim, start, fail
    const job = await repo.claimOrRenew(AGENT_ID, nowMs);
    expect(job).not.toBeNull();
    await repo.startStep({
      orderId: job!.orderId,
      stepId: job!.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: job!.claimId,
      nowMs,
    });
    await repo.recordResult({
      orderId: job!.orderId,
      stepId: job!.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: job!.claimId,
      spoolerJobId: null,
      status: "FAILED",
      failureCode: "UNKNOWN",
      failureDetail: "test failure",
      nowMs: nowMs + 100,
    });

    // Wait for retry, fail again x2 to reach NEEDS_ADMIN
    for (let i = 0; i < 2; i++) {
      const iterNow = nowMs + 20_000 * (i + 1);
      // keep agent alive
      rawDb.exec(
        `UPDATE agents SET last_heartbeat_at_ms = ${iterNow} WHERE id = '${AGENT_ID}'`,
      );

      const retryJob = await repo.claimOrRenew(AGENT_ID, iterNow);
      if (retryJob) {
        await repo.startStep({
          orderId: retryJob.orderId,
          stepId: retryJob.currentStep.stepId,
          agentId: AGENT_ID,
          claimId: retryJob.claimId,
          nowMs: iterNow + 100,
        });
        await repo.recordResult({
          orderId: retryJob.orderId,
          stepId: retryJob.currentStep.stepId,
          agentId: AGENT_ID,
          claimId: retryJob.claimId,
          spoolerJobId: null,
          status: "FAILED",
          failureCode: "UNKNOWN",
          failureDetail: "test failure",
          nowMs: iterNow + 200,
        });
      }
    }

    const needsAdmin = rawDb
      .prepare("SELECT status, attempt_count FROM orders WHERE id = ?")
      .get("cccccccc-cccc-cccc-cccc-cccccccccccc") as {
      status: string;
      attempt_count: number;
    };
    expect(needsAdmin.status).toBe("NEEDS_ADMIN");
    expect(needsAdmin.attempt_count).toBe(3);

    // Admin retries → new attempt with fresh attempt_count
    const laterNow = nowMs + 100_000;
    rawDb.exec(
      `UPDATE agents SET last_heartbeat_at_ms = ${laterNow} WHERE id = '${AGENT_ID}'`,
    );

    await repo.retryOrder({
      orderId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
      adminId: "admin_1",
      nowMs: laterNow,
    });

    const reset = rawDb
      .prepare("SELECT status, attempt_count FROM orders WHERE id = ?")
      .get("cccccccc-cccc-cccc-cccc-cccccccccccc") as {
      status: string;
      attempt_count: number;
    };
    expect(reset.status).toBe("QUEUED");
    expect(reset.attempt_count).toBe(0);

    // New claim creates a new print_attempt (different attempt_id)
    const newJob = await repo.claimOrRenew(AGENT_ID, laterNow + 100);
    expect(newJob).not.toBeNull();
    expect(newJob!.orderId).toBe("cccccccc-cccc-cccc-cccc-cccccccccccc");
    expect(newJob!.attemptId).not.toBe(job!.attemptId);

    // Count total attempts: should be at least 4 (3 failed + 1 new)
    const attempts = rawDb
      .prepare("SELECT COUNT(*) count FROM print_attempts WHERE order_id = ?")
      .get("cccccccc-cccc-cccc-cccc-cccccccccccc") as { count: number };
    expect(attempts.count).toBeGreaterThanOrEqual(4);
  });

  it("COMPLETION_UNKNOWN requires forceUncertain to reprint", async () => {
    const rawDb = createTestDatabase();
    const d1 = asD1(rawDb);
    const repo = new D1PrintingRepository(d1);
    const nowMs = 1_000_000;
    seedAgentAndTwoPrinters(rawDb, nowMs);

    insertPaidOrder(rawDb, "dddddddd-dddd-dddd-dddd-dddddddddddd", { nowMs });

    const job = await repo.claimOrRenew(AGENT_ID, nowMs);
    await repo.startStep({
      orderId: job!.orderId,
      stepId: job!.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: job!.claimId,
      nowMs,
    });
    await repo.recordResult({
      orderId: job!.orderId,
      stepId: job!.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: job!.claimId,
      spoolerJobId: null,
      status: "UNCERTAIN",
      failureCode: "UNKNOWN",
      failureDetail: "Agent restart",
      nowMs: nowMs + 100,
    });

    const order = rawDb
      .prepare("SELECT status FROM orders WHERE id = ?")
      .get("dddddddd-dddd-dddd-dddd-dddddddddddd") as { status: string };
    expect(order.status).toBe("COMPLETION_UNKNOWN");

    // Without forceUncertain → error (prevents accidental duplicate print)
    await expect(
      repo.retryOrder({
        orderId: "dddddddd-dddd-dddd-dddd-dddddddddddd",
        adminId: "admin_1",
        forceUncertain: false,
        nowMs: nowMs + 200,
      }),
    ).rejects.toThrow("UNCERTAIN_RETRY_CONFIRMATION_REQUIRED");

    await expect(
      repo.manualComplete({
        orderId: "dddddddd-dddd-dddd-dddd-dddddddddddd",
        adminId: "admin_1",
        nowMs: nowMs + 250,
      }),
    ).rejects.toThrow("ORDER_CONFIRMATION_REQUIRED");

    // Admin confirms via manualComplete → COMPLETED without reprint
    await repo.manualComplete({
      orderId: "dddddddd-dddd-dddd-dddd-dddddddddddd",
      adminId: "admin_1",
      reason: "Confirmed physically printed",
      nowMs: nowMs + 300,
    });

    const completed = rawDb
      .prepare("SELECT status, purge_at_ms FROM orders WHERE id = ?")
      .get("dddddddd-dddd-dddd-dddd-dddddddddddd") as {
      status: string;
      purge_at_ms: number;
    };
    expect(completed.status).toBe("COMPLETED");
    expect(completed.purge_at_ms).toBe(nowMs + 300 + 7_200_000);
    expect(
      rawDb
        .prepare("SELECT status FROM print_attempt_steps WHERE order_id = ?")
        .get("dddddddd-dddd-dddd-dddd-dddddddddddd"),
    ).toEqual({ status: "UNCERTAIN" });
  });

  it("keeps POST_PRINT work open after staff confirms an uncertain print", async () => {
    const rawDb = createTestDatabase();
    const repo = new D1PrintingRepository(asD1(rawDb));
    const nowMs = 1_000_000;
    seedAgentAndTwoPrinters(rawDb, nowMs);
    const id = "d1000000-dddd-dddd-dddd-dddddddddddd";
    insertPaidOrder(rawDb, id, { status: "COMPLETION_UNKNOWN", nowMs });
    const serviceId = "d2000000-dddd-dddd-dddd-dddddddddddd";
    rawDb
      .prepare(
        `INSERT INTO addon_services (id, name, pricing_type,
      fixed_price_paise, handling_mode, created_at_ms, updated_at_ms)
      VALUES (?, 'Binding', 'FIXED_PRICE', 500, 'POST_PRINT', ?, ?)`,
      )
      .run(serviceId, nowMs, nowMs);
    rawDb
      .prepare(
        `INSERT INTO order_addon_services (order_id, service_id,
      snapshot_name, snapshot_pricing_type, snapshot_price_charged_online_paise,
      snapshot_handling_mode) VALUES (?, ?, 'Binding', 'FIXED_PRICE', 500, 'POST_PRINT')`,
      )
      .run(id, serviceId);
    expect(
      await repo.manualComplete({
        orderId: id,
        adminId: "admin_1",
        reason: "All pages physically verified",
        nowMs: nowMs + 100,
      }),
    ).toEqual({ orderId: id, status: "AWAITING_FINISHING" });
    expect(
      rawDb
        .prepare("SELECT status, purge_at_ms FROM orders WHERE id = ?")
        .get(id),
    ).toEqual({ status: "AWAITING_FINISHING", purge_at_ms: null });
  });

  // ───────────────────────────────────────────────────────────────────
  // 4. CLEANUP SAFETY
  // ───────────────────────────────────────────────────────────────────

  it("COMPLETION_UNKNOWN and fallback-unresolved jobs do NOT start cleanup timer", () => {
    const rawDb = createTestDatabase();
    const nowMs = 1_000_000;
    seedAgentAndTwoPrinters(rawDb, nowMs);

    insertPaidOrder(rawDb, "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", {
      status: "COMPLETION_UNKNOWN",
      nowMs,
    });
    insertPaidOrder(rawDb, "ffffffff-ffff-ffff-ffff-ffffffffffff", {
      status: "NEEDS_ADMIN",
      nowMs,
    });
    insertPaidOrder(rawDb, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", {
      status: "PRINT_BLOCKED",
      nowMs,
    });

    const orders = rawDb
      .prepare("SELECT id, purge_at_ms FROM orders WHERE id IN (?, ?, ?)")
      .all(
        "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
        "ffffffff-ffff-ffff-ffff-ffffffffffff",
        "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      ) as Array<{ id: string; purge_at_ms: number | null }>;

    for (const o of orders) {
      expect(o.purge_at_ms).toBeNull();
    }
  });

  // ───────────────────────────────────────────────────────────────────
  // 5. MIGRATION SAFETY
  // ───────────────────────────────────────────────────────────────────

  it("migration 0017 applies cleanly and existing orders work unchanged", async () => {
    const rawDb = createTestDatabase();
    const d1 = asD1(rawDb);
    const repo = new D1PrintingRepository(d1);
    const nowMs = 1_000_000;
    seedAgentAndTwoPrinters(rawDb, nowMs);

    // Existing order (no fallback configured) works exactly as before
    insertPaidOrder(rawDb, "99999999-9999-9999-9999-999999999999", { nowMs });

    const job = await repo.claimOrRenew(AGENT_ID, nowMs);
    expect(job).not.toBeNull();
    expect(job!.printerId).toBe(PRIMARY_PRINTER_ID);

    // Complete it
    await repo.startStep({
      orderId: job!.orderId,
      stepId: job!.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: job!.claimId,
      nowMs,
    });
    await repo.recordSubmission({
      orderId: job!.orderId,
      stepId: job!.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: job!.claimId,
      spoolerJobId: "spool-99",
      nowMs: nowMs + 100,
    });
    await repo.recordResult({
      orderId: job!.orderId,
      stepId: job!.currentStep.stepId,
      agentId: AGENT_ID,
      claimId: job!.claimId,
      spoolerJobId: "spool-99",
      status: "SUCCEEDED",
      failureCode: null,
      failureDetail: null,
      nowMs: nowMs + 200,
    });

    const order = rawDb
      .prepare("SELECT status FROM orders WHERE id = ?")
      .get("99999999-9999-9999-9999-999999999999") as { status: string };
    expect(order.status).toBe("COMPLETED");
  });
});
