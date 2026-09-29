import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { COMPLETED_RETENTION_MS, PRINT_CLAIM_LEASE_MS } from "@printgo/domain";
import { D1PrintingRepository } from "./repository.js";

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
].map((name) =>
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

const ids = {
  order: "10000000-0000-4000-8000-000000000001",
  upload: "20000000-0000-4000-8000-000000000001",
  payment: "30000000-0000-4000-8000-000000000001",
  agent1: "40000000-0000-4000-8000-000000000001",
  agent2: "40000000-0000-4000-8000-000000000002",
  printer1: "50000000-0000-4000-8000-000000000001",
  printer2: "50000000-0000-4000-8000-000000000002",
};

function seed(
  db: DatabaseSync,
  options: {
    paid?: boolean;
    uploadStatus?: string;
    capabilities?: object;
  } = {},
) {
  const now = 1_000;
  db.prepare(
    `INSERT INTO installation (id, shop_name, identification_sheet_enabled,
    identification_sheet_placement, created_at_ms, updated_at_ms) VALUES (1, 'ABC Xerox', 0, 'LAST', ?, ?)`,
  ).run(now, now);
  for (const [index, agentId] of [ids.agent1, ids.agent2].entries()) {
    db.prepare(
      `INSERT INTO agents (id, display_name, credential_hash, is_active, paired_at_ms,
      last_heartbeat_at_ms, created_at_ms, updated_at_ms) VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
    ).run(agentId, `Agent ${index + 1}`, `hash-${index}`, now, now, now, now);
    const printerId = index === 0 ? ids.printer1 : ids.printer2;
    db.prepare(
      `INSERT INTO printers (id, agent_id, display_name, windows_printer_name,
      enabled, status, capabilities_json, last_status_at_ms, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, 1, 'ONLINE', ?, ?, ?, ?)`,
    ).run(
      printerId,
      agentId,
      `Printer ${index + 1}`,
      `Exact Printer ${index + 1}`,
      JSON.stringify(
        options.capabilities ?? {
          colour: true,
          duplex: true,
          paperSizes: ["A4", "A3"],
        },
      ),
      now,
      now,
      now,
    );
  }
  db.prepare(
    `INSERT INTO orders (id, public_job_code, customer_name, customer_phone,
    original_filename, selected_pages, source_page_count, copies, color_mode, paper_size,
    sides, total_amount_paise, printing_amount_paise, status, created_at_ms, updated_at_ms,
    paid_at_ms, queued_at_ms) VALUES (?, 'PG-ABC234', 'Customer', '+919876543210',
    'unsafe/name.pdf', '1-2', 2, 10, 'COLOR', 'A4', 'DOUBLE', 5000, 5000,
    'QUEUED', ?, ?, ?, ?)`,
  ).run(ids.order, now, now, now, now);
  db.prepare(
    `INSERT INTO uploads (id, order_id, r2_object_key, original_filename, size_bytes,
    mime_type, storage_status, created_at_ms, uploaded_at_ms, updated_at_ms, expected_size_bytes)
    VALUES (?, ?, 'orders/private.pdf', 'unsafe/name.pdf', 100, 'application/pdf', ?, ?, ?, ?, 100)`,
  ).run(
    ids.upload,
    ids.order,
    options.uploadStatus ?? "UPLOADED",
    now,
    now,
    now,
  );
  db.prepare(
    `INSERT INTO payments (id, order_id, provider_order_id, provider_payment_id,
    amount_paise, status, verified_at_ms, created_at_ms, updated_at_ms)
    VALUES (?, ?, 'order_provider', ?, 5000, ?, ?, ?, ?)`,
  ).run(
    ids.payment,
    ids.order,
    options.paid === false ? null : "pay_provider",
    options.paid === false ? "PENDING" : "PAID",
    options.paid === false ? null : now,
    now,
    now,
  );
}

describe("paid-print D1 safety", () => {
  let db: DatabaseSync;
  let repository: D1PrintingRepository;
  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    for (const sql of migrations) db.exec(sql);
    repository = new D1PrintingRepository(asD1(db));
  });
  afterEach(() => db.close());

  it("atomically gives duplicate/concurrent claims to only one Agent", async () => {
    seed(db);
    const [first, second] = await Promise.all([
      repository.claimOrRenew(ids.agent1, 2_000),
      repository.claimOrRenew(ids.agent2, 2_000),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(
      db.prepare("SELECT COUNT(*) count FROM print_attempts").get(),
    ).toEqual({ count: 1 });
    const owner = first ? ids.agent1 : ids.agent2;
    const duplicate = await repository.claimOrRenew(owner, 2_100);
    expect(duplicate?.attemptId).toBe((first ?? second)?.attemptId);
  });

  it.each([
    ["FIRST", ["IDENTIFICATION_SHEET", "CUSTOMER_DOCUMENT"]],
    ["LAST", ["CUSTOMER_DOCUMENT", "IDENTIFICATION_SHEET"]],
  ] as const)(
    "persists exactly one identification sheet in %s position",
    async (placement, expected) => {
      seed(db);
      db.prepare(
        "UPDATE installation SET identification_sheet_enabled = 1, identification_sheet_placement = ?",
      ).run(placement);
      const job = await repository.claimOrRenew(ids.agent1, 2_000);
      expect(job?.currentStep.type).toBe(expected[0]);
      expect(job?.identificationSheet?.customerPhone).toBeDefined();
      db.prepare(
        "UPDATE installation SET identification_sheet_enabled = 0",
      ).run();
      const resumed = await repository.claimOrRenew(ids.agent1, 2_001);
      expect(resumed?.identificationSheet).toEqual(job?.identificationSheet);
      const rows = db
        .prepare(
          "SELECT step_type FROM print_attempt_steps ORDER BY sequence_number",
        )
        .all() as Array<{ step_type: string }>;
      expect(rows.map((row) => row.step_type)).toEqual(expected);
      expect(
        rows.filter((row) => row.step_type === "IDENTIFICATION_SHEET"),
      ).toHaveLength(1);
    },
  );

  it("does not multiply step events or metadata writes for simultaneous duplicate requests", async () => {
    seed(db);
    db.exec("UPDATE installation SET identification_sheet_enabled = 1");
    for (let step = 0; step < 2; step++) {
      const job = (await repository.claimOrRenew(
        ids.agent1,
        2_000 + step * 1000,
      ))!;
      const ownership = {
        agentId: ids.agent1,
        orderId: ids.order,
        stepId: job.currentStep.stepId,
        claimId: job.claimId,
      };
      await Promise.all(
        [0, 1].map(() =>
          repository.startStep({ ...ownership, nowMs: 2_100 + step * 1000 }),
        ),
      );
      expect(
        db
          .prepare(
            "SELECT COUNT(*) n FROM order_events WHERE event_type='PRINT_STEP_STARTED'",
          )
          .get()!.n,
      ).toBe(step + 1);
      const before = Number(db.prepare("SELECT total_changes() n").get()!.n);
      await Promise.all(
        [0, 1].map(() =>
          repository.recordSubmission({
            ...ownership,
            nowMs: 2_200 + step * 1000,
            spoolerJobId: String(40 + step),
          }),
        ),
      );
      const changed =
        Number(db.prepare("SELECT total_changes() n").get()!.n) - before;
      expect(changed).toBe(step === 0 ? 3 : 2);
      await repository.recordResult({
        ...ownership,
        nowMs: 2_300 + step * 1000,
        status: "SUCCEEDED",
        spoolerJobId: String(40 + step),
        failureCode: null,
        failureDetail: null,
      });
    }
    expect(
      db.prepare("SELECT status FROM orders WHERE id=?").get(ids.order)!.status,
    ).toBe("COMPLETED");
  });

  it("rejects unpaid, missing-upload, stale capability, and unsupported-printer jobs", async () => {
    seed(db, { paid: false });
    expect(await repository.claimOrRenew(ids.agent1, 2_000)).toBeNull();
    db.prepare(
      "UPDATE payments SET status = 'PAID', provider_payment_id = 'pay', verified_at_ms = 1000",
    ).run();
    db.prepare(
      "UPDATE uploads SET storage_status = 'DELETED', deleted_at_ms = 1500",
    ).run();
    expect(await repository.claimOrRenew(ids.agent1, 2_000)).toBeNull();
    db.prepare(
      "UPDATE uploads SET storage_status = 'UPLOADED', deleted_at_ms = NULL",
    ).run();
    db.prepare("UPDATE printers SET capabilities_json = ?").run(
      JSON.stringify({ colour: false, duplex: false, paperSizes: ["A4"] }),
    );
    expect(await repository.claimOrRenew(ids.agent1, 2_000)).toBeNull();
    db.prepare("UPDATE agents SET is_active = 0 WHERE id = ?").run(ids.agent1);
    expect(await repository.claimOrRenew(ids.agent1, 2_000)).toBeNull();
  });

  it("keeps fast-job pulses read-only and renews a slow lease only in its final third", async () => {
    seed(db);
    const job = (await repository.claimOrRenew(ids.agent1, 2_000))!;
    const changes = () =>
      Number(db.prepare("SELECT total_changes() n").get()!.n);
    const before = changes();
    for (const nowMs of [7_000, 12_000, 42_000, 201_999]) {
      expect(
        (await repository.claimOrRenew(ids.agent1, nowMs))?.leaseExpiresAtMs,
      ).toBe(job.leaseExpiresAtMs);
    }
    expect(changes()).toBe(before);
    const renewed = (await repository.claimOrRenew(ids.agent1, 202_000))!;
    expect(renewed.leaseExpiresAtMs).toBe(202_000 + PRINT_CLAIM_LEASE_MS);
    expect(changes() - before).toBe(1);
    expect(
      (await repository.claimOrRenew(ids.agent1, 207_000))?.leaseExpiresAtMs,
    ).toBe(202_000 + PRINT_CLAIM_LEASE_MS);
    expect(changes() - before).toBe(1);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) n FROM order_events WHERE event_type='PRINT_JOB_CLAIMED'",
        )
        .get()!.n,
    ).toBe(1);
  });

  it("renews a blocked spool identity after interruption but never revives an expired submission", async () => {
    seed(db);
    const job = (await repository.claimOrRenew(ids.agent1, 2_000))!;
    const ownership = {
      agentId: ids.agent1,
      orderId: ids.order,
      stepId: job.currentStep.stepId,
      claimId: job.claimId,
    };
    await repository.startStep({ ...ownership, nowMs: 2_100 });
    await repository.recordSubmission({
      ...ownership,
      nowMs: 2_200,
      spoolerJobId: "77",
    });
    await repository.recordResult({
      ...ownership,
      nowMs: 2_300,
      status: "BLOCKED",
      spoolerJobId: "77",
      failureCode: "PAPER_OUT",
      failureDetail: "Paper out",
    });
    // A temporary network gap shorter than the lease keeps the exact identity.
    const resumed = (await repository.claimOrRenew(ids.agent1, 250_000))!;
    expect(resumed.currentStep).toMatchObject({
      status: "BLOCKED",
      spoolerJobId: "77",
    });
    expect(resumed.leaseExpiresAtMs).toBe(250_000 + PRINT_CLAIM_LEASE_MS);
    // A longer outage / crashed Agent can no longer renew or resubmit.
    expect(
      await repository.claimOrRenew(ids.agent1, 250_001 + PRINT_CLAIM_LEASE_MS),
    ).toBeNull();
    expect(
      db
        .prepare(
          "SELECT status,spooler_job_id FROM print_attempt_steps WHERE id=?",
        )
        .get(job.currentStep.stepId),
    ).toEqual({ status: "UNCERTAIN", spooler_job_id: "77" });
    expect(db.prepare("SELECT COUNT(*) n FROM print_attempts").get()!.n).toBe(
      1,
    );
  });

  it("recovers an expired lease only when no submission started", async () => {
    seed(db);
    const first = await repository.claimOrRenew(ids.agent1, 2_000);
    expect(first).not.toBeNull();
    db.prepare("UPDATE agents SET last_heartbeat_at_ms = ? WHERE id = ?").run(
      302_001,
      ids.agent2,
    );
    const recovered = await repository.claimOrRenew(ids.agent2, 302_001);
    expect(recovered?.orderId).toBe(ids.order);
    expect(recovered?.attemptId).not.toBe(first?.attemptId);
    expect(
      db
        .prepare("SELECT status FROM print_attempts WHERE id = ?")
        .get(first!.attemptId),
    ).toEqual({ status: "CANCELLED" });
  });

  it("never requeues an expired lease after submission may have started", async () => {
    seed(db);
    const job = (await repository.claimOrRenew(ids.agent1, 2_000))!;
    await repository.startStep({
      agentId: ids.agent1,
      orderId: ids.order,
      stepId: job.currentStep.stepId,
      claimId: job.claimId,
      nowMs: 2_100,
    });
    expect(await repository.claimOrRenew(ids.agent2, 302_101)).toBeNull();
    expect(
      db.prepare("SELECT status FROM orders WHERE id = ?").get(ids.order),
    ).toEqual({ status: "ADMIN_ACTION_REQUIRED" });
    expect(
      db
        .prepare("SELECT status FROM print_attempt_steps WHERE id = ?")
        .get(job.currentStep.stepId),
    ).toEqual({ status: "UNCERTAIN" });
  });

  it("keeps duplicate step messages idempotent and starts retention exactly at completion", async () => {
    seed(db);
    const job = (await repository.claimOrRenew(ids.agent1, 2_000))!;
    const ownership = {
      agentId: ids.agent1,
      orderId: ids.order,
      stepId: job.currentStep.stepId,
      claimId: job.claimId,
    };
    expect(
      await repository.startStep({
        ...ownership,
        agentId: ids.agent2,
        nowMs: 2_050,
      }),
    ).toBeNull();
    expect(
      await repository.startStep({
        ...ownership,
        claimId: "wrong-claim",
        nowMs: 2_050,
      }),
    ).toBeNull();
    await repository.startStep({ ...ownership, nowMs: 2_100 });
    await repository.recordSubmission({
      ...ownership,
      spoolerJobId: "42",
      nowMs: 2_200,
    });
    await repository.recordSubmission({
      ...ownership,
      spoolerJobId: "42",
      nowMs: 2_250,
    });
    await repository.recordResult({
      ...ownership,
      status: "SUCCEEDED",
      spoolerJobId: "42",
      failureCode: null,
      failureDetail: null,
      nowMs: 3_000,
    });
    await repository.recordResult({
      ...ownership,
      status: "SUCCEEDED",
      spoolerJobId: "42",
      failureCode: null,
      failureDetail: null,
      nowMs: 3_100,
    });
    expect(
      db
        .prepare("SELECT status, completed_at_ms FROM orders WHERE id = ?")
        .get(ids.order),
    ).toEqual({ status: "COMPLETED", completed_at_ms: 3_000 });
    expect(
      db
        .prepare(
          "SELECT retention_reason, delete_after_ms FROM uploads WHERE order_id = ?",
        )
        .get(ids.order),
    ).toEqual({
      retention_reason: "COMPLETED",
      delete_after_ms: 3_000 + COMPLETED_RETENTION_MS,
    });
  });

  it("keeps BLOCKED on the same spool job and treats uncertainty separately", async () => {
    seed(db);
    const job = (await repository.claimOrRenew(ids.agent1, 2_000))!;
    const ownership = {
      agentId: ids.agent1,
      orderId: ids.order,
      stepId: job.currentStep.stepId,
      claimId: job.claimId,
    };
    await repository.startStep({ ...ownership, nowMs: 2_100 });
    await repository.recordSubmission({
      ...ownership,
      spoolerJobId: "77",
      nowMs: 2_200,
    });
    await repository.recordResult({
      ...ownership,
      status: "BLOCKED",
      spoolerJobId: "77",
      failureCode: "PAPER_OUT",
      failureDetail: "Paper out",
      nowMs: 2_300,
    });
    const blocked = await repository.claimOrRenew(ids.agent1, 2_400);
    expect(blocked?.currentStep).toMatchObject({
      status: "BLOCKED",
      spoolerJobId: "77",
    });
    await repository.recordResult({
      ...ownership,
      status: "BLOCKED",
      spoolerJobId: "77",
      failureCode: "PAPER_OUT",
      failureDetail: "Paper out",
      nowMs: 2_450,
    });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) count FROM order_events WHERE event_type = 'PRINT_BLOCKED'",
        )
        .get(),
    ).toEqual({ count: 1 });
    expect(
      await repository.recordSubmission({
        ...ownership,
        spoolerJobId: "78",
        nowMs: 2_500,
      }),
    ).toBeNull();
  });

  it("finishes an all-succeeded attempt on the next heartbeat after an interrupted completion transaction", async () => {
    seed(db);
    const job = (await repository.claimOrRenew(ids.agent1, 2_000))!;
    db.prepare(
      "UPDATE print_attempt_steps SET status = 'SUCCEEDED', finished_at_ms = 2500, updated_at_ms = 2500 WHERE id = ?",
    ).run(job.currentStep.stepId);
    db.prepare(
      "UPDATE print_attempts SET status = 'PRINTING', updated_at_ms = 2500 WHERE id = ?",
    ).run(job.attemptId);
    db.prepare(
      "UPDATE orders SET status = 'PRINTING', updated_at_ms = 2500 WHERE id = ?",
    ).run(ids.order);
    expect(await repository.claimOrRenew(ids.agent1, 2_600)).toBeNull();
    expect(
      db
        .prepare("SELECT status, completed_at_ms FROM orders WHERE id = ?")
        .get(ids.order),
    ).toEqual({ status: "COMPLETED", completed_at_ms: 2_600 });
  });
});
