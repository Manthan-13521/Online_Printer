import type { SavedPrintDocument } from "@printgo/api-contract";
import {
  parsePageRange,
  type ColorMode,
  type PaperSize,
  type SidesMode,
} from "@printgo/domain";
import { generateJobCode } from "../payments/job-code";

export interface SavedPrintRow {
  id: string;
  name: string;
  original_filename: string;
  r2_object_key: string;
  file_size_bytes: number;
  page_count: number;
  created_at_ms: number;
  updated_at_ms: number;
}

export class D1SavedPrintsRepository {
  constructor(private readonly db: D1Database) {}

  async listDocuments(): Promise<SavedPrintDocument[]> {
    const rows = await this.db
      .prepare(
        `SELECT id, name, original_filename, r2_object_key, file_size_bytes,
                page_count, created_at_ms, updated_at_ms
         FROM saved_prints
         ORDER BY created_at_ms DESC`,
      )
      .all<SavedPrintRow>();

    return (rows.results ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      originalFilename: row.original_filename,
      fileSizeBytes: row.file_size_bytes,
      pageCount: row.page_count,
      createdAt: new Date(row.created_at_ms).toISOString(),
      updatedAt: new Date(row.updated_at_ms).toISOString(),
    }));
  }

  async findDocumentById(
    id: string,
  ): Promise<(SavedPrintDocument & { r2_object_key: string }) | null> {
    const row = await this.db
      .prepare(
        `SELECT id, name, original_filename, r2_object_key, file_size_bytes,
                page_count, created_at_ms, updated_at_ms
         FROM saved_prints WHERE id = ?`,
      )
      .bind(id)
      .first<SavedPrintRow>();

    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      originalFilename: row.original_filename,
      r2_object_key: row.r2_object_key,
      fileSizeBytes: row.file_size_bytes,
      pageCount: row.page_count,
      createdAt: new Date(row.created_at_ms).toISOString(),
      updatedAt: new Date(row.updated_at_ms).toISOString(),
    };
  }

  async createDocument(input: {
    id: string;
    name: string;
    originalFilename: string;
    r2ObjectKey: string;
    fileSizeBytes: number;
    pageCount: number;
    nowMs: number;
  }): Promise<SavedPrintDocument> {
    await this.db
      .prepare(
        `INSERT INTO saved_prints
         (id, name, original_filename, r2_object_key, file_size_bytes, page_count, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.id,
        input.name,
        input.originalFilename,
        input.r2ObjectKey,
        input.fileSizeBytes,
        input.pageCount,
        input.nowMs,
        input.nowMs,
      )
      .run();

    return {
      id: input.id,
      name: input.name,
      originalFilename: input.originalFilename,
      fileSizeBytes: input.fileSizeBytes,
      pageCount: input.pageCount,
      createdAt: new Date(input.nowMs).toISOString(),
      updatedAt: new Date(input.nowMs).toISOString(),
    };
  }

  async updateDocumentName(
    id: string,
    name: string,
    nowMs: number,
  ): Promise<SavedPrintDocument | null> {
    const result = await this.db
      .prepare(
        `UPDATE saved_prints SET name = ?, updated_at_ms = ? WHERE id = ?`,
      )
      .bind(name, nowMs, id)
      .run();

    if (result.meta.changes !== 1) return null;
    return this.findDocumentById(id);
  }

  async deleteDocument(id: string): Promise<string | null> {
    const doc = await this.findDocumentById(id);
    if (!doc) return null;

    await this.db
      .prepare(`DELETE FROM saved_prints WHERE id = ?`)
      .bind(id)
      .run();

    return doc.r2_object_key;
  }

  async createSavedPrintOrder(input: {
    documentId: string;
    adminId: string;
    copies: number;
    pageRange: string;
    paperSize: PaperSize;
    colorMode: ColorMode;
    sides: SidesMode;
    printerId?: string | undefined;
    nowMs: number;
  }): Promise<{ orderId: string; jobCode: string }> {
    const doc = await this.findDocumentById(input.documentId);
    if (!doc) {
      throw new Error("SAVED_PRINT_NOT_FOUND");
    }

    const orderId = crypto.randomUUID();
    const fileId = crypto.randomUUID();
    const uploadId = crypto.randomUUID();
    const jobCode = generateJobCode();

    let selectedPages = input.pageRange?.trim() || "ALL";
    let selectedPageCount: number;
    try {
      const parsed = parsePageRange(selectedPages, doc.pageCount);
      selectedPages = parsed.normalized;
      selectedPageCount = parsed.selectedPageCount;
    } catch {
      selectedPages = "ALL";
      selectedPageCount = doc.pageCount;
    }

    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO orders
           (id, order_type, admin_authorized_by, customer_name, customer_phone,
            original_filename, source_page_count, selected_pages, copies,
            paper_size, color_mode, sides, total_amount_paise, currency,
            status, queued_at_ms, created_at_ms, updated_at_ms,
            printer_id, public_job_code, cleanup_state, is_pickup)
           VALUES (?, 'SAVED_PRINT', ?, ?, '', ?, ?, ?, ?, ?, ?, ?, 0, 'INR', 'QUEUED', ?, ?, ?, ?, ?, 'ACTIVE', 0)`,
        )
        .bind(
          orderId,
          input.adminId,
          `Saved Print: ${doc.name}`,
          doc.originalFilename,
          doc.pageCount,
          selectedPages,
          input.copies,
          input.paperSize,
          input.colorMode,
          input.sides,
          input.nowMs,
          input.nowMs,
          input.nowMs,
          input.printerId ?? null,
          jobCode,
        ),
      this.db
        .prepare(
          `INSERT INTO order_files
           (id, order_id, position, original_filename, r2_object_key,
            expected_size_bytes, size_bytes, source_page_count, selected_pages,
            selected_page_count, copies, paper_size, color_mode, sides,
            upload_status, print_status, created_at_ms, updated_at_ms)
           VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'UPLOADED', 'QUEUED', ?, ?)`,
        )
        .bind(
          fileId,
          orderId,
          doc.originalFilename,
          doc.r2_object_key,
          doc.fileSizeBytes,
          doc.fileSizeBytes,
          doc.pageCount,
          selectedPages,
          selectedPageCount,
          input.copies,
          input.paperSize,
          input.colorMode,
          input.sides,
          input.nowMs,
          input.nowMs,
        ),
      this.db
        .prepare(
          `INSERT INTO uploads
           (id, order_id, r2_object_key, original_filename, storage_status,
            retention_reason, expected_size_bytes, size_bytes, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, 'UPLOADED', 'COMPLETED', ?, ?, ?, ?)`,
        )
        .bind(
          uploadId,
          orderId,
          doc.r2_object_key,
          doc.originalFilename,
          doc.fileSizeBytes,
          doc.fileSizeBytes,
          input.nowMs,
          input.nowMs,
        ),
      this.db
        .prepare(
          `INSERT INTO order_events
           (id, order_id, event_type, from_status, to_status, actor_type, actor_id, details_json, created_at_ms)
           VALUES (?, ?, 'ORDER_QUEUED', 'CREATED', 'QUEUED', 'ADMIN', ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          orderId,
          input.adminId,
          JSON.stringify({ documentId: doc.id, documentName: doc.name }),
          input.nowMs,
        ),
    ]);

    return { orderId, jobCode };
  }
}
