import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import { D1PaymentRepository } from "./repository";

class SqliteD1Statement {
  private bindings: SQLInputValue[] = [];

  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]): SqliteD1Statement {
    this.bindings = values as SQLInputValue[];
    return this;
  }

  run(): Promise<D1Result> {
    const result = this.database.prepare(this.sql).run(...this.bindings);
    return Promise.resolve({
      success: true,
      meta: { changes: Number(result.changes) },
      results: [],
    } as unknown as D1Result);
  }

  first<T>(): Promise<T | null> {
    const row = this.database.prepare(this.sql).get(...this.bindings);
    return Promise.resolve((row as T | undefined) ?? null);
  }

  all<T>(): Promise<D1Result<T>> {
    const rows = this.database.prepare(this.sql).all(...this.bindings) as T[];
    return Promise.resolve({
      success: true,
      meta: { changes: 0 },
      results: rows,
    } as unknown as D1Result<T>);
  }
}

interface FakeStatement {
  sql: string;
  bindings: unknown[];
  bind(...values: unknown[]): FakeStatement;
  first<T>(): Promise<T | null>;
  run(): Promise<unknown>;
}

function fakeDatabase(rows: Array<Record<string, unknown>>) {
  const statements: FakeStatement[] = [];
  const batch = vi.fn((items: FakeStatement[]) =>
    Promise.resolve(items.map(() => ({ success: true }))),
  );
  const db = {
    prepare(sql: string) {
      const statement: FakeStatement = {
        sql,
        bindings: [],
        bind(...values: unknown[]) {
          this.bindings = values;
          return this;
        },
        first<T>() {
          if (sql.includes("SELECT pickup_code FROM orders")) {
            return Promise.resolve({ pickup_code: "PA-001" } as T);
          }
          if (sql.includes("SELECT next_pickup_code_index")) {
            return Promise.resolve({ next_pickup_code_index: 0 } as T);
          }
          if (sql.includes("WHERE pickup_code = ?")) {
            return Promise.resolve(null as T);
          }
          return Promise.resolve((rows.shift() as T | undefined) ?? null);
        },
        run() {
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        },
      };
      statements.push(statement);
      return statement;
    },
    batch,
  } as unknown as D1Database;
  return { db, statements, batch };
}

const pendingRow = {
  id: "60000000-0000-4000-8000-000000000001",
  order_id: "50000000-0000-4000-8000-000000000001",
  provider_order_id: "order_server_a",
  provider_payment_id: null,
  amount_paise: 2100,
  order_amount_paise: 2100,
  currency: "INR",
  status: "PENDING",
  public_job_code: null,
  order_status: "PAYMENT_PENDING",
};

describe("D1PaymentRepository payment lifecycle", () => {
  it("atomically clears unpaid retention while paying, assigning, and queueing", async () => {
    const paidRow = {
      ...pendingRow,
      provider_payment_id: "pay_server_a",
      status: "PAID",
      public_job_code: "PG-ABC234",
      order_status: "QUEUED",
    };
    const fake = fakeDatabase([pendingRow, paidRow]);
    const repository = new D1PaymentRepository(fake.db);
    await expect(
      repository.finalizePaid({
        paymentId: pendingRow.id,
        providerPaymentId: "pay_server_a",
        jobCode: "PG-ABC234",
        nowMs: 1_000,
        actorType: "CUSTOMER",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        status: "PAID",
        publicJobCode: "PG-ABC234",
        orderStatus: "QUEUED",
      }),
    );
    expect(fake.batch).toHaveBeenCalledOnce();
    expect(
      fake.statements.some((item) =>
        item.sql.includes("retention_reason = 'UNRESOLVED_PAID_FAILURE'"),
      ),
    ).toBe(true);
    expect(
      fake.statements.some((item) =>
        item.sql.includes("public_job_code = COALESCE(public_job_code, ?)"),
      ),
    ).toBe(true);
    expect(
      fake.statements.filter((item) =>
        item.sql.includes("INSERT OR IGNORE INTO order_events"),
      ),
    ).toHaveLength(3);
  });

  it("writes the exact failed-payment retention deadline", async () => {
    const fake = fakeDatabase([pendingRow]);
    const repository = new D1PaymentRepository(fake.db);
    await repository.failPayment({
      paymentId: pendingRow.id,
      providerPaymentId: "pay_failed_a",
      nowMs: 1_000,
      retainedUntilMs: 1_801_000,
    });
    const retention = fake.statements.find((item) =>
      item.sql.includes("PAYMENT_FAILED_OR_CANCELLED"),
    );
    expect(retention?.bindings).toEqual([
      1_801_000,
      1_000,
      pendingRow.order_id,
    ]);
  });
});

describe("D1PaymentRepository webhook claim & stale event recovery", () => {
  function createRealDb(): D1Database {
    const database = new DatabaseSync(":memory:");
    for (const name of [
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
    ]) {
      database.exec(
        readFileSync(
          new URL(
            `../../../../../database/migrations/${name}`,
            import.meta.url,
          ),
          "utf8",
        ),
      );
    }
    return {
      prepare(sql: string) {
        return new SqliteD1Statement(database, sql);
      },
      batch: vi.fn(),
    } as unknown as D1Database;
  }

  it("saves priority/discount totals atomically and locks the quote once payment is reserved", async () => {
    const db = createRealDb();
    const repo = new D1PaymentRepository(db);
    const orderId = "50000000-0000-4000-8000-000000000099";
    await db
      .prepare(
        `INSERT INTO orders (id, customer_name, customer_phone, original_filename,
        paper_size, color_mode, sides, printing_amount_paise, service_charge_paise,
        total_amount_paise, status, created_at_ms, updated_at_ms)
       VALUES (?, 'Test', '9999999999', 'test.pdf', 'A4', 'BW', 'SINGLE',
         2000, 100, 2100, 'PAYMENT_PENDING', 1000, 1000)`,
      )
      .bind(orderId)
      .run();
    const quote = {
      orderId,
      selectedPages: "ALL",
      printingAmountPaise: 2000,
      serviceChargePaise: 600,
      totalAmountPaise: 2080,
      isPriority: true,
      priorityFeePaise: 500,
      discountAmountPaise: 520,
      snapshotDiscountThresholdPaise: 2500,
      snapshotDiscountPercent: 20,
      identificationRequired: true,
      nowMs: 1100,
    };
    expect(await repo.saveRecalculatedQuote(quote)).toBe(true);
    const saved = await db
      .prepare(
        `SELECT total_amount_paise, priority_fee_paise, discount_amount_paise,
        identification_required FROM orders WHERE id = ?`,
      )
      .bind(orderId)
      .first<{
        total_amount_paise: number;
        priority_fee_paise: number;
        discount_amount_paise: number;
        identification_required: number;
      }>();
    expect(saved).toEqual({
      total_amount_paise: 2080,
      priority_fee_paise: 500,
      discount_amount_paise: 520,
      identification_required: 1,
    });
    await db
      .prepare(
        `INSERT INTO payments (id, order_id, provider_order_id, amount_paise,
        currency, status, created_at_ms, updated_at_ms)
       VALUES ('60000000-0000-4000-8000-000000000099', ?, 'local_reserved',
         2080, 'INR', 'CREATED', 1100, 1100)`,
      )
      .bind(orderId)
      .run();
    expect(await repo.saveRecalculatedQuote(quote)).toBe(true);
    expect(
      await repo.saveRecalculatedQuote({
        ...quote,
        totalAmountPaise: 2100,
        discountAmountPaise: 500,
      }),
    ).toBe(false);
  });

  it("claims a fresh event and refuses concurrent fresh re-claims", async () => {
    const db = createRealDb();
    const repo = new D1PaymentRepository(db);
    const nowMs = 1_000_000;

    // First claim on fresh event must succeed
    const firstClaim = await repo.claimProviderEvent({
      id: crypto.randomUUID(),
      providerEventId: "evt_fresh_1",
      eventType: "payment.captured",
      nowMs,
      staleTimeoutMs: 300_000,
    });
    expect(firstClaim).toBe(true);

    // Concurrent claim while still fresh (< 5 min) must be refused
    const secondClaim = await repo.claimProviderEvent({
      id: crypto.randomUUID(),
      providerEventId: "evt_fresh_1",
      eventType: "payment.captured",
      nowMs: nowMs + 10_000, // 10s later, fresh
      staleTimeoutMs: 300_000,
    });
    expect(secondClaim).toBe(false);
  });

  it("reclaims a stale PROCESSING event after timeout expires", async () => {
    const db = createRealDb();
    const repo = new D1PaymentRepository(db);
    const initialNowMs = 1_000_000;
    const staleTimeoutMs = 300_000; // 5 minutes

    // 1. Initial claim
    expect(
      await repo.claimProviderEvent({
        id: crypto.randomUUID(),
        providerEventId: "evt_stale_1",
        eventType: "payment.captured",
        nowMs: initialNowMs,
        staleTimeoutMs,
      }),
    ).toBe(true);

    // 2. Interruption occurs (worker crash, never finished).
    // Retry arrives 6 minutes later (stale).
    const retryNowMs = initialNowMs + 360_000;
    const reclaimed = await repo.claimProviderEvent({
      id: crypto.randomUUID(),
      providerEventId: "evt_stale_1",
      eventType: "payment.captured",
      nowMs: retryNowMs,
      staleTimeoutMs,
    });
    expect(reclaimed).toBe(true);
  });

  it("ensures exactly one winner between two simultaneous stale reclaim attempts", async () => {
    const db = createRealDb();
    const repo = new D1PaymentRepository(db);
    const initialNowMs = 1_000_000;
    const staleTimeoutMs = 300_000;

    await repo.claimProviderEvent({
      id: crypto.randomUUID(),
      providerEventId: "evt_race_1",
      eventType: "payment.captured",
      nowMs: initialNowMs,
      staleTimeoutMs,
    });

    const retryNowMs = initialNowMs + 360_000;
    // Two simultaneous stale reclaim attempts
    const result1 = await repo.claimProviderEvent({
      id: crypto.randomUUID(),
      providerEventId: "evt_race_1",
      eventType: "payment.captured",
      nowMs: retryNowMs,
      staleTimeoutMs,
    });
    const result2 = await repo.claimProviderEvent({
      id: crypto.randomUUID(),
      providerEventId: "evt_race_1",
      eventType: "payment.captured",
      nowMs: retryNowMs,
      staleTimeoutMs,
    });

    expect(result1).toBe(true);
    expect(result2).toBe(false);
  });

  it("never reclaims a completed PROCESSED event", async () => {
    const db = createRealDb();
    const repo = new D1PaymentRepository(db);
    const nowMs = 1_000_000;

    await repo.claimProviderEvent({
      id: crypto.randomUUID(),
      providerEventId: "evt_completed_1",
      eventType: "payment.captured",
      nowMs,
    });

    await repo.finishProviderEvent({
      providerEventId: "evt_completed_1",
      status: "PROCESSED",
      nowMs: nowMs + 1_000,
    });

    // Retry 1 hour later must be rejected as duplicate
    const retry = await repo.claimProviderEvent({
      id: crypto.randomUUID(),
      providerEventId: "evt_completed_1",
      eventType: "payment.captured",
      nowMs: nowMs + 3_600_000,
    });
    expect(retry).toBe(false);
  });

  it("allows retrying a FAILED event", async () => {
    const db = createRealDb();
    const repo = new D1PaymentRepository(db);
    const nowMs = 1_000_000;

    await repo.claimProviderEvent({
      id: crypto.randomUUID(),
      providerEventId: "evt_failed_1",
      eventType: "payment.captured",
      nowMs,
    });

    await repo.finishProviderEvent({
      providerEventId: "evt_failed_1",
      status: "FAILED",
      nowMs: nowMs + 500,
    });

    // Failed event can be retried immediately
    const retry = await repo.claimProviderEvent({
      id: crypto.randomUUID(),
      providerEventId: "evt_failed_1",
      eventType: "payment.captured",
      nowMs: nowMs + 1_000,
    });
    expect(retry).toBe(true);
  });
});
