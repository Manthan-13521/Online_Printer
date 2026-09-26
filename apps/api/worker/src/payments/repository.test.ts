import { describe, expect, it, vi } from "vitest";

import { D1PaymentRepository } from "./repository";

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
        item.sql.includes("retention_reason = NULL, delete_after_ms = NULL"),
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
