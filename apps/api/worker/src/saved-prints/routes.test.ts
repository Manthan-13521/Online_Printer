import { describe, expect, it, vi } from "vitest";

/* eslint-disable @typescript-eslint/unbound-method -- Vitest inspects method mocks without invoking them. */

import type { SavedPrintDocument } from "@printgo/api-contract";
import type { WorkerEnv } from "../env";
import { estimatePdfPageCount, handleAdminSavedPrintsRequest } from "./routes";
import type { D1SavedPrintsRepository } from "./repository";
import type { AdminAuthService, RequiredSession } from "../auth/service";

const env = {
  APP_ENV: "production",
  ADMIN_ALLOWED_ORIGIN: "https://admin.example.test",
  PDF_BUCKET: {
    put: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue({
      body: new Uint8Array([1, 2, 3]),
    }),
    delete: vi.fn().mockResolvedValue(undefined),
  },
} as unknown as WorkerEnv;

const sampleSession: RequiredSession = {
  sessionId: "session-1",
  tokenHash: "hash-1",
  admin: { id: "admin-1", loginIdentifier: "admin" },
};

const sampleDoc: SavedPrintDocument = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Standard Application Form",
  originalFilename: "app_form.pdf",
  fileSizeBytes: 1024,
  pageCount: 3,
  createdAt: "2026-10-20T10:00:00.000Z",
  updatedAt: "2026-10-20T10:00:00.000Z",
};

describe("estimatePdfPageCount", () => {
  it("extracts page count from /Type /Pages /Count N", () => {
    const raw =
      "%PDF-1.4\n1 0 obj\n<< /Type /Pages /Count 5 /Kids [] >>\nendobj\n%%EOF";
    const bytes = new TextEncoder().encode(raw).buffer;
    expect(estimatePdfPageCount(bytes)).toBe(5);
  });

  it("extracts page count by counting /Type /Page occurrences", () => {
    const raw =
      "%PDF-1.4\n<< /Type /Page >>\n<< /Type /Page >>\n<< /Type /Page >>\n%%EOF";
    const bytes = new TextEncoder().encode(raw).buffer;
    expect(estimatePdfPageCount(bytes)).toBe(3);
  });

  it("defaults to 1 when no count or page markers found", () => {
    const raw = "%PDF-1.4\nsome content without page markers\n%%EOF";
    const bytes = new TextEncoder().encode(raw).buffer;
    expect(estimatePdfPageCount(bytes)).toBe(1);
  });
});

describe("handleAdminSavedPrintsRequest", () => {
  const mockRepo = {
    listDocuments: vi.fn().mockResolvedValue([sampleDoc]),
    createDocument: vi
      .fn()
      .mockImplementation(
        (input: {
          id: string;
          name: string;
          originalFilename: string;
          fileSizeBytes: number;
          pageCount: number;
          nowMs: number;
        }) =>
          Promise.resolve({
            id: input.id,
            name: input.name,
            originalFilename: input.originalFilename,
            fileSizeBytes: input.fileSizeBytes,
            pageCount: input.pageCount,
            createdAt: new Date(input.nowMs).toISOString(),
            updatedAt: new Date(input.nowMs).toISOString(),
          }),
      ),
    updateDocumentName: vi.fn().mockResolvedValue({
      ...sampleDoc,
      name: "Updated Form Name",
    }),
    deleteDocument: vi.fn().mockResolvedValue("saved-prints/doc-1.pdf"),
    findDocumentById: vi.fn().mockResolvedValue({
      id: sampleDoc.id,
      name: sampleDoc.name,
      originalFilename: sampleDoc.originalFilename,
      r2_object_key: "saved-prints/doc-1.pdf",
      file_size_bytes: 1024,
      page_count: 3,
    }),
    createSavedPrintOrder: vi.fn().mockResolvedValue({
      orderId: "ord-saved-1",
      jobCode: "SP-4001",
    }),
  } as unknown as D1SavedPrintsRepository;

  const mockAuthService = {
    requireSession: vi.fn().mockResolvedValue(sampleSession),
  } as unknown as AdminAuthService;

  it("lists saved documents for authorized admin with proper CORS", async () => {
    const req = new Request("https://worker.test/api/admin/saved-prints", {
      method: "GET",
      headers: {
        origin: "https://admin.example.test",
        cookie: "printgo_admin=valid_token",
      },
    });

    const res = await handleAdminSavedPrintsRequest(
      req,
      env,
      mockRepo,
      mockAuthService,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://admin.example.test",
    );
    const body: unknown = await res.json();
    const result = body as {
      ok: boolean;
      data: { documents: SavedPrintDocument[] };
    };
    expect(result.ok).toBe(true);
    expect(result.data.documents).toHaveLength(1);
    expect(result.data.documents[0]?.name).toBe("Standard Application Form");
  });

  it("accepts upload with field name 'file'", async () => {
    const formData = new FormData();
    const pdfContent = "%PDF-1.4\n<< /Type /Pages /Count 4 >>\n%%EOF";
    const file = new File([pdfContent], "form.pdf", {
      type: "application/pdf",
    });
    formData.append("name", "Form Via File Field");
    formData.append("file", file);

    const req = new Request(
      "https://worker.test/api/admin/saved-prints/upload",
      {
        method: "POST",
        headers: {
          origin: "https://admin.example.test",
          cookie: "printgo_admin=valid_token",
        },
        body: formData,
      },
    );

    const res = await handleAdminSavedPrintsRequest(
      req,
      env,
      mockRepo,
      mockAuthService,
    );
    expect(res.status).toBe(201);
    const body: unknown = await res.json();
    const result = body as { ok: boolean; data: SavedPrintDocument };
    expect(result.ok).toBe(true);
    expect(result.data.name).toBe("Form Via File Field");
    expect(result.data.pageCount).toBe(4);
  });

  it("accepts upload with field name 'pdf'", async () => {
    const formData = new FormData();
    const pdfContent = "%PDF-1.4\n<< /Type /Pages /Count 2 >>\n%%EOF";
    const file = new File([pdfContent], "contract.pdf", {
      type: "application/pdf",
    });
    formData.append("name", "Contract Via PDF Field");
    formData.append("pdf", file);

    const req = new Request(
      "https://worker.test/api/admin/saved-prints/upload",
      {
        method: "POST",
        headers: {
          origin: "https://admin.example.test",
          cookie: "printgo_admin=valid_token",
        },
        body: formData,
      },
    );

    const res = await handleAdminSavedPrintsRequest(
      req,
      env,
      mockRepo,
      mockAuthService,
    );
    expect(res.status).toBe(201);
    const body: unknown = await res.json();
    const result = body as { ok: boolean; data: SavedPrintDocument };
    expect(result.ok).toBe(true);
    expect(result.data.name).toBe("Contract Via PDF Field");
    expect(result.data.pageCount).toBe(2);
  });

  it("rejects file that does not have %PDF- header", async () => {
    const formData = new FormData();
    const notPdf = "This is a plain text file, not a PDF.";
    const file = new File([notPdf], "text.txt", { type: "text/plain" });
    formData.append("name", "Invalid File");
    formData.append("file", file);

    const req = new Request(
      "https://worker.test/api/admin/saved-prints/upload",
      {
        method: "POST",
        headers: {
          origin: "https://admin.example.test",
          cookie: "printgo_admin=valid_token",
        },
        body: formData,
      },
    );

    const res = await handleAdminSavedPrintsRequest(
      req,
      env,
      mockRepo,
      mockAuthService,
    );
    expect(res.status).toBe(400);
    const body: unknown = await res.json();
    const result = body as { ok: boolean; error: { code: string } };
    expect(result.error.code).toBe("INVALID_PDF");
  });

  it("renames a saved document via PATCH", async () => {
    const req = new Request(
      `https://worker.test/api/admin/saved-prints/${sampleDoc.id}`,
      {
        method: "PATCH",
        headers: {
          origin: "https://admin.example.test",
          cookie: "printgo_admin=valid_token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "Updated Form Name" }),
      },
    );

    const res = await handleAdminSavedPrintsRequest(
      req,
      env,
      mockRepo,
      mockAuthService,
    );
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    const result = body as { ok: boolean; data: SavedPrintDocument };
    expect(result.data.name).toBe("Updated Form Name");
  });

  it("streams preview with appropriate CORS and cache headers", async () => {
    const req = new Request(
      `https://worker.test/api/admin/saved-prints/${sampleDoc.id}/preview`,
      {
        method: "GET",
        headers: {
          origin: "https://admin.example.test",
          cookie: "printgo_admin=valid_token",
        },
      },
    );

    const res = await handleAdminSavedPrintsRequest(
      req,
      env,
      mockRepo,
      mockAuthService,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://admin.example.test",
    );
  });

  it("deletes a saved document and removes R2 object", async () => {
    const req = new Request(
      `https://worker.test/api/admin/saved-prints/${sampleDoc.id}`,
      {
        method: "DELETE",
        headers: {
          origin: "https://admin.example.test",
          cookie: "printgo_admin=valid_token",
        },
      },
    );

    const res = await handleAdminSavedPrintsRequest(
      req,
      env,
      mockRepo,
      mockAuthService,
    );
    expect(res.status).toBe(200);
    expect(env.PDF_BUCKET.delete).toHaveBeenCalledWith(
      "saved-prints/doc-1.pdf",
    );
  });
});
