import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { D1CleanupRepository } from "./repository";
import { CleanupService } from "./service";
import { D1OrderHistoryRepository } from "../history/repository";

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
  return {
    prepare: (sql: string) => new Statement(db, sql),
    async batch(statements: Statement[]) {
      db.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
}

const migrations = [
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
].map((name) =>
  readFileSync(
    new URL(`../../../../../database/migrations/${name}`, import.meta.url),
    "utf8",
  ),
);

describe("D1 cleanup repository", () => {
  let db: DatabaseSync;
  let repository: D1CleanupRepository;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    for (const migration of migrations) db.exec(migration);
    db.prepare(
      `INSERT INTO installation (id, shop_name, created_at_ms, updated_at_ms)
       VALUES (1, 'Safe Shop', 0, 0)`,
    ).run();
    repository = new D1CleanupRepository(asD1(db));
  });

  it("uses keyed draft and due-cleanup access paths after the Phase 4 table rebuild", () => {
    const plans = [
      [
        "SELECT id FROM orders WHERE draft_token_hash = ? AND cleanup_state = 'ACTIVE'",
        "orders_draft_token_lookup_idx",
      ],
      [
        `SELECT o.id FROM orders o INDEXED BY orders_unpaid_cleanup_due_idx
         WHERE o.cleanup_state = 'ACTIVE'
           AND o.status IN ('CREATED','UPLOADING','UPLOADED','PAYMENT_PENDING','PAYMENT_FAILED','PAYMENT_CANCELLED')
           AND o.draft_expires_at_ms <= ? LIMIT 1`,
        "orders_unpaid_cleanup_due_idx",
      ],
      [
        `SELECT o.id FROM orders o INDEXED BY orders_completed_cleanup_due_idx
         WHERE o.cleanup_state = 'ACTIVE' AND o.status = 'COMPLETED'
           AND o.purge_at_ms IS NOT NULL AND o.purge_at_ms <= ? LIMIT 1`,
        "orders_completed_cleanup_due_idx",
      ],
    ] as const;
    for (const [sql, expectedIndex] of plans) {
      const details = db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(sql.includes("draft_token_hash") ? "token" : 1)
        .map((row) => String(row.detail));
      expect(details.some((detail) => detail.includes(expectedIndex))).toBe(
        true,
      );
      expect(details.some((detail) => detail.startsWith("SCAN orders"))).toBe(
        false,
      );
    }
  });

  afterEach(() => db.close());

  function seedOrder(
    id: string,
    status: "UPLOADED" | "QUEUED",
    createdAtMs = 0,
  ) {
    db.prepare(
      `INSERT INTO orders
       (id, customer_name, customer_phone, original_filename, selected_pages,
        copies, color_mode, paper_size, sides, status, draft_expires_at_ms,
        created_at_ms, updated_at_ms)
       VALUES (?, 'Customer', '9999999999', 'private.pdf', 'ALL', 1, 'BW',
        'A4', 'SINGLE', ?, 1000, ?, ?)`,
    ).run(id, status, createdAtMs, createdAtMs);
    const fileId = `${id.slice(0, -1)}2`;
    const key = `uploads/${id}/${fileId}.pdf`;
    db.prepare(
      `INSERT INTO uploads
       (id, order_id, r2_object_key, original_filename, expected_size_bytes,
        size_bytes, mime_type, storage_status, created_at_ms, uploaded_at_ms, updated_at_ms)
       VALUES (?, ?, ?, 'private.pdf', 100, 100, 'application/pdf', 'UPLOADED', 0, 0, 0)`,
    ).run(fileId, id, key);
    db.prepare(
      `INSERT INTO order_files
       (id, order_id, position, original_filename, r2_object_key,
        expected_size_bytes, size_bytes, mime_type, source_page_count,
        paper_size, color_mode, sides, upload_status, uploaded_at_ms,
        created_at_ms, updated_at_ms)
       VALUES (?, ?, 1, 'private.pdf', ?, 100, 100, 'application/pdf', 1,
        'A4', 'BW', 'SINGLE', 'UPLOADED', 0, 0, 0)`,
    ).run(fileId, id, key);
  }

  it("claims and purges due unpaid workload while preserving installation settings", async () => {
    const orderId = "10000000-0000-4000-8000-000000000001";
    const runId = "30000000-0000-4000-8000-000000000001";
    seedOrder(orderId, "UPLOADED");
    const preview = await repository.preview("EXPIRED_UNPAID", 2_000);
    expect(preview).toMatchObject({ orders: 1, files: 1, active: 0 });
    await repository.createRun({
      id: runId,
      scope: "EXPIRED_UNPAID",
      source: "SCHEDULED",
      preview,
      nowMs: 2_000,
    });
    const [candidate] = await repository.claimBatch(
      runId,
      "EXPIRED_UNPAID",
      2_000,
      5,
    );
    expect(candidate?.objectKeys).toEqual([
      `uploads/${orderId}/10000000-0000-4000-8000-000000000002.pdf`,
    ]);
    await repository.purgeOrder(runId, candidate!, 2_001);
    expect(db.prepare("SELECT COUNT(*) count FROM orders").get()).toEqual({
      count: 0,
    });
    expect(db.prepare("SELECT shop_name FROM installation").get()).toEqual({
      shop_name: "Safe Shop",
    });
  });

  it("includes inactive paid queued work in Free All", async () => {
    const orderId = "40000000-0000-4000-8000-000000000001";
    seedOrder(orderId, "QUEUED");
    const preview = await repository.preview("ALL_PRINT_DATA", 2_000);
    expect(preview).toMatchObject({ orders: 1, files: 1, active: 0 });
  });

  it("enforces the ten-minute unpaid deadline and deletes only stored object keys", async () => {
    const id = "50000000-0000-4000-8000-000000000001";
    seedOrder(id, "UPLOADED");
    db.prepare(
      "UPDATE orders SET draft_expires_at_ms = 600000 WHERE id = ?",
    ).run(id);
    expect(await repository.hasCandidates("EXPIRED_UNPAID", 599_999)).toBe(
      false,
    );
    expect(await repository.hasCandidates("EXPIRED_UNPAID", 600_000)).toBe(
      true,
    );
    const deleted: string[][] = [];
    const bucket = {
      delete: (keys: string[]) => {
        deleted.push(keys);
        return Promise.resolve();
      },
    } as unknown as R2Bucket;
    const service = new CleanupService(repository, bucket, () => 600_000);
    await service.runScheduled();
    expect(deleted).toEqual([
      [`uploads/${id}/50000000-0000-4000-8000-000000000002.pdf`],
    ]);
    expect(
      db.prepare("SELECT id FROM orders WHERE id = ?").get(id),
    ).toBeUndefined();
    await service.runScheduled();
    expect(deleted).toHaveLength(1);
  });

  it("purges completed multi-PDF data at two hours, expires tracking, leaves no history row", async () => {
    const id = "51000000-0000-4000-8000-000000000001";
    seedOrder(id, "UPLOADED");
    db.prepare(
      `UPDATE orders SET status = 'COMPLETED', pickup_code = 'PA-123',
      completed_at_ms = 1000, purge_at_ms = 7201000 WHERE id = ?`,
    ).run(id);
    db.prepare(
      "UPDATE order_files SET print_status = 'PRINTED' WHERE order_id = ?",
    ).run(id);
    const second = "51000000-0000-4000-8000-000000000003";
    const key = `uploads/${id}/${second}.pdf`;
    db.prepare(
      `INSERT INTO order_files (id, order_id, position, original_filename,
      r2_object_key, expected_size_bytes, size_bytes, source_page_count,
      paper_size, color_mode, sides, upload_status, print_status, uploaded_at_ms, created_at_ms, updated_at_ms)
      VALUES (?, ?, 2, 'second.pdf', ?, 200, 200, 1, 'A4', 'BW', 'SINGLE',
        'UPLOADED', 'PRINTED', 0, 0, 0)`,
    ).run(second, id, key);
    expect(await repository.hasCandidates("COMPLETED_DUE", 7_200_999)).toBe(
      false,
    );
    const deleted: string[][] = [];
    const service = new CleanupService(
      repository,
      {
        delete: (keys: string[]) => {
          deleted.push(keys);
          return Promise.resolve();
        },
      } as unknown as R2Bucket,
      () => 7_201_000,
    );
    await service.runScheduled();
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toContain(key);
    expect(deleted[0]).toHaveLength(2);
    expect(
      db.prepare("SELECT id FROM orders WHERE pickup_code = 'PA-123'").get(),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT id FROM order_files WHERE order_id = ?").get(id),
    ).toBeUndefined();
    // No retained_order_history row — everything is permanently deleted.
    const history = await new D1OrderHistoryRepository(asD1(db)).list(null);
    expect(history.orders).toHaveLength(0);
  });

  it("skips active spool work, retains unresolved completed work, and allows inactive uncertain Free All", async () => {
    const active = "52000000-0000-4000-8000-000000000001";
    const unresolved = "53000000-0000-4000-8000-000000000003";
    seedOrder(active, "QUEUED");
    seedOrder(unresolved, "UPLOADED");
    db.prepare(
      "UPDATE order_files SET print_status = 'SUBMITTED' WHERE order_id = ?",
    ).run(active);
    db.prepare(
      "UPDATE orders SET status = 'COMPLETED', purge_at_ms = 1 WHERE id = ?",
    ).run(unresolved);
    db.prepare(
      "UPDATE order_files SET print_status = 'UNCERTAIN' WHERE order_id = ?",
    ).run(unresolved);
    expect((await repository.preview("ALL_PRINT_DATA", 2_000)).active).toBe(1);
    expect(await repository.hasCandidates("COMPLETED_DUE", 2_000)).toBe(false);
    db.prepare(
      "UPDATE order_files SET print_status = 'UNCERTAIN' WHERE order_id = ?",
    ).run(active);
    db.prepare(
      "UPDATE orders SET status = 'COMPLETION_UNKNOWN' WHERE id = ?",
    ).run(active);
    expect((await repository.preview("ALL_PRINT_DATA", 2_000)).orders).toBe(2);
  });

  it("Free Printed and Free All use the same purge and preserve shop configuration", async () => {
    const printed = "54000000-0000-4000-8000-000000000001";
    const uncertain = "55000000-0000-4000-8000-000000000001";
    seedOrder(printed, "UPLOADED");
    seedOrder(uncertain, "QUEUED");
    db.prepare(
      "UPDATE orders SET status = 'COMPLETED', completed_at_ms = 1000, purge_at_ms = 7201000 WHERE id = ?",
    ).run(printed);
    db.prepare(
      "UPDATE order_files SET print_status = 'PRINTED' WHERE order_id = ?",
    ).run(printed);
    db.prepare(
      "UPDATE orders SET status = 'COMPLETION_UNKNOWN' WHERE id = ?",
    ).run(uncertain);
    db.prepare(
      "UPDATE order_files SET print_status = 'UNCERTAIN' WHERE order_id = ?",
    ).run(uncertain);
    const adminId = "56000000-0000-4000-8000-000000000001";
    db.prepare(
      `INSERT INTO admins (id, login_identifier, password_hash, created_at_ms, updated_at_ms)
      VALUES (?, 'owner', 'hash', 0, 0)`,
    ).run(adminId);
    const deleted: string[][] = [];
    const service = new CleanupService(
      repository,
      {
        delete: (keys: string[]) => {
          deleted.push(keys);
          return Promise.resolve();
        },
      } as unknown as R2Bucket,
      () => 2_000,
    );
    const first = await service.requestAdminRun(
      "ALL_COMPLETED",
      adminId,
      "FREE PRINTED",
    );
    expect(first.deletedOrders).toBe(1);
    expect(
      db.prepare("SELECT id FROM orders WHERE id = ?").get(uncertain),
    ).toBeDefined();
    const second = await service.requestAdminRun(
      "ALL_PRINT_DATA",
      adminId,
      "FREE ALL",
    );
    expect(second.deletedOrders).toBe(1);
    expect(deleted).toHaveLength(2);
    expect(
      db
        .prepare(
          "SELECT shop_name, daily_cleanup_time FROM installation WHERE id = 1",
        )
        .get(),
    ).toEqual({ shop_name: "Safe Shop", daily_cleanup_time: "23:30" });
    expect(
      db.prepare("SELECT id FROM admins WHERE id = ?").get(adminId),
    ).toBeDefined();
    expect((await service.preview("ALL_PRINT_DATA")).orders).toBe(0);
  });

  it("keeps an Admin cleanup run open and retries once active spool ownership ends", async () => {
    const id = "5b000000-0000-4000-8000-000000000001";
    const adminId = "5c000000-0000-4000-8000-000000000001";
    seedOrder(id, "QUEUED");
    db.prepare(
      "UPDATE order_files SET print_status = 'SUBMITTED' WHERE order_id = ?",
    ).run(id);
    db.prepare(
      `INSERT INTO admins (id, login_identifier, password_hash, created_at_ms, updated_at_ms)
      VALUES (?, 'owner', 'hash', 0, 0)`,
    ).run(adminId);
    let now = 2_000;
    const deleted: string[][] = [];
    const service = new CleanupService(
      repository,
      {
        delete: (keys: string[]) => {
          deleted.push(keys);
          return Promise.resolve();
        },
      } as unknown as R2Bucket,
      () => now,
    );
    const run = await service.requestAdminRun(
      "ALL_PRINT_DATA",
      adminId,
      "FREE ALL",
    );
    expect(run.status).toBe("PENDING");
    expect(run.activeSkipped).toBe(1);
    expect(deleted).toHaveLength(0);
    db.prepare(
      "UPDATE order_files SET print_status = 'UNCERTAIN' WHERE order_id = ?",
    ).run(id);
    db.prepare(
      "UPDATE orders SET status = 'COMPLETION_UNKNOWN' WHERE id = ?",
    ).run(id);
    now = 3_000;
    const resumed = await service.runScheduled();
    expect(resumed?.runId).toBe(run.runId);
    expect(resumed?.status).toBe("COMPLETED");
    expect(deleted).toHaveLength(1);
  });

  it("runs daily Free All at its stored local schedule and records the result", async () => {
    const id = "57000000-0000-4000-8000-000000000001";
    seedOrder(id, "QUEUED");
    db.prepare(
      `UPDATE installation SET automatic_daily_cleanup_enabled = 1,
      daily_cleanup_time = '23:30', timezone = 'Asia/Kolkata',
      next_daily_cleanup_at_ms = 2000 WHERE id = 1`,
    ).run();
    const service = new CleanupService(
      repository,
      { delete: () => Promise.resolve() } as unknown as R2Bucket,
      () => 2_000,
    );
    const result = await service.runScheduled();
    expect(result?.deletedOrders).toBe(1);
    expect(
      db.prepare("SELECT id FROM orders WHERE id = ?").get(id),
    ).toBeUndefined();
    const settings = db
      .prepare(
        `SELECT next_daily_cleanup_at_ms,
      last_cleanup_at_ms, last_cleanup_result FROM installation WHERE id = 1`,
      )
      .get() as {
      next_daily_cleanup_at_ms: number;
      last_cleanup_at_ms: number;
      last_cleanup_result: string;
    };
    expect(settings.next_daily_cleanup_at_ms).toBeGreaterThan(2_000);
    expect(settings.last_cleanup_at_ms).toBe(2_000);
    expect(settings.last_cleanup_result).toContain("1 orders / 1 PDFs deleted");
  });

  it("paginates live history without document binaries and shows selected add-ons", async () => {
    const first = "58000000-0000-4000-8000-000000000001";
    const second = "59000000-0000-4000-8000-000000000001";
    seedOrder(first, "QUEUED", 1_000);
    seedOrder(second, "QUEUED", 2_000);
    db.prepare(
      "UPDATE orders SET pickup_code = 'PA-456', is_priority = 1, due_at_pickup_paise = 250 WHERE id = ?",
    ).run(second);
    const serviceId = "5a000000-0000-4000-8000-000000000001";
    db.prepare(
      `INSERT INTO addon_services
      (id, name, pricing_type, fixed_price_paise, handling_mode,
       created_at_ms, updated_at_ms)
      VALUES (?, 'Binding', 'FIXED_PRICE', 500, 'POST_PRINT', 0, 0)`,
    ).run(serviceId);
    db.prepare(
      `INSERT INTO order_addon_services
      (order_id, service_id, snapshot_name, snapshot_pricing_type,
       snapshot_price_charged_online_paise, snapshot_handling_mode)
      VALUES (?, ?, 'Binding', 'FIXED_PRICE', 500, 'POST_PRINT')`,
    ).run(second, serviceId);
    const agentId = "5d000000-0000-4000-8000-000000000001";
    const primaryId = "5e000000-0000-4000-8000-000000000001";
    const backupId = "5f000000-0000-4000-8000-000000000001";
    const attemptId = "60000000-0000-4000-8000-000000000001";
    db.prepare(
      `INSERT INTO agents (id, display_name, created_at_ms, updated_at_ms)
      VALUES (?, 'Counter PC', 0, 0)`,
    ).run(agentId);
    for (const [id, name] of [
      [primaryId, "Main Printer"],
      [backupId, "Backup Printer"],
    ] as const) {
      db.prepare(
        `INSERT INTO printers (id, agent_id, display_name, windows_printer_name,
        created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, 0, 0)`,
      ).run(id, agentId, name, name);
    }
    db.prepare(
      `INSERT INTO print_attempts (id, order_id, attempt_number, agent_id,
      printer_id, fallback_from_printer_id, status, created_at_ms, updated_at_ms)
      VALUES (?, ?, 1, ?, ?, ?, 'FAILED', 2000, 2000)`,
    ).run(attemptId, second, agentId, backupId, primaryId);
    db.prepare(
      `INSERT INTO print_attempt_steps (id, print_attempt_id, order_id,
      sequence_number, step_type, status, failure_code, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, 1, 'CUSTOMER_DOCUMENT', 'UNCERTAIN', 'UNKNOWN', 2000, 2000)`,
    ).run("61000000-0000-4000-8000-000000000001", attemptId, second);
    const history = new D1OrderHistoryRepository(asD1(db));
    const page1 = await history.list(null, 1);
    expect(page1.orders[0]).toMatchObject({
      pickupCode: "PA-456",
      isPriority: true,
      dueAtPickupPaise: 250,
      addonServices: [{ name: "Binding" }],
      printerUsed: "Backup Printer",
      fallbackPrinter: "Backup Printer",
      attemptCount: 1,
      failureHistory: [{ status: "UNCERTAIN", code: "UNKNOWN" }],
      purged: false,
    });
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await history.list(page1.nextCursor, 1);
    expect(page2.orders[0]?.orderId).toBe(first);
    expect(page2.nextCursor).toBeNull();
    expect(JSON.stringify(page1)).not.toContain("private.pdf");
  });

  it("uses bounded probes before scheduled cleanup previews", async () => {
    const orderId = "41000000-0000-4000-8000-000000000001";
    const runId = "42000000-0000-4000-8000-000000000001";
    expect(await repository.hasCandidates("EXPIRED_UNPAID", 2_000)).toBe(false);
    seedOrder(orderId, "UPLOADED");
    expect(await repository.hasCandidates("EXPIRED_UNPAID", 2_000)).toBe(true);
    const preview = await repository.preview("EXPIRED_UNPAID", 2_000);
    await repository.createRun({
      id: runId,
      scope: "EXPIRED_UNPAID",
      source: "SCHEDULED",
      preview,
      nowMs: 2_000,
    });
    expect(await repository.hasOpenRun("EXPIRED_UNPAID", "SCHEDULED")).toBe(
      true,
    );
  });

  it("finds a due order beyond a hundred unresolved completed rows", async () => {
    for (let index = 1; index <= 101; index++) {
      const id = `${index.toString(16).padStart(8, "0")}-0000-4000-8000-000000000001`;
      seedOrder(id, "UPLOADED");
      db.prepare(
        "UPDATE orders SET status = 'COMPLETED', purge_at_ms = ? WHERE id = ?",
      ).run(index, id);
      db.prepare(
        "UPDATE order_files SET print_status = ? WHERE order_id = ?",
      ).run(index === 101 ? "PRINTED" : "UNCERTAIN", id);
    }
    expect(await repository.hasCandidates("COMPLETED_DUE", 200)).toBe(true);
    expect((await repository.preview("COMPLETED_DUE", 200)).orders).toBe(1);
  });

  it("backs failed cleanup items off without writing on every cron tick", async () => {
    const orderId = "43000000-0000-4000-8000-000000000001";
    const runId = "44000000-0000-4000-8000-000000000001";
    seedOrder(orderId, "UPLOADED");
    const preview = await repository.preview("EXPIRED_UNPAID", 2_000);
    await repository.createRun({
      id: runId,
      scope: "EXPIRED_UNPAID",
      source: "SCHEDULED",
      preview,
      nowMs: 2_000,
    });
    expect(
      await repository.claimBatch(runId, "EXPIRED_UNPAID", 2_000, 5),
    ).toHaveLength(1);
    await repository.recordFailure(runId, orderId, "R2 unavailable", 2_001);

    const before = Number(
      db.prepare("SELECT total_changes() changes").get()!.changes,
    );
    expect(
      await repository.claimBatch(runId, "EXPIRED_UNPAID", 2_002, 5),
    ).toEqual([]);
    const after = Number(
      db.prepare("SELECT total_changes() changes").get()!.changes,
    );
    expect(after - before).toBe(0);
    expect(
      await repository.claimBatch(runId, "EXPIRED_UNPAID", 302_001, 5),
    ).toHaveLength(1);
  });

  it("prioritizes newer pending work over an older backed-off failure", async () => {
    const orderId = "45000000-0000-4000-8000-000000000001";
    const partialRunId = "46000000-0000-4000-8000-000000000001";
    const pendingRunId = "47000000-0000-4000-8000-000000000001";
    seedOrder(orderId, "UPLOADED");
    const preview = await repository.preview("EXPIRED_UNPAID", 2_000);
    await repository.createRun({
      id: partialRunId,
      scope: "EXPIRED_UNPAID",
      source: "SCHEDULED",
      preview,
      nowMs: 2_000,
    });
    await repository.claimBatch(partialRunId, "EXPIRED_UNPAID", 2_000, 5);
    await repository.recordFailure(
      partialRunId,
      orderId,
      "R2 unavailable",
      2_001,
    );
    await repository.createRun({
      id: pendingRunId,
      scope: "COMPLETED_DUE",
      source: "SCHEDULED",
      preview: {
        scope: "COMPLETED_DUE",
        orders: 0,
        files: 0,
        bytes: 0,
        active: 0,
      },
      nowMs: 2_002,
    });

    await expect(repository.nextRunnableRun(2_002)).resolves.toEqual({
      id: pendingRunId,
      scope: "COMPLETED_DUE",
      source: "SCHEDULED",
    });
  });

  it("does not expand a cleanup run to orders created after its cutoff", async () => {
    const firstOrderId = "50000000-0000-4000-8000-000000000001";
    const laterOrderId = "60000000-0000-4000-8000-000000000001";
    const runId = "70000000-0000-4000-8000-000000000001";
    seedOrder(firstOrderId, "UPLOADED", 1_000);
    const preview = await repository.preview("ALL_PRINT_DATA", 2_000);
    await repository.createRun({
      id: runId,
      scope: "ALL_PRINT_DATA",
      source: "ADMIN",
      preview,
      nowMs: 2_000,
    });
    seedOrder(laterOrderId, "UPLOADED", 3_000);

    const candidates = await repository.claimBatch(
      runId,
      "ALL_PRINT_DATA",
      4_000,
      5,
    );

    expect(candidates.map((candidate) => candidate.orderId)).toEqual([
      firstOrderId,
    ]);
  });

  it("purges expired unpaid orders with abandoned pending payments while protecting active payments", async () => {
    const expiredOrderId = "61000000-0000-4000-8000-000000000001";
    const activeOrderId = "62000000-0000-4000-8000-000000000001";
    seedOrder(expiredOrderId, "UPLOADED", 500);
    seedOrder(activeOrderId, "UPLOADED", 1_500);

    db.prepare(
      "UPDATE orders SET status = 'PAYMENT_PENDING', draft_expires_at_ms = 1000 WHERE id = ?",
    ).run(expiredOrderId);
    db.prepare(
      "UPDATE orders SET status = 'PAYMENT_PENDING', draft_expires_at_ms = 3000 WHERE id = ?",
    ).run(activeOrderId);

    db.prepare(
      `INSERT INTO payments (id, order_id, provider, provider_order_id, amount_paise, currency, status, created_at_ms, updated_at_ms)
       VALUES (?, ?, 'RAZORPAY', 'rp_1', 100, 'INR', 'PENDING', 500, 500)`,
    ).run("64000000-0000-4000-8000-000000000001", expiredOrderId);
    db.prepare(
      `INSERT INTO payments (id, order_id, provider, provider_order_id, amount_paise, currency, status, created_at_ms, updated_at_ms)
       VALUES (?, ?, 'RAZORPAY', 'rp_2', 100, 'INR', 'PENDING', 1500, 1500)`,
    ).run("65000000-0000-4000-8000-000000000001", activeOrderId);

    const unpaidPreview = await repository.preview("EXPIRED_UNPAID", 2_000);
    expect(unpaidPreview.orders).toBe(1);

    const allPrintPreview = await repository.preview("ALL_PRINT_DATA", 2_000);
    expect(allPrintPreview.orders).toBe(1);
    expect(allPrintPreview.active).toBe(1);

    const runId = "63000000-0000-4000-8000-000000000001";
    await repository.createRun({
      id: runId,
      scope: "ALL_PRINT_DATA",
      source: "ADMIN",
      preview: allPrintPreview,
      nowMs: 2_000,
    });
    const candidates = await repository.claimBatch(
      runId,
      "ALL_PRINT_DATA",
      2_000,
      5,
    );
    expect(candidates.map((c) => c.orderId)).toEqual([expiredOrderId]);
  });
});
