import type {
  ColorMode,
  OrderStatus,
  PaperSize,
  SidesMode,
  UploadStorageStatus,
} from "@printgo/domain";

export interface TrackingAuthorizationRecord {
  orderId: string;
  jobCode: string | null;
  orderStatus: OrderStatus;
  tokenHash: string | null;
  createdAtMs: number | null;
  expiresAtMs: number | null;
}

export interface CustomerTrackingRecord {
  orderId: string;
  jobCode: string;
  customerName: string;
  orderStatus: OrderStatus;
  submittedAtMs: number;
  updatedAtMs: number;
  paidAtMs: number;
  selectedPages: string;
  copies: number;
  paperSize: PaperSize;
  colorMode: ColorMode;
  sides: SidesMode;
  amountPaidPaise: number;
  currency: "INR";
  instructions: string | null;
  storageStatus: UploadStorageStatus;
  deleteAfterMs: number | null;
  piiPurgedAtMs: number | null;
  trackingExpiresAtMs: number;
}

export interface TrackingEventRecord {
  eventType: string;
  toStatus: OrderStatus | null;
  createdAtMs: number;
}

interface AuthorizationRow {
  id: string;
  public_job_code: string | null;
  status: OrderStatus;
  tracking_token_hash: string | null;
  tracking_created_at_ms: number | null;
  tracking_expires_at_ms: number | null;
}

interface TrackingRow {
  id: string;
  public_job_code: string;
  customer_name: string;
  status: OrderStatus;
  created_at_ms: number;
  updated_at_ms: number;
  paid_at_ms: number;
  selected_pages: string;
  copies: number;
  paper_size: PaperSize;
  color_mode: ColorMode;
  sides: SidesMode;
  amount_paise: number;
  currency: "INR";
  instructions: string | null;
  storage_status: UploadStorageStatus;
  delete_after_ms: number | null;
  pii_purged_at_ms: number | null;
  tracking_expires_at_ms: number;
}

interface EventRow {
  event_type: string;
  to_status: OrderStatus | null;
  created_at_ms: number;
}

function mapAuthorization(
  row: AuthorizationRow | null,
): TrackingAuthorizationRecord | null {
  return row
    ? {
        orderId: row.id,
        jobCode: row.public_job_code,
        orderStatus: row.status,
        tokenHash: row.tracking_token_hash,
        createdAtMs: row.tracking_created_at_ms,
        expiresAtMs: row.tracking_expires_at_ms,
      }
    : null;
}

export interface TrackingRepository {
  findAuthorization(
    orderId: string,
  ): Promise<TrackingAuthorizationRecord | null>;
  createAuthorization(input: {
    orderId: string;
    tokenHash: string;
    createdAtMs: number;
    expiresAtMs: number;
  }): Promise<boolean>;
  findByCredential(
    jobCode: string,
    tokenHash: string,
  ): Promise<CustomerTrackingRecord | null>;
  listSafeTimeline(orderId: string): Promise<TrackingEventRecord[]>;
}

export class D1TrackingRepository implements TrackingRepository {
  constructor(private readonly db: D1Database) {}

  async findAuthorization(
    orderId: string,
  ): Promise<TrackingAuthorizationRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT id, public_job_code, status, tracking_token_hash,
          tracking_created_at_ms, tracking_expires_at_ms
        FROM orders WHERE id = ?`,
      )
      .bind(orderId)
      .first<AuthorizationRow>();
    return mapAuthorization(row);
  }

  async createAuthorization(
    input: Parameters<TrackingRepository["createAuthorization"]>[0],
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE orders SET tracking_token_hash = ?, tracking_created_at_ms = ?,
          tracking_expires_at_ms = ?, updated_at_ms = ?
        WHERE id = ? AND tracking_token_hash IS NULL
          AND public_job_code IS NOT NULL
          AND status IN ('PAID', 'QUEUED', 'CLAIMED', 'SPOOLING', 'PRINTING',
            'PRINT_BLOCKED', 'PRINT_FAILED', 'RETRY_PENDING', 'NEEDS_ADMIN',
            'COMPLETION_UNKNOWN', 'ADMIN_ACTION_REQUIRED', 'PRINTED',
            'MANUAL_PRINT', 'AWAITING_FINISHING', 'COMPLETED', 'CANCELLED')`,
      )
      .bind(
        input.tokenHash,
        input.createdAtMs,
        input.expiresAtMs,
        input.createdAtMs,
        input.orderId,
      )
      .run();
    return result.meta.changes === 1;
  }

  async findByCredential(
    jobCode: string,
    tokenHash: string,
  ): Promise<CustomerTrackingRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT o.id, o.public_job_code, o.customer_name, o.status,
          o.created_at_ms, o.updated_at_ms, o.paid_at_ms, o.selected_pages,
          o.copies, o.paper_size, o.color_mode, o.sides, o.instructions,
          o.pii_purged_at_ms, o.tracking_expires_at_ms, p.amount_paise, p.currency,
          u.storage_status, u.delete_after_ms
        FROM orders o
        JOIN uploads u ON u.order_id = o.id
        JOIN payments p ON p.order_id = o.id AND p.status = 'PAID'
        WHERE o.public_job_code = ? AND o.tracking_token_hash = ?
          AND o.tracking_created_at_ms IS NOT NULL
          AND o.tracking_expires_at_ms IS NOT NULL
          AND o.paid_at_ms IS NOT NULL
        ORDER BY p.verified_at_ms DESC LIMIT 1`,
      )
      .bind(jobCode, tokenHash)
      .first<TrackingRow>();
    return row
      ? {
          orderId: row.id,
          jobCode: row.public_job_code,
          customerName: row.customer_name,
          orderStatus: row.status,
          submittedAtMs: row.created_at_ms,
          updatedAtMs: row.updated_at_ms,
          paidAtMs: row.paid_at_ms,
          selectedPages: row.selected_pages,
          copies: row.copies,
          paperSize: row.paper_size,
          colorMode: row.color_mode,
          sides: row.sides,
          amountPaidPaise: row.amount_paise,
          currency: row.currency,
          instructions: row.instructions,
          storageStatus: row.storage_status,
          deleteAfterMs: row.delete_after_ms,
          piiPurgedAtMs: row.pii_purged_at_ms,
          trackingExpiresAtMs: row.tracking_expires_at_ms,
        }
      : null;
  }

  async listSafeTimeline(orderId: string): Promise<TrackingEventRecord[]> {
    const result = await this.db
      .prepare(
        `SELECT event_type, to_status, created_at_ms
        FROM order_events
        WHERE order_id = ? AND (
          event_type = 'PAYMENT_VERIFIED' OR
          to_status IN ('QUEUED', 'CLAIMED', 'SPOOLING', 'PRINTING',
            'PRINT_BLOCKED', 'PRINT_FAILED', 'RETRY_PENDING', 'NEEDS_ADMIN',
            'COMPLETION_UNKNOWN', 'ADMIN_ACTION_REQUIRED',
            'MANUAL_PRINT', 'AWAITING_FINISHING',
            'PRINTED', 'COMPLETED', 'CANCELLED')
        )
        ORDER BY created_at_ms ASC, id ASC`,
      )
      .bind(orderId)
      .all<EventRow>();
    return result.results.map((row) => ({
      eventType: row.event_type,
      toStatus: row.to_status,
      createdAtMs: row.created_at_ms,
    }));
  }
}
