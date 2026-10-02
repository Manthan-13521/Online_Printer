import type {
  AdminCleanupPreviewData,
  AdminCleanupRunData,
  CleanupScope,
} from "@printgo/api-contract";

export interface CleanupCandidate {
  orderId: string;
  objectKeys: string[];
  fileCount: number;
  bytes: number;
}

interface CountRow {
  sample_count: number;
  orders_count: number;
  files_count: number;
  bytes_count: number;
  active_count: number;
}

function scopeWhere(scope: CleanupScope): string {
  if (scope === "EXPIRED_UNPAID")
    return `o.status IN ('CREATED','UPLOADING','UPLOADED','PAYMENT_PENDING','PAYMENT_FAILED','PAYMENT_CANCELLED')
      AND o.draft_expires_at_ms <= ?
      AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id
        AND p.status = 'PAID')`;
  if (scope === "COMPLETED_DUE")
    return `o.status = 'COMPLETED' AND o.purge_at_ms IS NOT NULL AND o.purge_at_ms <= ?`;
  if (scope === "ALL_COMPLETED") return `o.status = 'COMPLETED'`;
  return `1 = 1`;
}

const ACTIVE_PHYSICAL = `(
  o.status IN ('CLAIMED','SPOOLING','PRINTING','PRINT_BLOCKED')
  OR EXISTS (SELECT 1 FROM print_attempt_steps active_step
    WHERE active_step.order_id = o.id
      AND active_step.status IN ('SUBMISSION_STARTED','SUBMITTED'))
  OR EXISTS (SELECT 1 FROM order_files active_file WHERE active_file.order_id = o.id
    AND active_file.print_status IN ('SUBMISSION_STARTED','SUBMITTED'))
)`;

const UNRESOLVED_COMPLETED = `(
  o.status = 'COMPLETED' AND (
    NOT EXISTS (SELECT 1 FROM order_files f WHERE f.order_id = o.id)
    OR EXISTS (SELECT 1 FROM order_files f WHERE f.order_id = o.id
      AND f.print_status <> 'PRINTED')
  )
)`;

function safetyGuard(scope: CleanupScope, nowMs?: number): string {
  const activePayment =
    nowMs !== undefined
      ? `EXISTS (SELECT 1 FROM payments active_payment
          WHERE active_payment.order_id = o.id AND active_payment.status IN ('CREATED','PENDING')
          AND (o.draft_expires_at_ms IS NULL OR o.draft_expires_at_ms > ${nowMs}))`
      : `EXISTS (SELECT 1 FROM payments active_payment
          WHERE active_payment.order_id = o.id AND active_payment.status IN ('CREATED','PENDING'))`;

  return scope === "ALL_PRINT_DATA"
    ? `NOT (${ACTIVE_PHYSICAL}) AND NOT (${activePayment})`
    : `NOT (${ACTIVE_PHYSICAL}) AND NOT (${activePayment}) AND NOT (${UNRESOLVED_COMPLETED})`;
}

function scopeOrder(scope: CleanupScope): string {
  if (scope === "EXPIRED_UNPAID") return "o.draft_expires_at_ms, o.id";
  if (scope === "COMPLETED_DUE") return "o.purge_at_ms, o.id";
  return "o.created_at_ms, o.id";
}

function dueIndex(scope: CleanupScope): string {
  if (scope === "EXPIRED_UNPAID")
    return "INDEXED BY orders_unpaid_cleanup_due_idx";
  if (scope === "COMPLETED_DUE")
    return "INDEXED BY orders_completed_cleanup_due_idx";
  return "";
}

export class D1CleanupRepository {
  constructor(private readonly db: D1Database) {}

  async hasOpenRun(
    scope: CleanupScope,
    source: "SCHEDULED" | "ADMIN" | "DAILY",
  ): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT 1 open_run FROM cleanup_runs
         WHERE scope = ? AND source = ?
           AND status IN ('PENDING','RUNNING','PARTIAL')
         LIMIT 1`,
      )
      .bind(scope, source)
      .first<{ open_run: number }>();
    return row !== null;
  }

  /** Permanently remove all stale retained_order_history rows. */
  async purgeAllHistory(): Promise<number> {
    const result = await this.db
      .prepare("DELETE FROM retained_order_history")
      .run();
    return result.meta.changes ?? 0;
  }

  async hasCandidates(scope: CleanupScope, nowMs: number): Promise<boolean> {
    const where = scopeWhere(scope);
    const guard = safetyGuard(scope, nowMs);
    const row = await this.db
      .prepare(
        `SELECT 1 candidate FROM orders o ${dueIndex(scope)}
         WHERE o.cleanup_state = 'ACTIVE' AND ${where}
           AND ${guard}
         LIMIT 1`,
      )
      .bind(
        ...(scope === "EXPIRED_UNPAID" || scope === "COMPLETED_DUE"
          ? [nowMs]
          : []),
      )
      .first<{ candidate: number }>();
    return row !== null;
  }

  async preview(
    scope: CleanupScope,
    nowMs: number,
  ): Promise<AdminCleanupPreviewData> {
    const where = scopeWhere(scope);
    const guard = safetyGuard(scope, nowMs);
    const sampleGuard =
      scope === "EXPIRED_UNPAID" || scope === "COMPLETED_DUE" ? guard : "1 = 1";
    const due = await this.db
      .prepare(
        `WITH sample AS (
           SELECT o.id FROM orders o ${dueIndex(scope)} WHERE o.cleanup_state = 'ACTIVE' AND ${where}
             AND ${sampleGuard}
           ORDER BY ${scopeOrder(scope)} LIMIT 100
         )
         SELECT COUNT(DISTINCT o.id) sample_count,
          COUNT(DISTINCT CASE WHEN ${guard} THEN o.id END) orders_count,
          COUNT(DISTINCT CASE WHEN ${guard} THEN f.id END) files_count,
          COALESCE(SUM(CASE WHEN f.id IS NOT NULL AND ${guard}
            THEN f.size_bytes ELSE 0 END), 0) bytes_count,
          COUNT(DISTINCT CASE WHEN NOT (${guard}) THEN o.id END) active_count
         FROM sample JOIN orders o ON o.id = sample.id
         LEFT JOIN order_files f ON f.order_id = o.id`,
      )
      .bind(
        ...(scope === "EXPIRED_UNPAID" || scope === "COMPLETED_DUE"
          ? [nowMs]
          : []),
      )
      .first<CountRow>();
    return {
      scope,
      orders: due?.orders_count ?? 0,
      files: due?.files_count ?? 0,
      bytes: due?.bytes_count ?? 0,
      active: due?.active_count ?? 0,
      limited: (due?.sample_count ?? 0) === 100,
    };
  }

  async createRun(input: {
    id: string;
    scope: CleanupScope;
    source: "SCHEDULED" | "ADMIN" | "DAILY";
    adminId?: string;
    preview: AdminCleanupPreviewData;
    nowMs: number;
    deduplicate?: boolean;
  }): Promise<string | null> {
    const result = await this.db
      .prepare(
        `INSERT INTO cleanup_runs
          (id, scope, source, status, requested_by_admin_id, orders_selected,
           files_selected, bytes_selected, bytes_deleted, active_skipped,
           cutoff_at_ms, created_at_ms, updated_at_ms)
         SELECT ?, ?, ?, 'PENDING', ?, ?, ?, ?, 0, ?, ?, ?, ?
         WHERE ? = 0 OR NOT EXISTS (
           SELECT 1 FROM cleanup_runs WHERE scope = ? AND source = ?
             AND status IN ('PENDING','RUNNING','PARTIAL')
         )`,
      )
      .bind(
        input.id,
        input.scope,
        input.source,
        input.adminId ?? null,
        input.preview.orders,
        input.preview.files,
        input.preview.bytes,
        input.preview.active,
        input.nowMs,
        input.nowMs,
        input.nowMs,
        input.deduplicate ? 1 : 0,
        input.scope,
        input.source,
      )
      .run();
    return result.meta.changes === 1 ? input.id : null;
  }

  async getRun(runId: string): Promise<AdminCleanupRunData | null> {
    const row = await this.db
      .prepare(
        `SELECT id, scope, status, orders_selected, files_selected,
          orders_deleted, files_deleted, bytes_selected, bytes_deleted, active_skipped,
          failures, last_error, created_at_ms, completed_at_ms
         FROM cleanup_runs WHERE id = ?`,
      )
      .bind(runId)
      .first<{
        id: string;
        scope: CleanupScope;
        status: AdminCleanupRunData["status"];
        orders_selected: number;
        files_selected: number;
        orders_deleted: number;
        files_deleted: number;
        bytes_selected: number;
        bytes_deleted: number;
        active_skipped: number;
        failures: number;
        last_error: string | null;
        created_at_ms: number;
        completed_at_ms: number | null;
      }>();
    return row
      ? {
          runId: row.id,
          scope: row.scope,
          status: row.status,
          orders: row.orders_selected,
          files: row.files_selected,
          bytes: row.bytes_selected,
          active: row.active_skipped,
          deletedOrders: row.orders_deleted,
          deletedFiles: row.files_deleted,
          deletedBytes: row.bytes_deleted,
          activeSkipped: row.active_skipped,
          failures: row.failures,
          lastError: row.last_error,
          createdAt: new Date(row.created_at_ms).toISOString(),
          completedAt: row.completed_at_ms
            ? new Date(row.completed_at_ms).toISOString()
            : null,
        }
      : null;
  }

  async nextRunnableRun(nowMs: number): Promise<{
    id: string;
    scope: CleanupScope;
    source: "SCHEDULED" | "ADMIN" | "DAILY";
  } | null> {
    return this.db
      .prepare(
        `SELECT id, scope, source FROM cleanup_runs
         WHERE status IN ('PENDING','RUNNING','PARTIAL')
         ORDER BY CASE
           WHEN status = 'PENDING' THEN 0
           WHEN EXISTS (SELECT 1 FROM cleanup_run_items pending
             WHERE pending.run_id = cleanup_runs.id AND pending.status = 'PENDING') THEN 0
           WHEN EXISTS (SELECT 1 FROM cleanup_run_items failed
             WHERE failed.run_id = cleanup_runs.id AND failed.status = 'FAILED'
               AND (failed.next_attempt_at_ms IS NULL OR failed.next_attempt_at_ms <= ?)) THEN 0
           WHEN status = 'RUNNING' THEN 1
           ELSE 2
         END, created_at_ms
         LIMIT 1`,
      )
      .bind(nowMs)
      .first<{
        id: string;
        scope: CleanupScope;
        source: "SCHEDULED" | "ADMIN" | "DAILY";
      }>();
  }

  async claimBatch(
    runId: string,
    scope: CleanupScope,
    nowMs: number,
    limit: number,
  ): Promise<CleanupCandidate[]> {
    const failed = await this.db
      .prepare(
        `SELECT order_id FROM cleanup_run_items
         WHERE run_id = ? AND status = 'FAILED'
           AND (next_attempt_at_ms IS NULL OR next_attempt_at_ms <= ?)
         ORDER BY updated_at_ms LIMIT ?`,
      )
      .bind(runId, nowMs, limit)
      .all<{ order_id: string }>();
    const ids = failed.results.map((row) => row.order_id);
    if (ids.length < limit) {
      const where = scopeWhere(scope);
      const guard = safetyGuard(scope, nowMs);
      const due = await this.db
        .prepare(
          `SELECT o.id FROM orders o ${dueIndex(scope)}
           WHERE o.cleanup_state = 'ACTIVE' AND ${where}
             AND o.created_at_ms <= (SELECT cutoff_at_ms FROM cleanup_runs WHERE id = ?)
             AND ${guard}
             AND NOT EXISTS (SELECT 1 FROM cleanup_run_items item
               WHERE item.run_id = ? AND item.order_id = o.id)
           ORDER BY ${scopeOrder(scope)}
           LIMIT ?`,
        )
        .bind(
          ...(scope === "EXPIRED_UNPAID" || scope === "COMPLETED_DUE"
            ? [nowMs]
            : []),
          runId,
          runId,
          limit - ids.length,
        )
        .all<{ id: string }>();
      ids.push(...due.results.map((row) => row.id));
    }
    if (ids.length === 0) return [];
    await this.db
      .prepare(
        `UPDATE cleanup_runs SET status = 'RUNNING',
         started_at_ms = COALESCE(started_at_ms, ?), updated_at_ms = ?
         WHERE id = ? AND status IN ('PENDING','RUNNING','PARTIAL')`,
      )
      .bind(nowMs, nowMs, runId)
      .run();
    const claims: D1PreparedStatement[] = [];
    const guard = safetyGuard(scope, nowMs);
    for (const orderId of ids) {
      claims.push(
        this.db
          .prepare(
            `UPDATE orders AS o SET cleanup_state = 'CLAIMED', cleanup_run_id = ?, updated_at_ms = ?
             WHERE id = ? AND cleanup_state IN ('ACTIVE','CLAIMED')
               AND (cleanup_run_id IS NULL OR cleanup_run_id = ?)
               AND ${guard}`,
          )
          .bind(runId, nowMs, orderId, runId),
        this.db
          .prepare(
            `INSERT INTO cleanup_run_items
              (run_id, order_id, status, file_count, bytes, updated_at_ms)
             SELECT ?, o.id, 'PENDING', COUNT(f.id), COALESCE(SUM(f.size_bytes), 0), ?
             FROM orders o LEFT JOIN order_files f ON f.order_id = o.id
             WHERE o.id = ? AND o.cleanup_run_id = ?
             GROUP BY o.id
             ON CONFLICT(run_id, order_id) DO UPDATE SET status = 'PENDING',
               last_error = NULL, updated_at_ms = excluded.updated_at_ms`,
          )
          .bind(runId, nowMs, orderId, runId),
      );
    }
    await this.db.batch(claims);
    const placeholders = ids.map(() => "?").join(",");
    const rows = await this.db
      .prepare(
        `SELECT o.id order_id, k.r2_object_key, k.size_bytes
         FROM orders o LEFT JOIN (
           SELECT order_id, r2_object_key, size_bytes FROM order_files
           UNION ALL
           SELECT u.order_id, u.r2_object_key, u.size_bytes FROM uploads u
             WHERE NOT EXISTS (SELECT 1 FROM order_files f
               WHERE f.order_id = u.order_id AND f.r2_object_key = u.r2_object_key)
         ) k ON k.order_id = o.id
         WHERE o.cleanup_run_id = ? AND o.id IN (${placeholders})
         ORDER BY o.id, k.r2_object_key`,
      )
      .bind(runId, ...ids)
      .all<{
        order_id: string;
        r2_object_key: string | null;
        size_bytes: number | null;
      }>();
    const grouped = new Map<string, CleanupCandidate>();
    for (const row of rows.results) {
      const candidate = grouped.get(row.order_id) ?? {
        orderId: row.order_id,
        objectKeys: [],
        fileCount: 0,
        bytes: 0,
      };
      if (row.r2_object_key) {
        candidate.objectKeys.push(row.r2_object_key);
        candidate.fileCount++;
        candidate.bytes += row.size_bytes ?? 0;
      }
      grouped.set(row.order_id, candidate);
    }
    return [...grouped.values()];
  }

  async purgeOrder(
    runId: string,
    candidate: CleanupCandidate,
    nowMs: number,
  ): Promise<void> {
    await this.db.batch([
      this.db
        .prepare("DELETE FROM retained_order_history WHERE id = ?")
        .bind(candidate.orderId),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO retained_payment_records
          (id, provider, provider_order_id, provider_payment_id, amount_paise,
           currency, status, verified_at_ms, payment_created_at_ms, purged_at_ms)
         SELECT id, provider, provider_order_id, provider_payment_id, amount_paise,
           currency, status, verified_at_ms, created_at_ms, ?
         FROM payments WHERE order_id = ?`,
        )
        .bind(nowMs, candidate.orderId),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO retained_provider_events
          (id, provider, provider_event_id, event_type, received_at_ms,
           processed_at_ms, processing_status, purged_at_ms)
         SELECT id, provider, provider_event_id, event_type, received_at_ms,
           processed_at_ms, processing_status, ?
         FROM payment_provider_events WHERE related_order_id = ? OR related_payment_id IN
           (SELECT id FROM payments WHERE order_id = ?)`,
        )
        .bind(nowMs, candidate.orderId, candidate.orderId),
      this.db
        .prepare(
          `DELETE FROM payment_provider_events WHERE related_order_id = ? OR related_payment_id IN
           (SELECT id FROM payments WHERE order_id = ?)`,
        )
        .bind(candidate.orderId, candidate.orderId),
      this.db
        .prepare("DELETE FROM print_attempt_steps WHERE order_id = ?")
        .bind(candidate.orderId),
      this.db
        .prepare("DELETE FROM print_attempts WHERE order_id = ?")
        .bind(candidate.orderId),
      this.db
        .prepare("DELETE FROM order_events WHERE order_id = ?")
        .bind(candidate.orderId),
      this.db
        .prepare(
          "UPDATE audit_logs SET entity_id = NULL, metadata_json = NULL WHERE entity_type = 'ORDER' AND entity_id = ?",
        )
        .bind(candidate.orderId),
      this.db
        .prepare("DELETE FROM payments WHERE order_id = ?")
        .bind(candidate.orderId),
      this.db
        .prepare("DELETE FROM uploads WHERE order_id = ?")
        .bind(candidate.orderId),
      this.db
        .prepare("DELETE FROM order_files WHERE order_id = ?")
        .bind(candidate.orderId),
      this.db
        .prepare("DELETE FROM order_addon_services WHERE order_id = ?")
        .bind(candidate.orderId),
      this.db
        .prepare(
          "DELETE FROM orders WHERE id = ? AND cleanup_run_id = ? AND cleanup_state = 'CLAIMED'",
        )
        .bind(candidate.orderId, runId),
      this.db
        .prepare(
          `UPDATE cleanup_run_items SET status = 'DELETED', last_error = NULL,
         updated_at_ms = ? WHERE run_id = ? AND order_id = ?`,
        )
        .bind(nowMs, runId, candidate.orderId),
      this.db
        .prepare(
          `UPDATE cleanup_runs SET orders_deleted = orders_deleted + 1,
         files_deleted = files_deleted + ?, bytes_deleted = bytes_deleted + ?,
         updated_at_ms = ? WHERE id = ?`,
        )
        .bind(candidate.fileCount, candidate.bytes, nowMs, runId),
    ]);
  }

  async recordFailure(
    runId: string,
    orderId: string,
    error: string,
    nowMs: number,
  ): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE cleanup_run_items SET status = 'FAILED', last_error = ?,
           attempt_count = attempt_count + 1,
           next_attempt_at_ms = ? + MIN(3600000, 300000 * (1 << MIN(attempt_count, 4))),
           updated_at_ms = ?
         WHERE run_id = ? AND order_id = ?`,
        )
        .bind(error.slice(0, 500), nowMs, nowMs, runId, orderId),
      this.db
        .prepare(
          `UPDATE cleanup_runs SET failures = failures + 1, status = 'PARTIAL',
         last_error = ?, updated_at_ms = ? WHERE id = ?`,
        )
        .bind(error.slice(0, 500), nowMs, runId),
    ]);
  }

  async finishIfDrained(
    runId: string,
    scope: CleanupScope,
    nowMs: number,
  ): Promise<boolean> {
    const where = scopeWhere(scope);
    const guard = safetyGuard(scope, nowMs);
    const remainingGuard =
      scope === "ALL_PRINT_DATA" || scope === "ALL_COMPLETED" ? "1 = 1" : guard;
    const remaining = await this.db
      .prepare(
        `SELECT 1 remaining FROM orders o
         WHERE o.cleanup_run_id = ? AND o.cleanup_state = 'CLAIMED'
         UNION ALL
         SELECT 1 FROM cleanup_run_items
         WHERE run_id = ? AND status IN ('PENDING','FAILED')
         UNION ALL
         SELECT 1 FROM orders o ${dueIndex(scope)}
         WHERE o.cleanup_state = 'ACTIVE' AND ${where}
           AND o.created_at_ms <= (SELECT cutoff_at_ms FROM cleanup_runs WHERE id = ?)
           AND ${remainingGuard}
           AND NOT EXISTS (SELECT 1 FROM cleanup_run_items item
             WHERE item.run_id = ? AND item.order_id = o.id)
         LIMIT 1`,
      )
      .bind(
        runId,
        runId,
        ...(scope === "EXPIRED_UNPAID" || scope === "COMPLETED_DUE"
          ? [nowMs]
          : []),
        runId,
        runId,
      )
      .first<{ remaining: number }>();
    if (remaining) return false;
    const result = await this.db
      .prepare(
        `UPDATE cleanup_runs SET status = 'COMPLETED',
         completed_at_ms = ?, updated_at_ms = ? WHERE id = ?
           AND status IN ('PENDING','RUNNING','PARTIAL')
           AND NOT EXISTS (SELECT 1 FROM cleanup_run_items
             WHERE run_id = ? AND status IN ('PENDING','FAILED'))`,
      )
      .bind(nowMs, nowMs, runId, runId)
      .run();
    return result.meta.changes === 1;
  }

  async dailySettings(): Promise<{
    enabled: boolean;
    time: string;
    timezone: string;
    nextAtMs: number | null;
  }> {
    const row = await this.db
      .prepare(
        `SELECT automatic_daily_cleanup_enabled, daily_cleanup_time, timezone,
       next_daily_cleanup_at_ms FROM installation WHERE id = 1`,
      )
      .first<{
        automatic_daily_cleanup_enabled: number;
        daily_cleanup_time: string;
        timezone: string;
        next_daily_cleanup_at_ms: number | null;
      }>();
    return {
      enabled: row?.automatic_daily_cleanup_enabled === 1,
      time: row?.daily_cleanup_time ?? "23:30",
      timezone: row?.timezone ?? "Asia/Kolkata",
      nextAtMs: row?.next_daily_cleanup_at_ms ?? null,
    };
  }

  async advanceDailySchedule(
    expected: number | null,
    next: number,
    nowMs: number,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE installation SET next_daily_cleanup_at_ms = ?, updated_at_ms = ?
       WHERE id = 1 AND automatic_daily_cleanup_enabled = 1
         AND next_daily_cleanup_at_ms IS ?`,
      )
      .bind(next, nowMs, expected)
      .run();
    return result.meta.changes === 1;
  }

  async recordCleanupResult(
    run: AdminCleanupRunData,
    nowMs: number,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE installation SET last_cleanup_at_ms = ?, last_cleanup_result = ?, updated_at_ms = ?
       WHERE id = 1`,
      )
      .bind(
        nowMs,
        `${run.deletedOrders} orders / ${run.deletedFiles} PDFs deleted${run.failures ? `, ${run.failures} failed` : ""}`,
        nowMs,
      )
      .run();
  }

  async recordDailyResult(
    run: AdminCleanupRunData,
    nowMs: number,
  ): Promise<void> {
    return this.recordCleanupResult(run, nowMs);
  }
}
