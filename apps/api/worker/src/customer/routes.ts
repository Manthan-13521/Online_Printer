import type {
  CreateCustomerDraftRequest,
  CustomerPrintSettingsRequest,
} from "@printgo/api-contract";
import {
  isColorMode,
  isPaperSize,
  isSidesMode,
  isValidCopies,
  isValidPdfSizeBytes,
} from "@printgo/validation";

import type { WorkerEnv } from "../env";
import { error, ok } from "../http";
import { R2UploadSigner } from "../storage/r2-upload-signer";
import { R2PrivateObjectStore } from "../storage/r2-verification";
import { D1CustomerRepository } from "./repository";
import { CustomerError, CustomerService } from "./service";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const MAX_JSON_BODY_BYTES = 8 * 1024;

export interface CustomerActions {
  getConfig(): ReturnType<D1CustomerRepository["getPublicConfig"]>;
  createDraft(
    input: CreateCustomerDraftRequest,
  ): ReturnType<CustomerService["createDraft"]>;
  authorizeUpload(
    token: string,
  ): ReturnType<CustomerService["authorizeUpload"]>;
  completeUpload(token: string): ReturnType<CustomerService["completeUpload"]>;
  quote(
    token: string,
    input: CustomerPrintSettingsRequest,
  ): ReturnType<CustomerService["quote"]>;
}

function actionsFromEnv(env: WorkerEnv): CustomerActions {
  const repository = new D1CustomerRepository(env.DB);
  const service = new CustomerService(
    repository,
    new R2UploadSigner({
      accountId: env.R2_ACCOUNT_ID,
      bucketName: env.R2_BUCKET_NAME,
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    }),
    new R2PrivateObjectStore(env.PDF_BUCKET),
  );
  return {
    getConfig: () => repository.getPublicConfig(),
    createDraft: (input) => service.createDraft(input),
    authorizeUpload: (token) => service.authorizeUpload(token),
    completeUpload: (token) => service.completeUpload(token),
    quote: (token, input) => service.quote(token, input),
  };
}

function corsHeaders(env: WorkerEnv): HeadersInit {
  return {
    ...NO_STORE,
    "Access-Control-Allow-Origin": env.CUSTOMER_ALLOWED_ORIGIN,
    Vary: "Origin",
  };
}

function rejectUntrustedOrigin(
  request: Request,
  env: WorkerEnv,
): Response | null {
  return request.headers.get("Origin") === env.CUSTOMER_ALLOWED_ORIGIN
    ? null
    : error(
        403,
        "ORIGIN_NOT_ALLOWED",
        "This request origin is not allowed.",
        NO_STORE,
      );
}

function bearerToken(request: Request): string | null {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(
    request.headers.get("Authorization") ?? "",
  );
  return match?.[1] ?? null;
}

async function readJson(request: Request): Promise<unknown> {
  const length = Number(request.headers.get("Content-Length") ?? 0);
  if (length > MAX_JSON_BODY_BYTES) throw new SyntaxError("Body too large");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_JSON_BODY_BYTES) {
    throw new SyntaxError("Body too large");
  }
  return text.length === 0 ? {} : JSON.parse(text);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validString(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= maximum
  );
}

function validateDraft(value: unknown): CreateCustomerDraftRequest | null {
  if (!isPlainRecord(value)) return null;
  const allowed = new Set([
    "customerName",
    "customerPhone",
    "instructions",
    "originalFilename",
    "expectedSizeBytes",
    "sourcePageCount",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return null;
  if (
    !validString(value.customerName, 120) ||
    !validString(value.customerPhone, 30) ||
    !/^[+0-9][0-9 ()-]{5,29}$/u.test(value.customerPhone.trim()) ||
    !validString(value.originalFilename, 255) ||
    !isValidPdfSizeBytes(value.expectedSizeBytes) ||
    !Number.isSafeInteger(value.sourcePageCount) ||
    (value.sourcePageCount as number) < 1 ||
    (value.sourcePageCount as number) > 1_000_000 ||
    !(
      value.instructions === null ||
      (typeof value.instructions === "string" &&
        value.instructions.length <= 1000)
    )
  )
    return null;
  return {
    customerName: value.customerName.trim(),
    customerPhone: value.customerPhone.trim(),
    originalFilename: value.originalFilename.trim(),
    expectedSizeBytes: value.expectedSizeBytes,
    sourcePageCount: value.sourcePageCount as number,
    instructions:
      value.instructions === null ? null : value.instructions.trim() || null,
  };
}

function validateSettings(value: unknown): CustomerPrintSettingsRequest | null {
  if (!isPlainRecord(value)) return null;
  const allowed = new Set([
    "selectedPages",
    // Legacy/malicious clients may send this field. It is deliberately ignored;
    // CustomerService always derives the count from selectedPages.
    "selectedPageCount",
    "copies",
    "paperSize",
    "colorMode",
    "sides",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return null;
  if (
    !validString(value.selectedPages, 200) ||
    !isValidCopies(value.copies) ||
    value.copies > 1_000_000 ||
    !isPaperSize(value.paperSize) ||
    !isColorMode(value.colorMode) ||
    !isSidesMode(value.sides)
  )
    return null;
  return {
    selectedPages: value.selectedPages,
    copies: value.copies,
    paperSize: value.paperSize,
    colorMode: value.colorMode,
    sides: value.sides,
  };
}

function mapCustomerError(caught: unknown, env: WorkerEnv): Response {
  if (!(caught instanceof CustomerError)) throw caught;
  const statuses: Record<string, number> = {
    ONLINE_PRINTING_DISABLED: 503,
    DRAFT_INVALID: 401,
    DRAFT_EXPIRED: 410,
    UPLOAD_NOT_FOUND: 409,
    UPLOAD_STATE_INVALID: 409,
    UPLOAD_INVALID: 422,
    QUOTE_STATE_INVALID: 409,
    QUOTE_INVALID: 400,
    PRINT_OPTIONS_UNAVAILABLE: 503,
  };
  return error(
    statuses[caught.code] ?? 400,
    caught.code,
    caught.code === "ONLINE_PRINTING_DISABLED"
      ? "Online printing is currently unavailable."
      : "The customer draft request could not be completed.",
    corsHeaders(env),
  );
}

export async function handleCustomerRequest(
  request: Request,
  env: WorkerEnv,
  actions: CustomerActions = actionsFromEnv(env),
): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (request.method === "OPTIONS") {
    const rejected = rejectUntrustedOrigin(request, env);
    if (rejected) return rejected;
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders(env),
        "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Max-Age": "600",
      },
    });
  }

  if (request.method === "GET" && pathname === "/api/customer/config") {
    const config = await actions.getConfig();
    return config
      ? ok(config, 200, corsHeaders(env))
      : error(
          503,
          "CONFIG_UNAVAILABLE",
          "Shop configuration is unavailable.",
          corsHeaders(env),
        );
  }

  const rejected = rejectUntrustedOrigin(request, env);
  if (rejected) return rejected;
  if (
    Number(request.headers.get("Content-Length") ?? 0) > MAX_JSON_BODY_BYTES
  ) {
    return error(
      413,
      "BODY_TOO_LARGE",
      "This request is too large.",
      corsHeaders(env),
    );
  }
  try {
    if (request.method === "POST" && pathname === "/api/customer/drafts") {
      const input = validateDraft(await readJson(request));
      return input
        ? ok(await actions.createDraft(input), 201, corsHeaders(env))
        : error(
            400,
            "INVALID_DRAFT",
            "Enter valid details and select a PDF.",
            corsHeaders(env),
          );
    }
    const token = bearerToken(request);
    if (!token) {
      return error(
        401,
        "DRAFT_TOKEN_REQUIRED",
        "The draft token is required.",
        corsHeaders(env),
      );
    }
    if (
      request.method === "POST" &&
      pathname === "/api/customer/uploads/authorize"
    ) {
      await readJson(request);
      return ok(
        { upload: await actions.authorizeUpload(token) },
        200,
        corsHeaders(env),
      );
    }
    if (
      request.method === "POST" &&
      pathname === "/api/customer/uploads/complete"
    ) {
      await readJson(request);
      return ok(await actions.completeUpload(token), 200, corsHeaders(env));
    }
    if (
      request.method === "PUT" &&
      pathname === "/api/customer/draft/print-settings"
    ) {
      const input = validateSettings(await readJson(request));
      return input
        ? ok(await actions.quote(token, input), 200, corsHeaders(env))
        : error(
            400,
            "INVALID_PRINT_SETTINGS",
            "Choose valid print settings.",
            corsHeaders(env),
          );
    }
  } catch (caught) {
    if (caught instanceof SyntaxError) {
      return error(
        400,
        "INVALID_JSON",
        "Send a valid JSON request.",
        corsHeaders(env),
      );
    }
    return mapCustomerError(caught, env);
  }
  return error(
    404,
    "NOT_FOUND",
    "The requested resource was not found.",
    corsHeaders(env),
  );
}
