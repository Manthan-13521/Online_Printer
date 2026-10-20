import {
  validateSavedPrintName,
  validatePrintSavedPrintInput,
} from "@printgo/validation";
import { MAX_SAVED_PRINT_BYTES } from "@printgo/domain";
import {
  guardAdminOrigin,
  readAdminJson,
  resolveAdminCorsOrigin,
  withAdminCors,
} from "../admin/http";
import { clearAdminCookie, readAdminCookie } from "../auth/cookies";
import { D1AdminAuthRepository } from "../auth/repository";
import { AdminAuthService, AuthError } from "../auth/service";
import type { WorkerEnv } from "../env";
import { error, ok } from "../http";
import { wakeAgent } from "../agent/wake";
import { D1SavedPrintsRepository } from "./repository";

const MAX_JSON_BYTES = 16 * 1024;

export function estimatePdfPageCount(
  pdfBytes: ArrayBuffer | ArrayBufferLike,
): number {
  try {
    const text = new TextDecoder("latin1").decode(new Uint8Array(pdfBytes));
    // 1. Look for /Type /Pages ... /Count N or /Count N ... /Type /Pages
    const pagesCountMatch =
      text.match(/\/Type\s*\/Pages[\s\S]*?\/Count\s+(\d+)/) ||
      text.match(/\/Count\s+(\d+)[\s\S]*?\/Type\s*\/Pages/);
    if (pagesCountMatch && pagesCountMatch[1]) {
      const parsed = parseInt(pagesCountMatch[1], 10);
      if (parsed > 0 && parsed < 10000) return parsed;
    }
    // 2. Count /Type /Page\b (excluding /Type /Pages)
    const pageMatches = text.match(/\/Type\s*\/Page\b/g);
    if (pageMatches && pageMatches.length > 0) {
      return pageMatches.length;
    }
  } catch {
    // fallback to 1 page
  }
  return 1;
}

export async function handleAdminSavedPrintsRequest(
  request: Request,
  env: WorkerEnv,
  repository: D1SavedPrintsRepository = new D1SavedPrintsRepository(env.DB),
  authService: AdminAuthService = new AdminAuthService(
    new D1AdminAuthRepository(env.DB),
  ),
): Promise<Response> {
  const corsOrigin = resolveAdminCorsOrigin(request, env.ADMIN_ALLOWED_ORIGIN);
  const originGuard = guardAdminOrigin(request, env.ADMIN_ALLOWED_ORIGIN);
  if (originGuard) return originGuard;

  let session;
  try {
    session = await authService.requireSession(
      readAdminCookie(request, env.APP_ENV === "production"),
    );
  } catch (caught) {
    const response =
      caught instanceof AuthError
        ? error(
            401,
            caught.code,
            "Your session has expired. Please sign in again.",
            {
              "set-cookie": clearAdminCookie(env.APP_ENV === "production"),
            },
          )
        : error(500, "AUTH_ERROR", "Authentication check failed.");
    return withAdminCors(response, corsOrigin);
  }

  const url = new URL(request.url);
  const pathname = url.pathname;

  try {
    // 1. List all saved print documents
    if (request.method === "GET" && pathname === "/api/admin/saved-prints") {
      const documents = await repository.listDocuments();
      return withAdminCors(ok({ documents }), corsOrigin);
    }

    // 2. Upload a new saved print PDF
    if (
      request.method === "POST" &&
      pathname === "/api/admin/saved-prints/upload"
    ) {
      const contentType = request.headers.get("content-type") ?? "";
      let name: string = "";
      let originalFilename: string = "document.pdf";
      let pageCount: number = 1;
      let pdfBytes: ArrayBuffer | null = null;

      if (contentType.includes("multipart/form-data")) {
        const formData = await request.formData();
        const rawName = formData.get("name");
        const rawFile = (formData.get("file") ??
          formData.get("pdf")) as unknown;
        const rawPageCount = formData.get("pageCount");

        if (typeof rawName === "string" && rawName.trim().length > 0) {
          name = rawName.trim();
        }
        if (
          typeof rawPageCount === "string" ||
          typeof rawPageCount === "number"
        ) {
          pageCount = Math.max(1, parseInt(String(rawPageCount), 10) || 1);
        }

        if (rawFile instanceof File) {
          originalFilename = rawFile.name || "document.pdf";
          if (!name) {
            name =
              originalFilename.replace(/\.pdf$/i, "").trim() ||
              "Untitled Document";
          }
          if (rawFile.size > MAX_SAVED_PRINT_BYTES) {
            return withAdminCors(
              error(
                413,
                "FILE_TOO_LARGE",
                "Document exceeds maximum allowed size of 10 MB.",
              ),
              corsOrigin,
            );
          }
          pdfBytes = await rawFile.arrayBuffer();
          if (!rawPageCount && pdfBytes) {
            pageCount = estimatePdfPageCount(pdfBytes);
          }
        }
      } else {
        // Direct body upload
        const bodyBytes = await request.arrayBuffer();
        if (bodyBytes.byteLength > MAX_SAVED_PRINT_BYTES) {
          return withAdminCors(
            error(
              413,
              "FILE_TOO_LARGE",
              "Document exceeds maximum allowed size of 10 MB.",
            ),
            corsOrigin,
          );
        }
        name = url.searchParams.get("name") || "Untitled Document";
        originalFilename = url.searchParams.get("filename") || "document.pdf";
        const urlPages = url.searchParams.get("pages");
        pdfBytes = bodyBytes;
        if (urlPages) {
          pageCount = Math.max(1, parseInt(urlPages, 10) || 1);
        } else if (pdfBytes) {
          pageCount = estimatePdfPageCount(pdfBytes);
        }
      }

      if (!pdfBytes || pdfBytes.byteLength === 0) {
        return withAdminCors(
          error(400, "INVALID_FILE", "Please choose a valid PDF document."),
          corsOrigin,
        );
      }

      // Check PDF header
      const header = new TextDecoder().decode(pdfBytes.slice(0, 5));
      if (!header.startsWith("%PDF-")) {
        return withAdminCors(
          error(
            400,
            "INVALID_PDF",
            "The selected file is not a valid PDF document.",
          ),
          corsOrigin,
        );
      }

      const validatedName = validateSavedPrintName(name);
      if (!validatedName.ok) {
        return withAdminCors(
          error(
            400,
            "INVALID_NAME",
            validatedName.issues[0]?.message ?? "Invalid document name.",
          ),
          corsOrigin,
        );
      }

      const id = crypto.randomUUID();
      const r2ObjectKey = `saved-prints/${id}.pdf`;

      await env.PDF_BUCKET.put(r2ObjectKey, pdfBytes, {
        httpMetadata: { contentType: "application/pdf" },
      });

      const doc = await repository.createDocument({
        id,
        name: validatedName.value,
        originalFilename,
        r2ObjectKey,
        fileSizeBytes: pdfBytes.byteLength,
        pageCount,
        nowMs: Date.now(),
      });

      return withAdminCors(ok(doc, 201), corsOrigin);
    }

    // 3. Rename a saved print document
    const renameMatch = /^\/api\/admin\/saved-prints\/([0-9a-f-]{36})$/u.exec(
      pathname,
    );
    if (request.method === "PATCH" && renameMatch) {
      const id = renameMatch[1]!;
      const body = (await readAdminJson(request, MAX_JSON_BYTES)) as {
        name?: string;
      } | null;
      const validatedName = validateSavedPrintName(body?.name ?? "");
      if (!validatedName.ok) {
        return withAdminCors(
          error(
            400,
            "INVALID_NAME",
            validatedName.issues[0]?.message ?? "Invalid document name.",
          ),
          corsOrigin,
        );
      }

      const updated = await repository.updateDocumentName(
        id,
        validatedName.value,
        Date.now(),
      );
      if (!updated) {
        return withAdminCors(
          error(404, "NOT_FOUND", "Saved print document not found."),
          corsOrigin,
        );
      }

      return withAdminCors(ok(updated), corsOrigin);
    }

    // 4. Delete a saved print document
    if (request.method === "DELETE" && renameMatch) {
      const id = renameMatch[1]!;
      const objectKey = await repository.deleteDocument(id);
      if (!objectKey) {
        return withAdminCors(
          error(404, "NOT_FOUND", "Saved print document not found."),
          corsOrigin,
        );
      }

      await env.PDF_BUCKET.delete(objectKey);
      return withAdminCors(
        ok({ message: "Saved print document deleted." }),
        corsOrigin,
      );
    }

    // 5. Preview / stream a saved print document
    const previewMatch =
      /^\/api\/admin\/saved-prints\/([0-9a-f-]{36})\/preview$/u.exec(pathname);
    if (request.method === "GET" && previewMatch) {
      const id = previewMatch[1]!;
      const doc = await repository.findDocumentById(id);
      if (!doc) {
        return withAdminCors(
          error(404, "NOT_FOUND", "Saved print document not found."),
          corsOrigin,
        );
      }

      const obj = await env.PDF_BUCKET.get(doc.r2_object_key);
      if (!obj) {
        return withAdminCors(
          error(404, "FILE_NOT_FOUND", "Document file not found in storage."),
          corsOrigin,
        );
      }

      return new Response(obj.body, {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename="${encodeURIComponent(doc.originalFilename)}"`,
          "Access-Control-Allow-Origin": corsOrigin,
          "Access-Control-Allow-Credentials": "true",
          Vary: "Origin",
          "Cache-Control": "private, max-age=3600",
        },
      });
    }

    // 6. Print a saved print document
    const printMatch =
      /^\/api\/admin\/saved-prints\/([0-9a-f-]{36})\/print$/u.exec(pathname);
    if (request.method === "POST" && printMatch) {
      const documentId = printMatch[1]!;
      const body = await readAdminJson(request, MAX_JSON_BYTES);
      const validatedInput = validatePrintSavedPrintInput(body);
      if (!validatedInput.ok) {
        return withAdminCors(
          error(
            400,
            "INVALID_INPUT",
            validatedInput.issues[0]?.message ?? "Invalid print configuration.",
          ),
          corsOrigin,
        );
      }

      const result = await repository.createSavedPrintOrder({
        documentId,
        adminId: session.admin.id,
        copies: validatedInput.value.copies,
        pageRange: validatedInput.value.pageRange,
        paperSize: validatedInput.value.paperSize,
        colorMode: validatedInput.value.colorMode,
        sides: validatedInput.value.sides,
        printerId: validatedInput.value.printerId,
        nowMs: Date.now(),
      });

      await wakeAgent(env);

      return withAdminCors(ok(result, 201), corsOrigin);
    }

    return withAdminCors(
      error(404, "NOT_FOUND", "Saved print route not found."),
      corsOrigin,
    );
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "SAVED_PRINT_NOT_FOUND") {
      return withAdminCors(
        error(404, "NOT_FOUND", "Saved print document not found."),
        corsOrigin,
      );
    }
    return withAdminCors(
      error(500, "SAVED_PRINT_ERROR", "Failed to process saved print request."),
      corsOrigin,
    );
  }
}
