/* eslint-disable */
import { describe, expect, it, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { D1PrintingRepository } from "./repository";
import { RecoveryController } from "./recovery-controller";

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
  "0019_phase7_restore_hot_indexes.sql",
  "0020_order_retention_duration.sql",
  "0021_daily_order_stats.sql",
  "0022_phase2_recovery_foundation.sql",
];

import fs from "fs";
import path from "path";

function runMigrations(db: DatabaseSync) {
  for (const file of migrationFiles) {
    const p = path.join(__dirname, "../../../../../database/migrations", file);
    const sql = fs.readFileSync(p, "utf-8");
    db.exec(sql);
  }
}

describe("RecoveryController", () => {
  let db: DatabaseSync;
  let d1Db: any;
  let printingRepo: D1PrintingRepository;
  let controller: RecoveryController;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    runMigrations(db);
    d1Db = {
      prepare: (query: string) => {
        return {
          bind: (...params: any[]) => {
            return {
              isSelect: query.trim().toUpperCase().startsWith("SELECT"),
              query,
              params,
              first: async () => db.prepare(query).get(...params),
              all: async () => ({ results: db.prepare(query).all(...params) }),
              run: async () => {
                const res = db.prepare(query).run(...params);
                return { meta: { changes: res.changes } };
              },
            };
          },
          isSelect: query.trim().toUpperCase().startsWith("SELECT"),
          query,
          params: [],
          first: async () => db.prepare(query).get(),
          all: async () => ({ results: db.prepare(query).all() }),
          run: async () => {
            const res = db.prepare(query).run();
            return { meta: { changes: res.changes } };
          },
        };
      },
      batch: async (statements: any[]) => {
        const results = [];
        db.exec("BEGIN");
        for (const s of statements) {
          if (s.isSelect) {
            results.push({ results: db.prepare(s.query).all(...s.params) });
          } else {
            const r = db.prepare(s.query).run(...(s.params || []));
            results.push({ meta: { changes: r.changes } });
          }
        }
        db.exec("COMMIT");
        return results;
      },
    };

    printingRepo = new D1PrintingRepository(d1Db);
    controller = new RecoveryController(printingRepo);

    db.prepare(
      `INSERT INTO installation (id, shop_name, default_production_printer_id, created_at_ms, updated_at_ms) VALUES (1, 'Test Shop', '00000000-0000-0000-0000-000000000002', 100, 100)`,
    ).run();
    db.prepare(
      `INSERT INTO agents (id, display_name, is_active, credential_hash, paired_at_ms, last_heartbeat_at_ms, created_at_ms, updated_at_ms) VALUES ('00000000-0000-0000-0000-000000000001', 'Agent 1', 1, 'hash', 100, 100, 100, 100)`,
    ).run();
    db.prepare(
      `INSERT INTO printers (id, agent_id, display_name, windows_printer_name, enabled, status, is_production_eligible, is_virtual, created_at_ms, updated_at_ms) VALUES ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'Printer 1', 'WIN_P1', 1, 'ONLINE', 1, 0, 100, 100)`,
    ).run();
  });

  const adminId = "admin1";

  it("blocks recovery when Agent is offline or stale", async () => {
    db.prepare(
      `UPDATE agents SET is_active = 0 WHERE id = '00000000-0000-0000-0000-000000000001'`,
    ).run();
    const status = await controller.getSystemStatus(100);
    expect(status.recoverability).toBe("AGENT_OFFLINE");

    db.prepare(
      `UPDATE agents SET is_active = 1, last_heartbeat_at_ms = 100 WHERE id = '00000000-0000-0000-0000-000000000001'`,
    ).run();
    // 4 minutes later -> stale
    const status2 = await controller.getSystemStatus(100 + 4 * 60 * 1000);
    expect(status2.recoverability).toBe("AGENT_STALE");
  });

  it("blocks recovery when printer is offline/jam/paper-out", async () => {
    db.prepare(
      `UPDATE printers SET status = 'ERROR', status_reason = 'PAPER_JAM' WHERE id = '00000000-0000-0000-0000-000000000002'`,
    ).run();
    const status = await controller.getSystemStatus(100);
    expect(status.recoverability).toBe("PAPER_JAM");
  });

  it("safe pre-submission recovery requeues correctly", async () => {
    const nowMs = 100 + 6 * 60 * 1000;
    db.prepare(
      `UPDATE agents SET last_heartbeat_at_ms = ${nowMs} WHERE id = \'00000000-0000-0000-0000-000000000001\'`,
    ).run();
    db.prepare(
      `INSERT INTO orders (id, public_job_code, status, claimed_by_agent_id, claim_id, claim_expires_at_ms, claimed_at_ms, printer_id, updated_at_ms, customer_name, customer_phone, original_filename, selected_pages, copies, paper_size, color_mode, sides, total_amount_paise, currency, cleanup_state, created_at_ms) VALUES ('00000000-0000-0000-0000-000000000003', 'O1', 'PRINTING', '00000000-0000-0000-0000-000000000001', 'claim1', 10000, 100, '00000000-0000-0000-0000-000000000002', 100, 'Test', '1234567890', 'file.pdf', '1', 1, 'A4', 'BW', 'SINGLE', 0, 'INR', 'ACTIVE', 100)`,
    ).run();
    db.prepare(
      `INSERT INTO print_attempts (id, order_id, attempt_number, agent_id, printer_id, status, created_at_ms, updated_at_ms, submitted_at_ms, last_progress_at_ms) VALUES ('00000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000003', 1, '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'CREATED', 100, 100, NULL, 100)`,
    ).run();

    const status = await controller.getSystemStatus(nowMs);
    expect(status.recoverability).toBe("READY");

    const res = await controller.executeRecovery(adminId, nowMs);
    expect(res.message).toContain("safely requeued");

    const orderStatus = db
      .prepare(
        "SELECT status FROM orders WHERE id = '00000000-0000-0000-0000-000000000003'",
      )
      .get() as any;
    expect(orderStatus.status).toBe("QUEUED");
  });

  it("submitted/unknown marks as COMPLETION_UNKNOWN and NEVER automatically reprints", async () => {
    const nowMs = 100 + 6 * 60 * 1000;
    db.prepare(
      `UPDATE agents SET last_heartbeat_at_ms = ${nowMs} WHERE id = \'00000000-0000-0000-0000-000000000001\'`,
    ).run();
    db.prepare(
      `INSERT INTO orders (id, public_job_code, status, claimed_by_agent_id, claim_id, claim_expires_at_ms, claimed_at_ms, printer_id, updated_at_ms, customer_name, customer_phone, original_filename, selected_pages, copies, paper_size, color_mode, sides, total_amount_paise, currency, cleanup_state, created_at_ms) VALUES ('00000000-0000-0000-0000-000000000003', 'O1', 'PRINTING', '00000000-0000-0000-0000-000000000001', 'claim1', 10000, 100, '00000000-0000-0000-0000-000000000002', 100, 'Test', '1234567890', 'file.pdf', '1', 1, 'A4', 'BW', 'SINGLE', 0, 'INR', 'ACTIVE', 100)`,
    ).run();
    db.prepare(
      `INSERT INTO print_attempts (id, order_id, attempt_number, agent_id, printer_id, status, created_at_ms, updated_at_ms, submitted_at_ms, last_progress_at_ms) VALUES ('00000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000003', 1, '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'SUBMITTING', 100, 100, 100, 100)`,
    ).run();

    const res = await controller.executeRecovery(adminId, nowMs);
    expect(res.message).toContain("COMPLETION_UNKNOWN");

    const orderStatus = db
      .prepare(
        "SELECT status FROM orders WHERE id = '00000000-0000-0000-0000-000000000003'",
      )
      .get() as any;
    expect(orderStatus.status).toBe("COMPLETION_UNKNOWN");
  });

  it("multiple Recover clicks correctly handled", async () => {
    db.prepare(
      `UPDATE installation SET recovery_lock_id = 'lock1', recovery_locked_at_ms = 100, claims_paused = 1 WHERE id = 1`,
    ).run();

    await expect(controller.executeRecovery(adminId, 100)).rejects.toThrow(
      "RECOVERY_ALREADY_RUNNING",
    );
  });

  it("no-progress stall warning works correctly", async () => {
    const nowMs = 100 + 6 * 60 * 1000;
    db.prepare(
      `UPDATE agents SET last_heartbeat_at_ms = ${nowMs} WHERE id = '00000000-0000-0000-0000-000000000001'`,
    ).run();
    db.prepare(
      `INSERT INTO orders (id, public_job_code, status, claimed_by_agent_id, claim_id, claim_expires_at_ms, claimed_at_ms, printer_id, updated_at_ms, customer_name, customer_phone, original_filename, selected_pages, copies, paper_size, color_mode, sides, total_amount_paise, currency, cleanup_state, created_at_ms) VALUES ('00000000-0000-0000-0000-000000000003', 'O1', 'PRINTING', '00000000-0000-0000-0000-000000000001', 'claim1', 10000, 100, '00000000-0000-0000-0000-000000000002', 100, 'Test', '1234567890', 'file.pdf', '1', 1, 'A4', 'BW', 'SINGLE', 0, 'INR', 'ACTIVE', 100)`,
    ).run();
    db.prepare(
      `INSERT INTO print_attempts (id, order_id, attempt_number, agent_id, printer_id, status, created_at_ms, updated_at_ms, submitted_at_ms, last_progress_at_ms) VALUES ('00000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000003', 1, '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'PRINTING', 100, 100, 100, 100)`,
    ).run();

    const status = await controller.getSystemStatus(nowMs);
    expect(status.currentOrder?.isStalled).toBe(true);
    expect(status.recoverability).toBe("READY"); // Can recover stalled
  });

  it("long job with meaningful progress is NOT falsely stalled", async () => {
    const nowMs = 100 + 6 * 60 * 1000;
    db.prepare(
      `UPDATE agents SET last_heartbeat_at_ms = ${nowMs} WHERE id = '00000000-0000-0000-0000-000000000001'`,
    ).run();
    db.prepare(
      `INSERT INTO orders (id, public_job_code, status, claimed_by_agent_id, claim_id, claim_expires_at_ms, claimed_at_ms, printer_id, updated_at_ms, customer_name, customer_phone, original_filename, selected_pages, copies, paper_size, color_mode, sides, total_amount_paise, currency, cleanup_state, created_at_ms) VALUES ('00000000-0000-0000-0000-000000000003', 'O1', 'PRINTING', '00000000-0000-0000-0000-000000000001', 'claim1', 10000, 100, '00000000-0000-0000-0000-000000000002', 100, 'Test', '1234567890', 'file.pdf', '1', 1, 'A4', 'BW', 'SINGLE', 0, 'INR', 'ACTIVE', 100)`,
    ).run();
    // 2 minutes ago we had meaningful progress (e.g. step finished), even though it started 6 mins ago
    db.prepare(
      `INSERT INTO print_attempts (id, order_id, attempt_number, agent_id, printer_id, status, created_at_ms, updated_at_ms, submitted_at_ms, last_progress_at_ms) VALUES ('00000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000003', 1, '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'PRINTING', 100, 100, 100, ${nowMs - 2 * 60 * 1000})`,
    ).run();

    const status = await controller.getSystemStatus(nowMs);
    expect(status.currentOrder?.isStalled).toBe(false);
    expect(status.recoverability).toBe("HEALTHY_PRINTING"); // still printing -> disabled
  });
});
