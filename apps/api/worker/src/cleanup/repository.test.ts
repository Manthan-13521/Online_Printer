import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { D1CleanupRepository } from "./repository";

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

  it("reports paid queued work as active and ineligible for Free All", async () => {
    const orderId = "40000000-0000-4000-8000-000000000001";
    seedOrder(orderId, "QUEUED");
    const preview = await repository.preview("ALL_PRINT_DATA", 2_000);
    expect(preview).toMatchObject({ orders: 0, files: 0, active: 1 });
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
});
