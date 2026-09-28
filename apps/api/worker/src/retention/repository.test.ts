import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { COMPLETED_CUSTOMER_PII_PURGE_MS } from "@printgo/domain";
import { D1RetentionRepository } from "./repository";

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
    async batch(statements: Statement[]) {
      const results: D1Result[] = [];
      db.exec("BEGIN");
      try {
        for (const statement of statements) {
          if (statement.sql.trim().toUpperCase().startsWith("SELECT")) {
            results.push(await statement.all());
          } else {
            results.push(await statement.run());
          }
        }
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
}

describe("D1RetentionRepository — Database Queries and Index Safety", () => {
  let sqlite: DatabaseSync;
  let repo: D1RetentionRepository;
  const now = 2_000_000_000;

  const agentId = "40000000-0000-4000-8000-000000000001";
  const printerId = "50000000-0000-4000-8000-000000000001";

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    for (const migration of migrations) {
      sqlite.exec(migration);
    }
    sqlite
      .prepare(
        `INSERT INTO installation (id, shop_name, identification_sheet_enabled,
         identification_sheet_placement, created_at_ms, updated_at_ms)
         VALUES (1, 'ABC Xerox', 0, 'LAST', ?, ?)`,
      )
      .run(now - 200_000, now - 200_000);
    sqlite
      .prepare(
        `INSERT INTO agents (id, display_name, credential_hash, is_active, paired_at_ms,
         last_heartbeat_at_ms, created_at_ms, updated_at_ms)
         VALUES (?, 'Front PC', 'hash_123', 1, ?, ?, ?, ?)`,
      )
      .run(agentId, now - 200_000, now, now - 200_000, now);
    sqlite
      .prepare(
        `INSERT INTO printers (id, agent_id, display_name, windows_printer_name, enabled,
         status, is_production_eligible, is_virtual, created_at_ms, updated_at_ms)
         VALUES (?, ?, 'HP LaserJet', 'HP_LaserJet', 1, 'ONLINE', 1, 0, ?, ?)`,
      )
      .run(printerId, agentId, now - 200_000, now);

    repo = new D1RetentionRepository(asD1(sqlite));
  });

  function padUuid(id: string): string {
    if (id.length === 36) return id;
    const clean = id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12);
    return `00000000-0000-4000-8000-${clean.padEnd(12, "0")}`;
  }

  function seedOrderAndUpload(opts: {
    orderId: string;
    uploadId: string;
    status: string;
    retentionReason?: string;
    deleteAfterMs?: number;
    completedAtMs?: number;
    customerName?: string;
    customerPhone?: string;
  }) {
    const orderId = padUuid(opts.orderId);
    const uploadId = padUuid(opts.uploadId);
    const isClaimedState = [
      "CLAIMED",
      "SPOOLING",
      "PRINTING",
      "PRINT_BLOCKED",
      "PRINT_FAILED",
      "ADMIN_ACTION_REQUIRED",
      "PRINTED",
      "COMPLETED",
    ].includes(opts.status);

    const createdAtMs = opts.completedAtMs
      ? opts.completedAtMs - 60_000
      : now - 100_000;
    const updatedAtMs = opts.completedAtMs ?? now - 100_000;
    const paidAtMs = isClaimedState
      ? opts.completedAtMs
        ? opts.completedAtMs - 30_000
        : now - 95_000
      : null;
    const claimedAtMs = isClaimedState
      ? opts.completedAtMs
        ? opts.completedAtMs - 20_000
        : now - 90_000
      : null;

    sqlite
      .prepare(
        `INSERT INTO orders (id, customer_name, customer_phone, original_filename,
         color_mode, paper_size, sides, status, created_at_ms, updated_at_ms, completed_at_ms,
         claimed_by_agent_id, claim_id, claim_expires_at_ms, printer_id, claimed_at_ms, paid_at_ms)
         VALUES (?, ?, ?, 'doc.pdf', 'BW', 'A4', 'SINGLE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        orderId,
        opts.customerName ?? "Test Customer",
        opts.customerPhone ?? "+919876543210",
        opts.status,
        createdAtMs,
        updatedAtMs,
        opts.completedAtMs ?? null,
        isClaimedState ? agentId : null,
        isClaimedState ? crypto.randomUUID() : null,
        isClaimedState ? now + 300_000 : null,
        isClaimedState ? printerId : null,
        claimedAtMs,
        paidAtMs,
      );

    sqlite
      .prepare(
        `INSERT INTO uploads (id, order_id, r2_object_key, original_filename, size_bytes,
         storage_status, retention_reason, delete_after_ms, uploaded_at_ms, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, 'doc.pdf', 2048, 'UPLOADED', ?, ?, ?, ?, ?)`,
      )
      .run(
        uploadId,
        orderId,
        `keys/${uploadId}.pdf`,
        opts.retentionReason ?? null,
        opts.deleteAfterMs ?? null,
        createdAtMs,
        createdAtMs,
        updatedAtMs,
      );
  }

  it("finds expired uploads ordered by delete_after_ms with index scan", async () => {
    seedOrderAndUpload({
      orderId: "order_1",
      uploadId: "upload_1",
      status: "COMPLETED",
      retentionReason: "COMPLETED",
      deleteAfterMs: now - 500,
    });
    seedOrderAndUpload({
      orderId: "order_2",
      uploadId: "upload_2",
      status: "CREATED",
      retentionReason: "UNPAID",
      deleteAfterMs: now + 500, // Not yet expired
    });

    const expired = await repo.findExpiredUploads(now, 10);
    expect(expired).toHaveLength(1);
    expect(expired[0]!.id).toBe(padUuid("upload_1"));
    expect(expired[0]!.orderId).toBe(padUuid("order_1"));
  });

  it("marks upload as delete pending atomically", async () => {
    seedOrderAndUpload({
      orderId: "order_1",
      uploadId: "upload_1",
      status: "CREATED",
      retentionReason: "UNPAID",
      deleteAfterMs: now - 100,
    });

    const locked = await repo.markUploadDeletePending(padUuid("upload_1"), now);
    expect(locked).toBe(true);

    const row = sqlite
      .prepare("SELECT storage_status FROM uploads WHERE id = ?")
      .get(padUuid("upload_1")) as { storage_status: string };
    expect(row.storage_status).toBe("DELETE_PENDING");
  });

  it("records upload deleted and creates audit event", async () => {
    seedOrderAndUpload({
      orderId: "order_1",
      uploadId: "upload_1",
      status: "COMPLETED",
      retentionReason: "COMPLETED",
      deleteAfterMs: now - 100,
    });

    await repo.recordUploadDeleted(
      padUuid("upload_1"),
      padUuid("order_1"),
      now,
    );

    const upload = sqlite
      .prepare(
        "SELECT storage_status, deleted_at_ms, original_filename FROM uploads WHERE id = ?",
      )
      .get(padUuid("upload_1")) as {
      storage_status: string;
      deleted_at_ms: number;
      original_filename: string;
    };
    expect(upload.storage_status).toBe("DELETED");
    expect(upload.deleted_at_ms).toBe(now);
    expect(upload.original_filename).toBe("document.pdf");

    const event = sqlite
      .prepare(
        "SELECT event_type, actor_type, actor_id FROM order_events WHERE order_id = ?",
      )
      .get(padUuid("order_1")) as {
      event_type: string;
      actor_type: string;
      actor_id: string;
    };
    expect(event.event_type).toBe("PDF_DELETED");
    expect(event.actor_type).toBe("SYSTEM");
    expect(event.actor_id).toBe("CRON_RETENTION");
  });

  it("purges customer PII from completed order after 5 hours and logs audit event", async () => {
    seedOrderAndUpload({
      orderId: "order_old",
      uploadId: "upload_old",
      status: "COMPLETED",
      customerName: "Personal Secret Name",
      customerPhone: "+91 99999 11111",
      completedAtMs: now - COMPLETED_CUSTOMER_PII_PURGE_MS - 10_000,
    });

    const candidates = await repo.findPiiPurgeCandidates(
      now - COMPLETED_CUSTOMER_PII_PURGE_MS,
      10,
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.id).toBe(padUuid("order_old"));

    const purged = await repo.purgeOrderPii(padUuid("order_old"), now);
    expect(purged).toBe(true);

    const order = sqlite
      .prepare(
        "SELECT customer_name, customer_phone, pii_purged_at_ms FROM orders WHERE id = ?",
      )
      .get(padUuid("order_old")) as {
      customer_name: string;
      customer_phone: string;
      pii_purged_at_ms: number;
    };
    expect(order.customer_name).toBe("Customer details expired for privacy");
    expect(order.customer_phone).toBe("REDACTED");
    expect(order.pii_purged_at_ms).toBe(now);

    const event = sqlite
      .prepare(
        "SELECT event_type FROM order_events WHERE order_id = ? AND event_type = 'PII_PURGED'",
      )
      .get(padUuid("order_old")) as { event_type: string };
    expect(event.event_type).toBe("PII_PURGED");
  });

  it("calculates accurate retention stats across all categories", async () => {
    seedOrderAndUpload({
      orderId: "order_unpaid",
      uploadId: "up_unpaid",
      status: "CREATED",
      retentionReason: "UNPAID",
      deleteAfterMs: now - 100,
    });
    seedOrderAndUpload({
      orderId: "order_failed",
      uploadId: "up_failed",
      status: "PAYMENT_FAILED",
      retentionReason: "PAYMENT_FAILED_OR_CANCELLED",
      deleteAfterMs: now - 100,
    });
    seedOrderAndUpload({
      orderId: "order_comp",
      uploadId: "up_comp",
      status: "COMPLETED",
      retentionReason: "COMPLETED",
      deleteAfterMs: now - 100,
      completedAtMs: now - COMPLETED_CUSTOMER_PII_PURGE_MS - 1_000,
    });
    seedOrderAndUpload({
      orderId: "order_unres",
      uploadId: "up_unres",
      status: "ADMIN_ACTION_REQUIRED",
      retentionReason: "UNRESOLVED_PAID_FAILURE",
      deleteAfterMs: now - 100,
    });

    const stats = await repo.getRetentionStats(now);
    expect(stats.unpaidExpired).toBe(1);
    expect(stats.failedExpired).toBe(1);
    expect(stats.completedPdfExpired).toBe(1);
    expect(stats.unresolvedPaidExpired).toBe(1);
    expect(stats.piiPurgeCandidates).toBe(1);
    expect(stats.totalPendingCleanup).toBe(4);
  });
});
