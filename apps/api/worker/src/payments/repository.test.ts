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
          return Promise.resolve((rows.shift() as T | undefined) ?? null);
        },
        run() {
          return Promise.resolve({ success: true });
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
    const initialSchema = readFileSync(
      new URL(
        "../../../../../database/migrations/0001_initial_schema.sql",
        import.meta.url,
      ),
      "utf8",
    );
    database.exec(initialSchema);
    return {
      prepare(sql: string) {
        return new SqliteD1Statement(database, sql);
      },
      batch: vi.fn(),
    } as unknown as D1Database;
  }

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
