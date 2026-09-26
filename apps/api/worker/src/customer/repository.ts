import type { CustomerConfigData } from "@printgo/api-contract";
import type { PricingConfiguration } from "@printgo/pricing";

export interface CustomerDraftRecord {
  orderId: string;
  uploadId: string;
  objectKey: string;
  expectedSizeBytes: number;
  actualSizeBytes: number | null;
  sourcePageCount: number;
  status: string;
  storageStatus: string;
  expiresAtMs: number;
}

export interface CustomerRepository {
  getPublicConfig(): Promise<CustomerConfigData | null>;
  getPricingConfiguration(): Promise<PricingConfiguration>;
  getDefaultPrintOption(): Promise<{
    paperSize: "A4" | "A3";
    colorMode: "BW" | "COLOR";
    sides: "SINGLE" | "DOUBLE";
  } | null>;
  createDraft(input: {
    orderId: string;
    uploadId: string;
    tokenHash: string;
    objectKey: string;
    customerName: string;
    customerPhone: string;
    instructions: string | null;
    originalFilename: string;
    expectedSizeBytes: number;
    sourcePageCount: number;
    paperSize: "A4" | "A3";
    colorMode: "BW" | "COLOR";
    sides: "SINGLE" | "DOUBLE";
    nowMs: number;
    expiresAtMs: number;
  }): Promise<void>;
  findDraft(tokenHash: string): Promise<CustomerDraftRecord | null>;
  markUploadValidated(input: {
    orderId: string;
    uploadId: string;
    actualSizeBytes: number;
    nowMs: number;
    expiresAtMs: number;
  }): Promise<void>;
  markValidationFailure(
    uploadId: string,
    code: string,
    nowMs: number,
  ): Promise<void>;
  saveQuote(input: {
    orderId: string;
    selectedPages: string;
    copies: number;
    paperSize: "A4" | "A3";
    colorMode: "BW" | "COLOR";
    sides: "SINGLE" | "DOUBLE";
    printingAmountPaise: number;
    serviceChargePaise: number;
    totalAmountPaise: number;
    nowMs: number;
  }): Promise<void>;
}

interface DraftRow {
  order_id: string;
  upload_id: string;
  r2_object_key: string;
  expected_size_bytes: number;
  size_bytes: number | null;
  source_page_count: number;
  status: string;
  storage_status: string;
  draft_expires_at_ms: number;
}

export class D1CustomerRepository implements CustomerRepository {
  constructor(private readonly db: D1Database) {}

  async getPublicConfig(): Promise<CustomerConfigData | null> {
    const installation = await this.db
      .prepare(
        `SELECT shop_name, contact_phone, customer_notice,
                       online_printing_enabled, max_pdf_size_bytes
                FROM installation WHERE id = 1`,
      )
      .first<{
        shop_name: string;
        contact_phone: string | null;
        customer_notice: string | null;
        online_printing_enabled: number;
        max_pdf_size_bytes: number;
      }>();
    if (!installation) return null;
    const rates = await this.db
      .prepare(
        `SELECT paper_size, color_mode, sides FROM print_rates
                WHERE enabled = 1 ORDER BY paper_size, color_mode, sides`,
      )
      .all<{
        paper_size: "A4" | "A3";
        color_mode: "BW" | "COLOR";
        sides: "SINGLE" | "DOUBLE";
      }>();
    return {
      shopName: installation.shop_name,
      contactPhone: installation.contact_phone,
      customerNotice: installation.customer_notice,
      onlinePrintingEnabled: installation.online_printing_enabled === 1,
      maxPdfSizeBytes: installation.max_pdf_size_bytes,
      availablePrintOptions: rates.results.map((rate) => ({
        paperSize: rate.paper_size,
        colorMode: rate.color_mode,
        sides: rate.sides,
      })),
    };
  }

  async getPricingConfiguration(): Promise<PricingConfiguration> {
    const config = await this.getPublicConfig();
    if (!config) throw new Error("Installation configuration missing.");
    const [rateResult, bandResult] = await this.db.batch([
      this.db
        .prepare(`SELECT paper_size, color_mode, sides, price_per_page_paise, enabled
                       FROM print_rates`),
      this.db
        .prepare(`SELECT min_bytes_exclusive, max_bytes_inclusive, charge_paise, enabled
                       FROM file_size_service_charges ORDER BY sort_order`),
    ]);
    if (!rateResult || !bandResult) {
      throw new Error("Pricing configuration could not be loaded.");
    }
    return {
      maxPdfSizeBytes: config.maxPdfSizeBytes,
      printRates: (rateResult.results as Array<Record<string, unknown>>).map(
        (row) => ({
          paperSize: row.paper_size as "A4" | "A3",
          colorMode: row.color_mode as "BW" | "COLOR",
          sides: row.sides as "SINGLE" | "DOUBLE",
          pricePerPagePaise: row.price_per_page_paise as number,
          enabled: row.enabled === 1,
        }),
      ),
      fileSizeServiceCharges: (
        bandResult.results as Array<Record<string, unknown>>
      ).map((row) => ({
        minBytesExclusive: row.min_bytes_exclusive as number,
        maxBytesInclusive: row.max_bytes_inclusive as number,
        chargePaise: row.charge_paise as number,
        enabled: row.enabled === 1,
      })),
    };
  }

  async getDefaultPrintOption() {
    const row = await this.db
      .prepare(
        `SELECT paper_size, color_mode, sides FROM print_rates
                WHERE enabled = 1 ORDER BY paper_size, color_mode, sides LIMIT 1`,
      )
      .first<{
        paper_size: "A4" | "A3";
        color_mode: "BW" | "COLOR";
        sides: "SINGLE" | "DOUBLE";
      }>();
    return row
      ? {
          paperSize: row.paper_size,
          colorMode: row.color_mode,
          sides: row.sides,
        }
      : null;
  }

  async createDraft(
    input: Parameters<CustomerRepository["createDraft"]>[0],
  ): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO orders
        (id, customer_name, customer_phone, original_filename, source_page_count,
         color_mode, paper_size, sides, instructions, status, created_at_ms,
         updated_at_ms, draft_token_hash, draft_expires_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'UPLOADING', ?, ?, ?, ?)`,
        )
        .bind(
          input.orderId,
          input.customerName,
          input.customerPhone,
          input.originalFilename,
          input.sourcePageCount,
          input.colorMode,
          input.paperSize,
          input.sides,
          input.instructions,
          input.nowMs,
          input.nowMs,
          input.tokenHash,
          input.expiresAtMs,
        ),
      this.db
        .prepare(
          `INSERT INTO uploads
        (id, order_id, r2_object_key, original_filename, storage_status,
         retention_reason, delete_after_ms, created_at_ms, updated_at_ms,
         expected_size_bytes)
        VALUES (?, ?, ?, ?, 'PENDING', 'UNPAID', ?, ?, ?, ?)`,
        )
        .bind(
          input.uploadId,
          input.orderId,
          input.objectKey,
          input.originalFilename,
          input.expiresAtMs,
          input.nowMs,
          input.nowMs,
          input.expectedSizeBytes,
        ),
    ]);
  }

  async findDraft(tokenHash: string): Promise<CustomerDraftRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT o.id AS order_id, u.id AS upload_id,
      u.r2_object_key, u.expected_size_bytes, u.size_bytes, o.source_page_count,
      o.status, u.storage_status, o.draft_expires_at_ms
      FROM orders o JOIN uploads u ON u.order_id = o.id
      WHERE o.draft_token_hash = ?`,
      )
      .bind(tokenHash)
      .first<DraftRow>();
    return row
      ? {
          orderId: row.order_id,
          uploadId: row.upload_id,
          objectKey: row.r2_object_key,
          expectedSizeBytes: row.expected_size_bytes,
          actualSizeBytes: row.size_bytes,
          sourcePageCount: row.source_page_count,
          status: row.status,
          storageStatus: row.storage_status,
          expiresAtMs: row.draft_expires_at_ms,
        }
      : null;
  }

  async markUploadValidated(
    input: Parameters<CustomerRepository["markUploadValidated"]>[0],
  ): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE uploads SET size_bytes = ?, mime_type = 'application/pdf',
        storage_status = 'UPLOADED', uploaded_at_ms = ?, updated_at_ms = ?,
        delete_after_ms = ?, validation_error_code = NULL WHERE id = ?`,
        )
        .bind(
          input.actualSizeBytes,
          input.nowMs,
          input.nowMs,
          input.expiresAtMs,
          input.uploadId,
        ),
      this.db
        .prepare(
          `UPDATE orders SET status = 'UPLOADED', updated_at_ms = ?,
        draft_expires_at_ms = ? WHERE id = ? AND status = 'UPLOADING'`,
        )
        .bind(input.nowMs, input.expiresAtMs, input.orderId),
    ]);
  }

  async markValidationFailure(
    uploadId: string,
    code: string,
    nowMs: number,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE uploads SET validation_error_code = ?, updated_at_ms = ?
      WHERE id = ? AND storage_status = 'PENDING'`,
      )
      .bind(code, nowMs, uploadId)
      .run();
  }

  async saveQuote(
    input: Parameters<CustomerRepository["saveQuote"]>[0],
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE orders SET selected_pages = ?, copies = ?, paper_size = ?,
      color_mode = ?, sides = ?, printing_amount_paise = ?, service_charge_paise = ?,
      total_amount_paise = ?, status = 'PAYMENT_PENDING', updated_at_ms = ?
      WHERE id = ? AND status IN ('UPLOADED', 'PAYMENT_PENDING')`,
      )
      .bind(
        input.selectedPages,
        input.copies,
        input.paperSize,
        input.colorMode,
        input.sides,
        input.printingAmountPaise,
        input.serviceChargePaise,
        input.totalAmountPaise,
        input.nowMs,
        input.orderId,
      )
      .run();
  }
}
