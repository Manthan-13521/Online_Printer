import type { AdminOrderHistoryEntry } from "@printgo/api-contract";

interface HistoryRow {
  id: string;
  customer_name: string | null;
  customer_phone: string | null;
  created_at_ms: number;
  completed_at_ms: number | null;
  pickup_code: string | null;
  is_priority: number;
  is_manual: number;
  addon_summary_json: string;
  online_paid_paise: number;
  due_at_pickup_paise: number;
  final_status: string;
  printer_name: string | null;
  fallback_printer_name: string | null;
  attempt_count: number;
  failure_json: string;
  purged: number;
}

export class D1OrderHistoryRepository {
  constructor(private readonly db: D1Database) {}

  async list(
    cursor: string | null,
    limit = 20,
  ): Promise<{
    orders: AdminOrderHistoryEntry[];
    nextCursor: string | null;
  }> {
    const boundedLimit = Math.max(1, Math.min(limit, 50));
    const match = cursor && /^(\d+):([0-9a-f-]{36})$/iu.exec(cursor);
    if (cursor && !match) throw new Error("INVALID_HISTORY_CURSOR");
    const beforeMs = match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
    const beforeId = match ? match[2] : "ffffffff-ffff-ffff-ffff-ffffffffffff";
    if (!Number.isSafeInteger(beforeMs))
      throw new Error("INVALID_HISTORY_CURSOR");

    const result = await this.db
      .prepare(
        `WITH page AS (
           SELECT id, created_at_ms FROM orders
           WHERE (created_at_ms, id) < (?, ?)
             AND status NOT IN ('CREATED', 'UPLOADING', 'UPLOADED', 'PAYMENT_PENDING', 'PAYMENT_FAILED', 'PAYMENT_CANCELLED')
             AND (
               pickup_code IS NOT NULL
               OR public_job_code IS NOT NULL
               OR paid_at_ms IS NOT NULL
               OR EXISTS (SELECT 1 FROM payments p WHERE p.order_id = orders.id AND p.status = 'PAID')
               OR status = 'MANUAL_PRINT'
               OR EXISTS (
                 SELECT 1 FROM order_addon_services s WHERE s.order_id = orders.id
                   AND s.snapshot_handling_mode = 'MANUAL_PRINT'
               )
               OR EXISTS (
                 SELECT 1 FROM order_events e WHERE e.order_id = orders.id
                   AND e.event_type IN ('ORDER_MANUALLY_COMPLETED','ORDER_MANUALLY_PRINTED')
               )
             )
           ORDER BY created_at_ms DESC, id DESC LIMIT ?
         )
         SELECT o.id, o.customer_name, o.customer_phone, o.created_at_ms, o.completed_at_ms, o.pickup_code,
           o.is_priority,
           CASE WHEN o.status = 'MANUAL_PRINT' OR EXISTS (
             SELECT 1 FROM order_addon_services s WHERE s.order_id = o.id
               AND s.snapshot_handling_mode = 'MANUAL_PRINT') OR EXISTS (
             SELECT 1 FROM order_events e WHERE e.order_id = o.id
               AND e.event_type IN ('ORDER_MANUALLY_COMPLETED','ORDER_MANUALLY_PRINTED'))
             THEN 1 ELSE 0 END is_manual,
           COALESCE((SELECT json_group_array(json_object('name', s.snapshot_name,
             'onlinePricePaise', s.snapshot_price_charged_online_paise,
             'handlingMode', s.snapshot_handling_mode))
             FROM order_addon_services s WHERE s.order_id = o.id), '[]') addon_summary_json,
           COALESCE((SELECT MAX(pay.amount_paise) FROM payments pay
             WHERE pay.order_id = o.id AND pay.status = 'PAID'), 0) online_paid_paise,
           o.due_at_pickup_paise, o.status final_status,
           (SELECT pr.display_name FROM print_attempts a JOIN printers pr ON pr.id = a.printer_id
             WHERE a.order_id = o.id ORDER BY a.attempt_number DESC LIMIT 1) printer_name,
           (SELECT pr.display_name FROM print_attempts a JOIN printers pr ON pr.id = a.printer_id
             WHERE a.order_id = o.id AND a.fallback_from_printer_id IS NOT NULL
             ORDER BY a.attempt_number DESC LIMIT 1) fallback_printer_name,
           (SELECT COUNT(*) FROM print_attempts a WHERE a.order_id = o.id) attempt_count,
           COALESCE((SELECT json_group_array(json_object('status', st.status,
             'code', st.failure_code, 'at', st.updated_at_ms))
             FROM print_attempt_steps st WHERE st.order_id = o.id
               AND st.status IN ('FAILED','BLOCKED','UNCERTAIN')), '[]') failure_json,
           CASE WHEN EXISTS (
             SELECT 1 FROM uploads u WHERE u.order_id = o.id
               AND u.storage_status = 'UPLOADED' AND u.deleted_at_ms IS NULL
           ) THEN 0 ELSE 1 END purged
         FROM page JOIN orders o ON o.id = page.id
         ORDER BY 2 DESC, 1 DESC`,
      )
      .bind(beforeMs, beforeId, boundedLimit + 1)
      .all<HistoryRow>();
    const rows = result.results.slice(0, boundedLimit);
    return {
      orders: rows.map((row) => ({
        orderId: row.id,
        pickupCode: row.pickup_code,
        customerName: row.customer_name ?? null,
        customerPhone: row.customer_phone ?? null,
        createdAt: new Date(row.created_at_ms).toISOString(),
        completedAt:
          row.completed_at_ms === null
            ? null
            : new Date(row.completed_at_ms).toISOString(),
        isPriority: row.is_priority === 1,
        isManual: row.is_manual === 1,
        addonServices: JSON.parse(
          row.addon_summary_json,
        ) as AdminOrderHistoryEntry["addonServices"],
        onlinePaidPaise: row.online_paid_paise,
        dueAtPickupPaise: row.due_at_pickup_paise,
        status: row.final_status,
        printerUsed: row.printer_name,
        fallbackPrinter: row.fallback_printer_name,
        attemptCount: row.attempt_count,
        failureHistory: (
          JSON.parse(row.failure_json) as ({
            status: string;
            code: string | null;
            at: number | null;
          } | null)[]
        )
          .filter(
            (
              item,
            ): item is {
              status: string;
              code: string | null;
              at: number | null;
            } => item !== null,
          )
          .map((item) => ({
            status: item.status,
            code: item.code,
            at: item.at === null ? null : new Date(item.at).toISOString(),
          })),
        purged: row.purged === 1,
      })),
      nextCursor:
        result.results.length > boundedLimit && rows.length > 0
          ? `${rows[rows.length - 1]!.created_at_ms}:${rows[rows.length - 1]!.id}`
          : null,
    };
  }
}
