import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";

import { D1OrderHistoryRepository } from "./repository";

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

describe("D1OrderHistoryRepository", () => {
  let db: DatabaseSync;
  let repository: D1OrderHistoryRepository;

  function padUuid(index: number | string): string {
    const hex = String(index).padStart(12, "0");
    return `00000000-0000-4000-8000-${hex}`;
  }

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    for (const sql of migrations) {
      db.exec(sql);
    }
    repository = new D1OrderHistoryRepository(asD1(db));
  });

  it("excludes PAYMENT_PENDING, PAYMENT_FAILED, PAYMENT_CANCELLED, UPLOADING, and UPLOADED orders", async () => {
    const now = Date.now();
    const statuses = [
      "PAYMENT_PENDING",
      "PAYMENT_FAILED",
      "PAYMENT_CANCELLED",
      "UPLOADING",
      "UPLOADED",
    ];

    for (const [i, status] of statuses.entries()) {
      const orderId = padUuid(i + 1);
      db.prepare(
        `INSERT INTO orders (id, customer_name, customer_phone, original_filename,
           source_page_count, color_mode, paper_size, sides, status,
           printing_amount_paise, total_amount_paise, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, 'doc.pdf', 1, 'BW', 'A4', 'SINGLE', ?, 500, 500, ?, ?)`,
      ).run(
        orderId,
        `Customer ${i}`,
        "+919876543210",
        status,
        now - i * 1000,
        now - i * 1000,
      );
    }

    const result = await repository.list(null);
    expect(result.orders).toHaveLength(0);
  });

  it("excludes unpaid placeholder QUEUED orders without payment or public_job_code", async () => {
    const now = Date.now();
    const orderId = padUuid(99);

    db.prepare(
      `INSERT INTO orders (id, customer_name, customer_phone, original_filename,
         source_page_count, color_mode, paper_size, sides, status,
         printing_amount_paise, total_amount_paise, created_at_ms, updated_at_ms)
       VALUES (?, 'Ghost User', '+919876543210', 'ghost.pdf', 1, 'BW', 'A4', 'SINGLE', 'QUEUED', 0, 0, ?, ?)`,
    ).run(orderId, now, now);

    const result = await repository.list(null);
    expect(result.orders).toHaveLength(0);
  });

  it("includes legitimately paid orders and returns customer name and phone", async () => {
    const now = Date.now();
    const orderId = padUuid(101);
    const uploadId = padUuid(102);

    db.prepare(
      `INSERT INTO orders (id, customer_name, customer_phone, original_filename,
         source_page_count, color_mode, paper_size, sides, status, public_job_code, pickup_code,
         printing_amount_paise, total_amount_paise, created_at_ms, updated_at_ms, paid_at_ms)
       VALUES (?, 'Ravi Sharma', '+919876543210', 'thesis.pdf', 5, 'BW', 'A4', 'SINGLE', 'COMPLETED', 'PG-ABC123', 'PA-001',
               500, 500, ?, ?, ?)`,
    ).run(orderId, now, now, now);

    db.prepare(
      `INSERT INTO payments (id, order_id, provider_order_id, provider_payment_id,
         amount_paise, currency, status, verified_at_ms, created_at_ms, updated_at_ms)
       VALUES (?, ?, 'order_1', 'pay_1', 500, 'INR', 'PAID', ?, ?, ?)`,
    ).run(padUuid(103), orderId, now, now, now);

    db.prepare(
      `INSERT INTO uploads (id, order_id, r2_object_key, original_filename, size_bytes,
         mime_type, storage_status, retention_reason, delete_after_ms, created_at_ms,
         uploaded_at_ms, updated_at_ms, expected_size_bytes)
       VALUES (?, ?, 'uploads/101.pdf', 'thesis.pdf', 1024, 'application/pdf', 'UPLOADED', 'COMPLETED', ?, ?, ?, ?, 1024)`,
    ).run(uploadId, orderId, now + 3600000, now, now, now);

    const result = await repository.list(null);
    expect(result.orders).toHaveLength(1);
    expect(result.orders[0]?.orderId).toBe(orderId);
    expect(result.orders[0]?.customerName).toBe("Ravi Sharma");
    expect(result.orders[0]?.customerPhone).toBe("+919876543210");
    expect(result.orders[0]?.pickupCode).toBe("PA-001");
    expect(result.orders[0]?.onlinePaidPaise).toBe(500);
    expect(result.orders[0]?.purged).toBe(false);
  });

  it("marks purged as true when upload is deleted after retention", async () => {
    const now = Date.now();
    const orderId = padUuid(201);
    const uploadId = padUuid(202);

    db.prepare(
      `INSERT INTO orders (id, customer_name, customer_phone, original_filename,
         source_page_count, color_mode, paper_size, sides, status, public_job_code, pickup_code,
         printing_amount_paise, total_amount_paise, created_at_ms, updated_at_ms, paid_at_ms)
       VALUES (?, 'Pooja', '+919876543210', 'notes.pdf', 2, 'BW', 'A4', 'SINGLE', 'COMPLETED', 'PG-DEF456', 'PA-002',
               200, 200, ?, ?, ?)`,
    ).run(orderId, now, now, now);

    db.prepare(
      `INSERT INTO payments (id, order_id, provider_order_id, provider_payment_id,
         amount_paise, currency, status, verified_at_ms, created_at_ms, updated_at_ms)
       VALUES (?, ?, 'order_2', 'pay_2', 200, 'INR', 'PAID', ?, ?, ?)`,
    ).run(padUuid(203), orderId, now, now, now);

    db.prepare(
      `INSERT INTO uploads (id, order_id, r2_object_key, original_filename, size_bytes,
         mime_type, storage_status, retention_reason, delete_after_ms, deleted_at_ms, created_at_ms,
         uploaded_at_ms, updated_at_ms, expected_size_bytes)
       VALUES (?, ?, 'uploads/201.pdf', 'notes.pdf', 1024, 'application/pdf', 'DELETED', 'COMPLETED', ?, ?, ?, ?, ?, 1024)`,
    ).run(uploadId, orderId, now + 3600000, now + 3600000, now, now, now);

    const result = await repository.list(null);
    expect(result.orders).toHaveLength(1);
    expect(result.orders[0]?.purged).toBe(true);
  });
});
