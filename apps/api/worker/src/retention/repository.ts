import type { RetentionReason } from "@printgo/domain";
import { COMPLETED_CUSTOMER_PII_PURGE_MS } from "@printgo/domain";

export interface ExpiredUploadRecord {
  id: string;
  orderId: string;
  r2ObjectKey: string;
  retentionReason: RetentionReason | null;
  deleteAfterMs: number;
  deletionAttemptCount: number;
}

export interface PiiPurgeCandidateRecord {
  id: string;
  customerName: string;
  customerPhone: string;
  completedAtMs: number;
}

export interface RetentionStats {
  unpaidExpired: number;
  failedExpired: number;
  completedPdfExpired: number;
  unresolvedPaidExpired: number;
  piiPurgeCandidates: number;
  totalPendingCleanup: number;
}

export interface RetentionRepository {
  findExpiredUploads(
    nowMs: number,
    limit: number,
  ): Promise<ExpiredUploadRecord[]>;
  markUploadDeletePending(uploadId: string, nowMs: number): Promise<boolean>;
  recordUploadDeleted(
    uploadId: string,
    orderId: string,
    nowMs: number,
  ): Promise<void>;
  recordUploadDeleteFailed(
    uploadId: string,
    errorMsg: string,
    nowMs: number,
  ): Promise<void>;
  findPiiPurgeCandidates(
    cutoffMs: number,
    limit: number,
  ): Promise<PiiPurgeCandidateRecord[]>;
  purgeOrderPii(orderId: string, nowMs: number): Promise<boolean>;
  getRetentionStats(nowMs: number): Promise<RetentionStats>;
}

interface UploadRow {
  id: string;
  order_id: string;
  r2_object_key: string;
  retention_reason: RetentionReason | null;
  delete_after_ms: number;
  deletion_attempt_count: number;
}

interface OrderPiiRow {
  id: string;
  customer_name: string;
  customer_phone: string;
  completed_at_ms: number;
}

export class D1RetentionRepository implements RetentionRepository {
  constructor(private readonly db: D1Database) {}

  async findExpiredUploads(
    nowMs: number,
    limit: number,
  ): Promise<ExpiredUploadRecord[]> {
    const result = await this.db
      .prepare(
        `SELECT id, order_id, r2_object_key, retention_reason, delete_after_ms, deletion_attempt_count
         FROM uploads
         WHERE storage_status <> 'DELETED'
           AND delete_after_ms IS NOT NULL
           AND delete_after_ms <= ?
           AND (next_cleanup_attempt_at_ms IS NULL OR next_cleanup_attempt_at_ms <= ?)
         ORDER BY delete_after_ms ASC
         LIMIT ?`,
      )
      .bind(nowMs, nowMs, limit)
      .all<UploadRow>();

    return (result.results ?? []).map((row) => ({
      id: row.id,
      orderId: row.order_id,
      r2ObjectKey: row.r2_object_key,
      retentionReason: row.retention_reason,
      deleteAfterMs: row.delete_after_ms,
      deletionAttemptCount: row.deletion_attempt_count,
    }));
  }

  async markUploadDeletePending(
    uploadId: string,
    nowMs: number,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE uploads
         SET storage_status = 'DELETE_PENDING', updated_at_ms = ?, next_cleanup_attempt_at_ms = ?
         WHERE id = ? AND storage_status <> 'DELETED' AND delete_after_ms <= ?
           AND (next_cleanup_attempt_at_ms IS NULL OR next_cleanup_attempt_at_ms <= ?)`,
      )
      .bind(nowMs, nowMs + 300_000, uploadId, nowMs, nowMs)
      .run();

    return Number(result.meta.changes ?? 0) > 0;
  }

  async recordUploadDeleted(
    uploadId: string,
    orderId: string,
    nowMs: number,
  ): Promise<void> {
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `UPDATE uploads
           SET storage_status = 'DELETED',
               deleted_at_ms = ?,
               next_cleanup_attempt_at_ms = NULL,
               original_filename = 'document.pdf',
               updated_at_ms = ?
           WHERE id = ? AND storage_status <> 'DELETED'`,
        )
        .bind(nowMs, nowMs, uploadId),
      this.db
        .prepare(
          `INSERT INTO order_events
             (id, order_id, event_type, from_status, to_status, actor_type, actor_id, details_json, created_at_ms)
           SELECT ?, ?, 'PDF_DELETED', NULL, NULL, 'SYSTEM', 'CRON_RETENTION', ?, ? WHERE changes() = 1`,
        )
        .bind(
          crypto.randomUUID(),
          orderId,
          JSON.stringify({ uploadId, deletedAtMs: nowMs }),
          nowMs,
        ),
    ];

    await this.db.batch(statements);
  }

  async recordUploadDeleteFailed(
    uploadId: string,
    errorMsg: string,
    nowMs: number,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE uploads
         SET storage_status = 'DELETE_FAILED',
             deletion_attempt_count = deletion_attempt_count + 1,
             last_deletion_error = ?,
             next_cleanup_attempt_at_ms = ? + MIN(3600000, 300000 * (1 << MIN(deletion_attempt_count, 4))),
             updated_at_ms = ?
         WHERE id = ? AND storage_status = 'DELETE_PENDING' `,
      )
      .bind(errorMsg.slice(0, 500), nowMs, nowMs, uploadId)
      .run();
  }

  async findPiiPurgeCandidates(
    cutoffMs: number,
    limit: number,
  ): Promise<PiiPurgeCandidateRecord[]> {
    const result = await this.db
      .prepare(
        `SELECT id, customer_name, customer_phone, completed_at_ms
         FROM orders
         WHERE status = 'COMPLETED'
           AND pii_purged_at_ms IS NULL
           AND completed_at_ms IS NOT NULL
           AND completed_at_ms <= ?
         ORDER BY completed_at_ms ASC
         LIMIT ?`,
      )
      .bind(cutoffMs, limit)
      .all<OrderPiiRow>();

    return (result.results ?? []).map((row) => ({
      id: row.id,
      customerName: row.customer_name,
      customerPhone: row.customer_phone,
      completedAtMs: row.completed_at_ms,
    }));
  }

  async purgeOrderPii(orderId: string, nowMs: number): Promise<boolean> {
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `UPDATE orders
           SET customer_name = 'Customer details expired for privacy',
               customer_phone = 'REDACTED',
               original_filename = 'document.pdf',
               instructions = NULL,
               pii_purged_at_ms = ?,
               updated_at_ms = ?
           WHERE id = ? AND pii_purged_at_ms IS NULL`,
        )
        .bind(nowMs, nowMs, orderId),
      this.db
        .prepare(
          `INSERT INTO order_events
             (id, order_id, event_type, from_status, to_status, actor_type, actor_id, details_json, created_at_ms)
           SELECT ?, ?, 'PII_PURGED', NULL, NULL, 'SYSTEM', 'CRON_RETENTION', ?, ? WHERE changes() = 1`,
        )
        .bind(
          crypto.randomUUID(),
          orderId,
          JSON.stringify({ purgedAtMs: nowMs }),
          nowMs,
        ),
      this.db
        .prepare(
          `UPDATE uploads
           SET original_filename = 'document.pdf',
               updated_at_ms = ?
           WHERE order_id = ? AND original_filename IS NOT 'document.pdf'`,
        )
        .bind(nowMs, orderId),
    ];

    const results = await this.db.batch(statements);
    return Number(results[0]?.meta?.changes ?? 0) > 0;
  }

  async getRetentionStats(nowMs: number): Promise<RetentionStats> {
    const piiCutoffMs = nowMs - COMPLETED_CUSTOMER_PII_PURGE_MS;

    const countQueries = await this.db.batch<{ count: number }>([
      this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM uploads
           WHERE storage_status <> 'DELETED' AND retention_reason = 'UNPAID' AND delete_after_ms <= ?`,
        )
        .bind(nowMs),
      this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM uploads
           WHERE storage_status <> 'DELETED' AND retention_reason = 'PAYMENT_FAILED_OR_CANCELLED' AND delete_after_ms <= ?`,
        )
        .bind(nowMs),
      this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM uploads
           WHERE storage_status <> 'DELETED' AND retention_reason = 'COMPLETED' AND delete_after_ms <= ?`,
        )
        .bind(nowMs),
      this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM uploads
           WHERE storage_status <> 'DELETED' AND retention_reason = 'UNRESOLVED_PAID_FAILURE' AND delete_after_ms <= ?`,
        )
        .bind(nowMs),
      this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM orders
           WHERE status = 'COMPLETED' AND pii_purged_at_ms IS NULL AND completed_at_ms IS NOT NULL AND completed_at_ms <= ?`,
        )
        .bind(piiCutoffMs),
    ]);

    const unpaidExpired = countQueries[0]?.results?.[0]?.count ?? 0;
    const failedExpired = countQueries[1]?.results?.[0]?.count ?? 0;
    const completedPdfExpired = countQueries[2]?.results?.[0]?.count ?? 0;
    const unresolvedPaidExpired = countQueries[3]?.results?.[0]?.count ?? 0;
    const piiPurgeCandidates = countQueries[4]?.results?.[0]?.count ?? 0;

    return {
      unpaidExpired,
      failedExpired,
      completedPdfExpired,
      unresolvedPaidExpired,
      piiPurgeCandidates,
      totalPendingCleanup:
        unpaidExpired +
        failedExpired +
        completedPdfExpired +
        unresolvedPaidExpired,
    };
  }
}
