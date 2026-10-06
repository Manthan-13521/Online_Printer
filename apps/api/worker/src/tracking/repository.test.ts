import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";

import { D1TrackingRepository } from "./repository";

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
    readonly sql: string,
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
    batch: () => Promise.resolve([]),
    exec: (sql: string) => {
      db.exec(sql);
      return Promise.resolve({ count: 1, duration: 0 });
    },
    dump: () => Promise.reject(new Error("dump unsupported")),
  } as unknown as D1Database;
}

describe("D1TrackingRepository", () => {
  let db: DatabaseSync;
  let repo: D1TrackingRepository;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    for (const sql of migrations) {
      db.exec(sql);
    }
    repo = new D1TrackingRepository(asD1(db));
  });

  function insertOrder(options: {
    id: string;
    jobCode: string | null;
    status: string;
  }) {
    const now = Date.now();
    db.prepare(
      `INSERT INTO orders (
        id, public_job_code, status, customer_name, customer_phone, original_filename,
        source_page_count, selected_pages, copies, paper_size, color_mode, sides,
        printing_amount_paise, service_charge_paise, total_amount_paise,
        created_at_ms, updated_at_ms, paid_at_ms
      ) VALUES (?, ?, ?, 'Test User', '9999999999', 'test.pdf', 1, '1', 1, 'A4', 'BW', 'SINGLE', 100, 0, 100, ?, ?, ?)`,
    ).run(
      options.id,
      options.jobCode,
      options.status,
      now,
      now,
      options.status !== "CREATED" ? now : null,
    );
  }

  it("successfully creates authorization for MANUAL_PRINT and AWAITING_FINISHING orders", async () => {
    const manualOrderId = "10000000-0000-4000-8000-000000000001";
    insertOrder({
      id: manualOrderId,
      jobCode: "PG-MANUAL",
      status: "MANUAL_PRINT",
    });

    const successManual = await repo.createAuthorization({
      orderId: manualOrderId,
      tokenHash: "hash-manual-token",
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 86400000,
    });
    expect(successManual).toBe(true);

    const authManual = await repo.findAuthorization(manualOrderId);
    expect(authManual?.tokenHash).toBe("hash-manual-token");

    const finishingOrderId = "20000000-0000-4000-8000-000000000002";
    insertOrder({
      id: finishingOrderId,
      jobCode: "PG-FINISH",
      status: "AWAITING_FINISHING",
    });

    const successFinish = await repo.createAuthorization({
      orderId: finishingOrderId,
      tokenHash: "hash-finish-token",
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 86400000,
    });
    expect(successFinish).toBe(true);

    const authFinish = await repo.findAuthorization(finishingOrderId);
    expect(authFinish?.tokenHash).toBe("hash-finish-token");
  });

  it("refuses authorization creation for orders that are not in a valid post-payment status", async () => {
    const draftOrderId = "30000000-0000-4000-8000-000000000003";
    insertOrder({
      id: draftOrderId,
      jobCode: null,
      status: "CREATED",
    });

    const success = await repo.createAuthorization({
      orderId: draftOrderId,
      tokenHash: "hash-token",
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 86400000,
    });
    expect(success).toBe(false);
  });

  it("lists timeline events including MANUAL_PRINT and AWAITING_FINISHING", async () => {
    const orderId = "40000000-0000-4000-8000-000000000004";
    insertOrder({
      id: orderId,
      jobCode: "PG-EVENTS",
      status: "AWAITING_FINISHING",
    });

    const now = Date.now();
    db.prepare(
      `INSERT INTO order_events (id, order_id, event_type, from_status, to_status, actor_type, created_at_ms)
       VALUES ('50000000-0000-4000-8000-000000000001', ?, 'PAYMENT_VERIFIED', 'PAYMENT_PENDING', 'PAID', 'SYSTEM', ?)`,
    ).run(orderId, now);

    db.prepare(
      `INSERT INTO order_events (id, order_id, event_type, from_status, to_status, actor_type, created_at_ms)
       VALUES ('50000000-0000-4000-8000-000000000002', ?, 'STATUS_CHANGED', 'PAID', 'MANUAL_PRINT', 'SYSTEM', ?)`,
    ).run(orderId, now + 10);

    db.prepare(
      `INSERT INTO order_events (id, order_id, event_type, from_status, to_status, actor_type, created_at_ms)
       VALUES ('50000000-0000-4000-8000-000000000003', ?, 'STATUS_CHANGED', 'MANUAL_PRINT', 'AWAITING_FINISHING', 'SYSTEM', ?)`,
    ).run(orderId, now + 20);

    const timeline = await repo.listSafeTimeline(orderId);
    expect(timeline.map((t) => t.toStatus)).toEqual([
      "PAID",
      "MANUAL_PRINT",
      "AWAITING_FINISHING",
    ]);
  });
});
