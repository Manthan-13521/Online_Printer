import type {
  CustomerConfigData,
  HandlingMode,
  OrderAddonServiceSnapshot,
  PricingType,
} from "@printgo/api-contract";
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

export interface CustomerFileRecord {
  id: string;
  orderId: string;
  position: number;
  originalFilename: string;
  objectKey: string;
  expectedSizeBytes: number;
  actualSizeBytes: number | null;
  sourcePageCount: number;
  selectedPages: string;
  selectedPageCount: number | null;
  copies: number;
  paperSize: "A4" | "A3";
  colorMode: "BW" | "COLOR";
  sides: "SINGLE" | "DOUBLE";
  printingAmountPaise: number;
  serviceChargePaise: number;
  uploadStatus: string;
  printStatus: string;
  expiresAtMs: number;
}

export interface CustomerDraftSummary {
  orderId: string;
  customerName: string;
  customerPhone: string;
  instructions: string | null;
  status: string;
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
  findDraftSummary(tokenHash: string): Promise<CustomerDraftSummary | null>;
  listFiles(tokenHash: string): Promise<CustomerFileRecord[]>;
  findFile(
    tokenHash: string,
    fileId?: string,
  ): Promise<CustomerFileRecord | null>;
  claimFileRemoval(
    tokenHash: string,
    fileId: string,
    nowMs: number,
  ): Promise<boolean>;
  markFileRemovalFailed(fileId: string, nowMs: number): Promise<void>;
  addFile(input: {
    tokenHash: string;
    fileId: string;
    objectKey: string;
    originalFilename: string;
    expectedSizeBytes: number;
    sourcePageCount: number;
    paperSize: "A4" | "A3";
    colorMode: "BW" | "COLOR";
    sides: "SINGLE" | "DOUBLE";
    nowMs: number;
    expiresAtMs: number;
  }): Promise<CustomerFileRecord | null>;
  deleteFile(
    tokenHash: string,
    fileId: string,
    nowMs: number,
  ): Promise<boolean>;
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
  saveOrderQuote(input: {
    tokenHash: string;
    files: Array<{
      fileId: string;
      selectedPages: string;
      selectedPageCount: number;
      copies: number;
      paperSize: "A4" | "A3";
      colorMode: "BW" | "COLOR";
      sides: "SINGLE" | "DOUBLE";
      printingAmountPaise: number;
      serviceChargePaise: number;
    }>;
    printingAmountPaise: number;
    serviceChargePaise: number;
    totalAmountPaise: number;
    nowMs: number;
    expiresAtMs: number;
  }): Promise<boolean>;
  snapshotAddonServices(
    orderId: string,
    serviceIds: readonly string[],
  ): Promise<void>;
  getOrderAddonAmountPaise(orderId: string): Promise<number>;
  getOrderAddonSnapshots(orderId: string): Promise<OrderAddonServiceSnapshot[]>;
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

interface FileRow {
  id: string;
  order_id: string;
  position: number;
  original_filename: string;
  r2_object_key: string;
  expected_size_bytes: number;
  size_bytes: number | null;
  source_page_count: number;
  selected_pages: string;
  selected_page_count: number | null;
  copies: number;
  paper_size: "A4" | "A3";
  color_mode: "BW" | "COLOR";
  sides: "SINGLE" | "DOUBLE";
  printing_amount_paise: number;
  service_charge_paise: number;
  upload_status: string;
  print_status: string;
  draft_expires_at_ms: number;
}

function mapFile(row: FileRow): CustomerFileRecord {
  return {
    id: row.id,
    orderId: row.order_id,
    position: row.position,
    originalFilename: row.original_filename,
    objectKey: row.r2_object_key,
    expectedSizeBytes: row.expected_size_bytes,
    actualSizeBytes: row.size_bytes,
    sourcePageCount: row.source_page_count,
    selectedPages: row.selected_pages,
    selectedPageCount: row.selected_page_count,
    copies: row.copies,
    paperSize: row.paper_size,
    colorMode: row.color_mode,
    sides: row.sides,
    printingAmountPaise: row.printing_amount_paise,
    serviceChargePaise: row.service_charge_paise,
    uploadStatus: row.upload_status,
    printStatus: row.print_status,
    expiresAtMs: row.draft_expires_at_ms,
  };
}

const FILE_SELECT = `SELECT f.id, f.order_id, f.position, f.original_filename,
  f.r2_object_key, f.expected_size_bytes, f.size_bytes, f.source_page_count,
  f.selected_pages, f.selected_page_count, f.copies, f.paper_size,
  f.color_mode, f.sides, f.printing_amount_paise, f.service_charge_paise,
  f.upload_status, f.print_status, o.draft_expires_at_ms
  FROM order_files f JOIN orders o ON o.id = f.order_id`;

export class D1CustomerRepository implements CustomerRepository {
  constructor(private readonly db: D1Database) {}

  async getPublicConfig(): Promise<CustomerConfigData | null> {
    const [installationResult, ratesResult, addonsResult] = await this.db.batch(
      [
        this.db.prepare(
          `SELECT logo_key, app_name, shop_name, contact_phone, address, customer_notice,
                online_printing_enabled, max_pdf_size_bytes, max_order_upload_bytes
         FROM installation WHERE id = 1`,
        ),
        this.db.prepare(
          `SELECT paper_size, color_mode, sides, price_per_page_paise FROM print_rates
         WHERE enabled = 1 ORDER BY paper_size, color_mode, sides`,
        ),
        this.db.prepare(
          `SELECT id, name, pricing_type, fixed_price_paise
         FROM addon_services WHERE enabled = 1
         ORDER BY display_order, name`,
        ),
      ],
    );

    const installation = installationResult?.results[0] as
      | {
          logo_key: string | null;
          app_name: string;
          shop_name: string;
          contact_phone: string | null;
          address: string | null;
          customer_notice: string | null;
          online_printing_enabled: number;
          max_pdf_size_bytes: number;
          max_order_upload_bytes: number;
        }
      | undefined;
    if (!installation) return null;

    return {
      appName: installation.app_name,
      shopName: installation.shop_name,
      logoUrl: installation.logo_key
        ? `/api/branding/logo/${installation.logo_key.slice("branding/".length)}`
        : null,
      contactPhone: installation.contact_phone,
      address: installation.address,
      customerNotice: installation.customer_notice,
      onlinePrintingEnabled: installation.online_printing_enabled === 1,
      maxPdfSizeBytes: installation.max_pdf_size_bytes,
      maxOrderUploadBytes: installation.max_order_upload_bytes,
      maxOrderFiles: 10,
      availablePrintOptions: (
        (ratesResult?.results ?? []) as Array<{
          paper_size: "A4" | "A3";
          color_mode: "BW" | "COLOR";
          sides: "SINGLE" | "DOUBLE";
          price_per_page_paise: number;
        }>
      ).map((rate) => ({
        paperSize: rate.paper_size,
        colorMode: rate.color_mode,
        sides: rate.sides,
        pricePerPagePaise: rate.price_per_page_paise,
      })),
      addonServices: (
        (addonsResult?.results ?? []) as Array<{
          id: string;
          name: string;
          pricing_type: string;
          fixed_price_paise: number;
        }>
      ).map((row) => ({
        id: row.id,
        name: row.name,
        pricingType: row.pricing_type as "FIXED_PRICE" | "STAFF_PRICED",
        fixedPricePaise: row.fixed_price_paise,
      })),
    };
  }

  async getPricingConfiguration(): Promise<PricingConfiguration> {
    const [installationResult, rateResult, bandResult] = await this.db.batch([
      this.db.prepare(
        `SELECT max_pdf_size_bytes FROM installation WHERE id = 1`,
      ),
      this.db.prepare(
        `SELECT paper_size, color_mode, sides, price_per_page_paise, enabled FROM print_rates`,
      ),
      this.db.prepare(
        `SELECT min_bytes_exclusive, max_bytes_inclusive, charge_paise, enabled
         FROM file_size_service_charges ORDER BY sort_order`,
      ),
    ]);
    const maxPdfSizeBytes = (
      installationResult?.results[0] as
        { max_pdf_size_bytes?: number } | undefined
    )?.max_pdf_size_bytes;
    if (!maxPdfSizeBytes || !rateResult || !bandResult) {
      throw new Error("Pricing configuration could not be loaded.");
    }
    return {
      maxPdfSizeBytes,
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
      this.db
        .prepare(
          `INSERT INTO order_files
          (id, order_id, position, original_filename, r2_object_key,
           expected_size_bytes, source_page_count, paper_size, color_mode, sides,
           created_at_ms, updated_at_ms)
          VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          input.uploadId,
          input.orderId,
          input.originalFilename,
          input.objectKey,
          input.expectedSizeBytes,
          input.sourcePageCount,
          input.paperSize,
          input.colorMode,
          input.sides,
          input.nowMs,
          input.nowMs,
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

  async findDraftSummary(
    tokenHash: string,
  ): Promise<CustomerDraftSummary | null> {
    const row = await this.db
      .prepare(
        `SELECT id, customer_name, customer_phone, instructions, status,
                draft_expires_at_ms
         FROM orders WHERE draft_token_hash = ? AND cleanup_state = 'ACTIVE'`,
      )
      .bind(tokenHash)
      .first<{
        id: string;
        customer_name: string;
        customer_phone: string;
        instructions: string | null;
        status: string;
        draft_expires_at_ms: number;
      }>();
    return row
      ? {
          orderId: row.id,
          customerName: row.customer_name,
          customerPhone: row.customer_phone,
          instructions: row.instructions,
          status: row.status,
          expiresAtMs: row.draft_expires_at_ms,
        }
      : null;
  }

  async listFiles(tokenHash: string): Promise<CustomerFileRecord[]> {
    const result = await this.db
      .prepare(
        `${FILE_SELECT}
         WHERE o.draft_token_hash = ? AND o.cleanup_state = 'ACTIVE'
         ORDER BY f.position`,
      )
      .bind(tokenHash)
      .all<FileRow>();
    return result.results.map(mapFile);
  }

  async findFile(
    tokenHash: string,
    fileId?: string,
  ): Promise<CustomerFileRecord | null> {
    const row = await this.db
      .prepare(
        `${FILE_SELECT}
         WHERE o.draft_token_hash = ? AND o.cleanup_state = 'ACTIVE'
           AND f.id = COALESCE(?, f.id)
         ORDER BY f.position LIMIT 1`,
      )
      .bind(tokenHash, fileId ?? null)
      .first<FileRow>();
    return row ? mapFile(row) : null;
  }

  async addFile(
    input: Parameters<CustomerRepository["addFile"]>[0],
  ): Promise<CustomerFileRecord | null> {
    const result = await this.db
      .prepare(
        `INSERT INTO order_files
          (id, order_id, position, original_filename, r2_object_key,
           expected_size_bytes, source_page_count, paper_size, color_mode, sides,
           created_at_ms, updated_at_ms)
         SELECT ?, o.id, COALESCE(MAX(f.position), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?, ?
         FROM orders o LEFT JOIN order_files f ON f.order_id = o.id
         WHERE o.draft_token_hash = ? AND o.cleanup_state = 'ACTIVE'
           AND o.status IN ('UPLOADING','UPLOADED','PAYMENT_PENDING')
           AND o.draft_expires_at_ms > ?
           AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id
             AND p.status IN ('CREATED','PENDING','PAID'))
         GROUP BY o.id
         HAVING COUNT(f.id) < 10
           AND COALESCE(SUM(f.expected_size_bytes), 0) + ? <=
             (SELECT max_order_upload_bytes FROM installation WHERE id = 1)`,
      )
      .bind(
        input.fileId,
        input.originalFilename,
        input.objectKey,
        input.expectedSizeBytes,
        input.sourcePageCount,
        input.paperSize,
        input.colorMode,
        input.sides,
        input.nowMs,
        input.nowMs,
        input.tokenHash,
        input.nowMs,
        input.expectedSizeBytes,
      )
      .run();
    if (result.meta.changes !== 1) return null;
    await this.db
      .prepare(
        `UPDATE orders SET status = 'UPLOADING', draft_expires_at_ms = ?,
          updated_at_ms = ? WHERE draft_token_hash = ? AND cleanup_state = 'ACTIVE'`,
      )
      .bind(input.expiresAtMs, input.nowMs, input.tokenHash)
      .run();
    return this.findFile(input.tokenHash, input.fileId);
  }

  async claimFileRemoval(
    tokenHash: string,
    fileId: string,
    nowMs: number,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE order_files SET upload_status = 'DELETE_PENDING', updated_at_ms = ?
         WHERE id = ? AND upload_status IN ('PENDING','UPLOADED','VALIDATION_FAILED','DELETE_FAILED')
           AND order_id = (SELECT o.id FROM orders o
             WHERE o.draft_token_hash = ? AND o.cleanup_state = 'ACTIVE'
               AND o.status IN ('UPLOADING','UPLOADED','PAYMENT_PENDING','PAYMENT_FAILED','PAYMENT_CANCELLED')
               AND (SELECT COUNT(*) FROM order_files WHERE order_id = o.id) > 1
               AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id
                 AND p.status IN ('CREATED','PENDING','PAID')))`,
      )
      .bind(nowMs, fileId, tokenHash)
      .run();
    return result.meta.changes === 1;
  }

  async markFileRemovalFailed(fileId: string, nowMs: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE order_files SET upload_status = 'DELETE_FAILED', updated_at_ms = ?
         WHERE id = ? AND upload_status = 'DELETE_PENDING'`,
      )
      .bind(nowMs, fileId)
      .run();
  }

  async deleteFile(
    tokenHash: string,
    fileId: string,
    nowMs: number,
  ): Promise<boolean> {
    const files = await this.listFiles(tokenHash);
    const selected = files.find((file) => file.id === fileId);
    if (
      !selected ||
      files.length <= 1 ||
      selected.uploadStatus !== "DELETE_PENDING"
    )
      return false;
    const statements: D1PreparedStatement[] = [];
    if (selected.position === 1) {
      const next = files.find((file) => file.position === 2);
      if (!next) return false;
      statements.push(
        this.db
          .prepare(
            `UPDATE uploads SET id = ?, original_filename = ?, r2_object_key = ?,
             expected_size_bytes = ?, size_bytes = ?, mime_type = ?,
             storage_status = ?, uploaded_at_ms = ?, validation_error_code = NULL,
             updated_at_ms = ? WHERE order_id = ? AND id = ?`,
          )
          .bind(
            next.id,
            next.originalFilename,
            next.objectKey,
            next.expectedSizeBytes,
            next.actualSizeBytes,
            next.actualSizeBytes === null ? null : "application/pdf",
            next.uploadStatus === "UPLOADED" ? "UPLOADED" : "PENDING",
            next.actualSizeBytes === null ? null : nowMs,
            nowMs,
            selected.orderId,
            selected.id,
          ),
      );
    }
    statements.push(
      this.db
        .prepare(
          `DELETE FROM order_files WHERE id = ? AND order_id = ?
           AND EXISTS (SELECT 1 FROM orders WHERE id = ? AND draft_token_hash = ?
             AND cleanup_state = 'ACTIVE'
             AND status IN ('UPLOADING','UPLOADED','PAYMENT_PENDING','PAYMENT_FAILED','PAYMENT_CANCELLED')
             AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = orders.id
               AND p.status IN ('CREATED','PENDING','PAID')))`,
        )
        .bind(fileId, selected.orderId, selected.orderId, tokenHash),
    );
    const filesToShift = files.filter(
      (file) => file.position > selected.position,
    );
    if (filesToShift.length > 0) {
      statements.push(
        this.db
          .prepare(
            `UPDATE order_files SET position = position - 1, updated_at_ms = ?
             WHERE order_id = ? AND position > ?`,
          )
          .bind(nowMs, selected.orderId, selected.position),
      );
    }
    statements.push(
      this.db
        .prepare(
          `UPDATE orders SET status = CASE
             WHEN EXISTS (SELECT 1 FROM order_files WHERE order_id = ? AND upload_status <> 'UPLOADED')
             THEN 'UPLOADING' ELSE 'UPLOADED' END,
           original_filename = COALESCE((SELECT original_filename FROM order_files
             WHERE order_id = ? ORDER BY position LIMIT 1), original_filename),
           source_page_count = COALESCE((SELECT source_page_count FROM order_files
             WHERE order_id = ? ORDER BY position LIMIT 1), source_page_count),
           printing_amount_paise = 0, service_charge_paise = 0,
           total_amount_paise = 0, updated_at_ms = ?
           WHERE id = ? AND draft_token_hash = ?`,
        )
        .bind(
          selected.orderId,
          selected.orderId,
          selected.orderId,
          nowMs,
          selected.orderId,
          tokenHash,
        ),
    );
    const results = await this.db.batch(statements);
    const deletionIndex = selected.position === 1 ? 1 : 0;
    return results[deletionIndex]?.meta.changes === 1;
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
          `UPDATE order_files SET size_bytes = ?, mime_type = 'application/pdf',
           upload_status = 'UPLOADED', uploaded_at_ms = ?, updated_at_ms = ?,
           validation_error_code = NULL
           WHERE id = ? AND order_id = ? AND upload_status = 'PENDING'`,
        )
        .bind(
          input.actualSizeBytes,
          input.nowMs,
          input.nowMs,
          input.uploadId,
          input.orderId,
        ),
      this.db
        .prepare(
          `UPDATE orders SET status = CASE
             WHEN NOT EXISTS (SELECT 1 FROM order_files WHERE order_id = ? AND upload_status <> 'UPLOADED')
             THEN 'UPLOADED' ELSE 'UPLOADING' END,
           updated_at_ms = ?, draft_expires_at_ms = ?
           WHERE id = ? AND status IN ('UPLOADING','UPLOADED','PAYMENT_PENDING')`,
        )
        .bind(input.orderId, input.nowMs, input.expiresAtMs, input.orderId),
    ]);
  }

  async markValidationFailure(
    uploadId: string,
    code: string,
    nowMs: number,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE order_files SET validation_error_code = ?, upload_status = 'VALIDATION_FAILED',
         updated_at_ms = ? WHERE id = ? AND upload_status = 'PENDING'`,
      )
      .bind(code, nowMs, uploadId)
      .run();
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
      WHERE id = ? AND status IN ('UPLOADED', 'PAYMENT_PENDING')
        AND (status <> 'PAYMENT_PENDING' OR selected_pages IS NOT ? OR copies IS NOT ? OR paper_size IS NOT ?
          OR color_mode IS NOT ? OR sides IS NOT ? OR printing_amount_paise IS NOT ?
          OR service_charge_paise IS NOT ? OR total_amount_paise IS NOT ?)`,
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
        input.selectedPages,
        input.copies,
        input.paperSize,
        input.colorMode,
        input.sides,
        input.printingAmountPaise,
        input.serviceChargePaise,
        input.totalAmountPaise,
      )
      .run();
  }

  async saveOrderQuote(
    input: Parameters<CustomerRepository["saveOrderQuote"]>[0],
  ): Promise<boolean> {
    const first = input.files[0];
    if (!first) return false;
    const statements: D1PreparedStatement[] = [];
    for (const file of input.files) {
      statements.push(
        this.db
          .prepare(
            `UPDATE order_files SET selected_pages = ?, selected_page_count = ?,
             copies = ?, paper_size = ?, color_mode = ?, sides = ?,
             printing_amount_paise = ?, service_charge_paise = ?, updated_at_ms = ?
             WHERE id = ? AND order_id = (
               SELECT id FROM orders WHERE draft_token_hash = ?
                 AND cleanup_state = 'ACTIVE'
                 AND status IN ('UPLOADED','PAYMENT_PENDING','PAYMENT_FAILED','PAYMENT_CANCELLED')
                 AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = orders.id
                   AND p.status IN ('CREATED','PENDING','PAID'))
             ) AND upload_status = 'UPLOADED'`,
          )
          .bind(
            file.selectedPages,
            file.selectedPageCount,
            file.copies,
            file.paperSize,
            file.colorMode,
            file.sides,
            file.printingAmountPaise,
            file.serviceChargePaise,
            input.nowMs,
            file.fileId,
            input.tokenHash,
          ),
      );
    }
    statements.push(
      this.db
        .prepare(
          `UPDATE orders SET selected_pages = ?, copies = ?, paper_size = ?,
           color_mode = ?, sides = ?, printing_amount_paise = ?,
           service_charge_paise = ?, total_amount_paise = ?,
           status = 'PAYMENT_PENDING', draft_expires_at_ms = ?, updated_at_ms = ?
           WHERE draft_token_hash = ? AND cleanup_state = 'ACTIVE'
             AND status IN ('UPLOADED','PAYMENT_PENDING','PAYMENT_FAILED','PAYMENT_CANCELLED')
             AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = orders.id
               AND p.status IN ('CREATED','PENDING','PAID'))
             AND (SELECT COUNT(*) FROM order_files WHERE order_id = orders.id
                    AND upload_status = 'UPLOADED') = ?
             AND (SELECT COUNT(*) FROM order_files WHERE order_id = orders.id) = ?`,
        )
        .bind(
          first.selectedPages,
          first.copies,
          first.paperSize,
          first.colorMode,
          first.sides,
          input.printingAmountPaise,
          input.serviceChargePaise,
          input.totalAmountPaise,
          input.expiresAtMs,
          input.nowMs,
          input.tokenHash,
          input.files.length,
          input.files.length,
        ),
    );
    const results = await this.db.batch(statements);
    return results.at(-1)?.meta.changes === 1;
  }

  async snapshotAddonServices(
    orderId: string,
    serviceIds: readonly string[],
  ): Promise<void> {
    if (serviceIds.length === 0) return;
    const placeholders = serviceIds.map(() => "?").join(", ");
    const services = await this.db
      .prepare(
        `SELECT id, name, pricing_type, fixed_price_paise, handling_mode, enabled
         FROM addon_services WHERE id IN (${placeholders})`,
      )
      .bind(...serviceIds)
      .all<{
        id: string;
        name: string;
        pricing_type: string;
        fixed_price_paise: number | null;
        handling_mode: string;
        enabled: number;
      }>();
    if (services.results.length !== serviceIds.length) {
      throw new Error("ADDON_SERVICE_NOT_FOUND");
    }
    const disabled = services.results.find((s) => s.enabled === 0);
    if (disabled) {
      throw new Error("ADDON_SERVICE_DISABLED");
    }
    const statements = services.results.map((svc) =>
      this.db
        .prepare(
          `INSERT OR IGNORE INTO order_addon_services
             (order_id, service_id, snapshot_name, snapshot_pricing_type,
              snapshot_price_charged_online_paise, snapshot_handling_mode)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          orderId,
          svc.id,
          svc.name,
          svc.pricing_type,
          svc.pricing_type === "FIXED_PRICE" ? (svc.fixed_price_paise ?? 0) : 0,
          svc.handling_mode,
        ),
    );
    await this.db.batch(statements);
  }

  async getOrderAddonAmountPaise(orderId: string): Promise<number> {
    const result = await this.db
      .prepare(
        `SELECT COALESCE(SUM(snapshot_price_charged_online_paise), 0) as total
         FROM order_addon_services WHERE order_id = ?`,
      )
      .bind(orderId)
      .first<{ total: number }>();
    return result?.total ?? 0;
  }

  async getOrderAddonSnapshots(
    orderId: string,
  ): Promise<OrderAddonServiceSnapshot[]> {
    const result = await this.db
      .prepare(
        `SELECT service_id, snapshot_name, snapshot_pricing_type,
                snapshot_price_charged_online_paise, snapshot_handling_mode
         FROM order_addon_services WHERE order_id = ?
         ORDER BY rowid`,
      )
      .bind(orderId)
      .all<{
        service_id: string;
        snapshot_name: string;
        snapshot_pricing_type: string;
        snapshot_price_charged_online_paise: number;
        snapshot_handling_mode: string;
      }>();
    return result.results.map((r) => ({
      serviceId: r.service_id,
      serviceName: r.snapshot_name,
      pricingType: r.snapshot_pricing_type as PricingType,
      onlinePricePaise: r.snapshot_price_charged_online_paise,
      handlingMode: r.snapshot_handling_mode as HandlingMode,
    }));
  }
}
