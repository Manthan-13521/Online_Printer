import type {
  AddCustomerFileRequest,
  CancelCustomerPaymentRequest,
  CreateCustomerDraftRequest,
  CreateCustomerPaymentRequest,
  CustomerOrderQuoteRequest,
  CustomerPrintSettingsRequest,
  VerifyCustomerPaymentRequest,
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
import {
  LocalDevUploadSigner,
  R2UploadSigner,
} from "../storage/r2-upload-signer";
import { R2PrivateObjectStore } from "../storage/r2-verification";
import { D1CustomerRepository } from "./repository";
import { CustomerError, CustomerService } from "./service";
import { D1PaymentRepository } from "../payments/repository";
import { D1PaymentReadiness } from "../payments/readiness";
import { HttpRazorpayClient } from "../payments/razorpay";
import { PaymentError, PaymentService } from "../payments/service";
import { D1TrackingRepository } from "../tracking/repository";
import { TrackingError, TrackingService } from "../tracking/service";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const MAX_JSON_BODY_BYTES = 8 * 1024;

export interface CustomerActions {
  getConfig(): ReturnType<D1CustomerRepository["getPublicConfig"]>;
  createDraft(
    input: CreateCustomerDraftRequest,
  ): ReturnType<CustomerService["createDraft"]>;
  authorizeUpload(
    token: string,
    fileId?: string,
  ): ReturnType<CustomerService["authorizeUpload"]>;
  completeUpload(
    token: string,
    fileId?: string,
  ): ReturnType<CustomerService["completeUpload"]>;
  addFile(
    token: string,
    input: AddCustomerFileRequest,
  ): ReturnType<CustomerService["addFile"]>;
  removeFile(
    token: string,
    fileId: string,
  ): ReturnType<CustomerService["removeFile"]>;
  getDraft(token: string): ReturnType<CustomerService["getDraft"]>;
  quote(
    token: string,
    input: CustomerPrintSettingsRequest,
  ): ReturnType<CustomerService["quote"]>;
  quoteOrder(
    token: string,
    input: CustomerOrderQuoteRequest,
  ): ReturnType<CustomerService["quoteOrder"]>;
  createPayment(
    token: string,
    input: CreateCustomerPaymentRequest,
  ): ReturnType<PaymentService["createCheckout"]>;
  verifyPayment(
    token: string,
    input: VerifyCustomerPaymentRequest,
  ): ReturnType<PaymentService["verify"]>;
  cancelPayment(
    token: string,
    input: CancelCustomerPaymentRequest,
  ): ReturnType<PaymentService["cancel"]>;
  tracking(jobCode: string, token: string): ReturnType<TrackingService["get"]>;
  trackPublicOrder(
    pickupCode: string,
  ): ReturnType<CustomerService["trackPublicOrder"]>;
}

function actionsFromEnv(env: WorkerEnv): CustomerActions {
  const repository = new D1CustomerRepository(env.DB);
  const signer =
    env.APP_ENV === "development" &&
    env.R2_ACCOUNT_ID === "local-r2-not-configured"
      ? new LocalDevUploadSigner(env.CUSTOMER_ALLOWED_ORIGIN)
      : new R2UploadSigner({
          accountId: env.R2_ACCOUNT_ID,
          bucketName: env.R2_BUCKET_NAME,
          accessKeyId: env.R2_ACCESS_KEY_ID,
          secretAccessKey: env.R2_SECRET_ACCESS_KEY,
        });
  const service = new CustomerService(
    repository,
    signer,
    new R2PrivateObjectStore(env.PDF_BUCKET),
  );
  const keyId = env.RAZORPAY_KEY_ID ?? "";
  const keySecret = env.RAZORPAY_KEY_SECRET ?? "";
  const trackingService = new TrackingService(new D1TrackingRepository(env.DB));
  const paymentService = new PaymentService(
    new D1PaymentRepository(env.DB),
    repository,
    new R2PrivateObjectStore(env.PDF_BUCKET),
    new D1PaymentReadiness(env.DB, env),
    new HttpRazorpayClient(keyId, keySecret),
    { keyId, keySecret },
    trackingService,
  );
  return {
    getConfig: () => repository.getPublicConfig(),
    createDraft: (input) => service.createDraft(input),
    authorizeUpload: (token, fileId) => service.authorizeUpload(token, fileId),
    completeUpload: (token, fileId) => service.completeUpload(token, fileId),
    addFile: (token, input) => service.addFile(token, input),
    removeFile: (token, fileId) => service.removeFile(token, fileId),
    getDraft: (token) => service.getDraft(token),
    quote: (token, input) => service.quote(token, input),
    quoteOrder: (token, input) => service.quoteOrder(token, input),
    createPayment: (token, input) =>
      paymentService.createCheckout(token, input.acknowledgedTotalPaise),
    verifyPayment: (token, input) => paymentService.verify(token, input),
    cancelPayment: (token, input) =>
      paymentService.cancel(token, input.razorpayOrderId),
    tracking: (jobCode, token) => trackingService.get(jobCode, token),
    trackPublicOrder: (pickupCode) => service.trackPublicOrder(pickupCode),
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
    "addonServiceIds",
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
    ) ||
    !(
      value.addonServiceIds === undefined ||
      (Array.isArray(value.addonServiceIds) &&
        value.addonServiceIds.length <= 10 &&
        value.addonServiceIds.every(
          (id) => typeof id === "string" && id.length > 0 && id.length <= 50,
        ))
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
    ...(Array.isArray(value.addonServiceIds)
      ? { addonServiceIds: value.addonServiceIds as string[] }
      : {}),
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

function validateFile(value: unknown): AddCustomerFileRequest | null {
  if (!isPlainRecord(value)) return null;
  const allowed = new Set([
    "originalFilename",
    "expectedSizeBytes",
    "sourcePageCount",
  ]);
  if (
    Object.keys(value).some((key) => !allowed.has(key)) ||
    !validString(value.originalFilename, 255) ||
    !isValidPdfSizeBytes(value.expectedSizeBytes) ||
    !Number.isSafeInteger(value.sourcePageCount) ||
    (value.sourcePageCount as number) < 1 ||
    (value.sourcePageCount as number) > 1_000_000
  )
    return null;
  return {
    originalFilename: value.originalFilename.trim(),
    expectedSizeBytes: value.expectedSizeBytes,
    sourcePageCount: value.sourcePageCount as number,
  };
}

const trackingRateLimits = new Map<
  string,
  { count: number; resetAtMs: number }
>();

function checkTrackingRateLimit(
  ip: string,
  nowMs: number = Date.now(),
): boolean {
  const current = trackingRateLimits.get(ip);
  if (!current || current.resetAtMs <= nowMs) {
    trackingRateLimits.set(ip, { count: 1, resetAtMs: nowMs + 60_000 });
    return true;
  }
  if (current.count >= 60) {
    return false;
  }
  current.count++;
  return true;
}

function validateOrderSettings(
  value: unknown,
): CustomerOrderQuoteRequest | null {
  if (!isPlainRecord(value) || !Array.isArray(value.files)) return null;
  const allowed = new Set(["files", "isPriority"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return null;
  if (value.isPriority !== undefined && typeof value.isPriority !== "boolean")
    return null;
  if (value.files.length < 1 || value.files.length > 10) return null;
  const files: CustomerOrderQuoteRequest["files"] = [];
  for (const entry of value.files) {
    if (!isPlainRecord(entry) || typeof entry.fileId !== "string") return null;
    const { fileId, ...rawSettings } = entry;
    const settings = validateSettings(rawSettings);
    if (!settings || !/^[0-9a-f-]{36}$/iu.test(entry.fileId)) return null;
    files.push({ ...settings, fileId });
  }
  return value.isPriority !== undefined
    ? { files, isPriority: value.isPriority }
    : { files };
}

function validateCreatePayment(
  value: unknown,
): CreateCustomerPaymentRequest | null {
  if (
    !isPlainRecord(value) ||
    Object.keys(value).some((key) => key !== "acknowledgedTotalPaise") ||
    !Number.isSafeInteger(value.acknowledgedTotalPaise) ||
    (value.acknowledgedTotalPaise as number) < 0
  ) {
    return null;
  }
  return { acknowledgedTotalPaise: value.acknowledgedTotalPaise as number };
}

function validProviderId(
  value: unknown,
  prefix: "order_" | "pay_",
): value is string {
  return (
    typeof value === "string" &&
    value.startsWith(prefix) &&
    /^[A-Za-z0-9_]{6,100}$/u.test(value)
  );
}

function validateVerifyPayment(
  value: unknown,
): VerifyCustomerPaymentRequest | null {
  if (
    !isPlainRecord(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          "razorpayOrderId",
          "razorpayPaymentId",
          "razorpaySignature",
          "trackingToken",
        ].includes(key),
    ) ||
    !validProviderId(value.razorpayOrderId, "order_") ||
    !validProviderId(value.razorpayPaymentId, "pay_") ||
    typeof value.razorpaySignature !== "string" ||
    !/^[a-f0-9]{64}$/iu.test(value.razorpaySignature) ||
    typeof value.trackingToken !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(value.trackingToken)
  ) {
    return null;
  }
  return {
    razorpayOrderId: value.razorpayOrderId,
    razorpayPaymentId: value.razorpayPaymentId,
    razorpaySignature: value.razorpaySignature,
    trackingToken: value.trackingToken,
  };
}

function validateCancelPayment(
  value: unknown,
): CancelCustomerPaymentRequest | null {
  if (
    !isPlainRecord(value) ||
    Object.keys(value).some((key) => key !== "razorpayOrderId") ||
    !validProviderId(value.razorpayOrderId, "order_")
  ) {
    return null;
  }
  return { razorpayOrderId: value.razorpayOrderId };
}

function mapCustomerError(caught: unknown, env: WorkerEnv): Response {
  if (caught instanceof TrackingError) {
    if (caught.code === "TRACKING_NOT_FOUND") {
      return error(
        404,
        "TRACKING_NOT_FOUND",
        "This private tracking link is invalid or has expired.",
        corsHeaders(env),
      );
    }
    return error(
      409,
      "TRACKING_ACCESS_UNAVAILABLE",
      "Private tracking access could not be restored.",
      corsHeaders(env),
    );
  }
  if (caught instanceof PaymentError) {
    const statuses: Record<string, number> = {
      DRAFT_INVALID: 401,
      DRAFT_EXPIRED: 410,
      PAYMENT_STATE_INVALID: 409,
      UPLOAD_NOT_FOUND: 409,
      UPLOAD_INVALID: 422,
      ONLINE_PRINTING_DISABLED: 503,
      PRINTER_NOT_READY: 503,
      PAYMENT_CONFIGURATION_MISSING: 503,
      PAYMENT_CREATION_IN_PROGRESS: 409,
      PAYMENT_PROVIDER_UNAVAILABLE: 502,
      PAYMENT_ORDER_MISMATCH: 409,
      PAYMENT_SIGNATURE_INVALID: 400,
      PAYMENT_NOT_CAPTURED: 409,
      PAYMENT_DETAILS_MISMATCH: 409,
      PAYMENT_AMOUNT_INVALID: 409,
    };
    const messages: Record<string, string> = {
      PRINTER_NOT_READY:
        "Online payment is unavailable until the shop printer is ready.",
      PAYMENT_SIGNATURE_INVALID: "Payment verification failed.",
      PAYMENT_NOT_CAPTURED: "The payment has not been captured.",
      PAYMENT_CONFIGURATION_MISSING: "Online payment is not configured.",
      PAYMENT_PROVIDER_UNAVAILABLE:
        "The payment provider is temporarily unavailable.",
    };
    return error(
      statuses[caught.code] ?? 400,
      caught.code,
      caught.message && caught.message !== caught.code
        ? caught.message
        : (messages[caught.code] ?? "The payment request could not be completed."),
      corsHeaders(env),
    );
  }
  if (!(caught instanceof CustomerError)) throw caught;
  const statuses: Record<string, number> = {
    ONLINE_PRINTING_DISABLED: 503,
    DRAFT_INVALID: 401,
    DRAFT_EXPIRED: 410,
    UPLOAD_NOT_FOUND: 409,
    UPLOAD_STATE_INVALID: 409,
    UPLOAD_INVALID: 422,
    FILE_LIMIT_REACHED: 409,
    AGGREGATE_LIMIT_REACHED: 413,
    FILE_NOT_FOUND: 404,
    LAST_FILE_REQUIRED: 409,
    FILE_DELETE_FAILED: 503,
    QUOTE_STATE_INVALID: 409,
    QUOTE_INVALID: 400,
    PRINT_OPTIONS_UNAVAILABLE: 503,
    TRACKING_NOT_FOUND: 404,
  };
  return error(
    statuses[caught.code] ?? 400,
    caught.code,
    caught.code === "TRACKING_NOT_FOUND"
      ? "No active order found for that pickup code."
      : caught.code === "ONLINE_PRINTING_DISABLED"
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
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Max-Age": "600",
      },
    });
  }

  if (request.method === "GET" && pathname === "/api/customer/config") {
    const config = await actions.getConfig();
    return config
      ? ok(config, 200, {
          ...corsHeaders(env),
          "Cache-Control": "public, max-age=30, stale-while-revalidate=60",
        })
      : error(
          503,
          "CONFIG_UNAVAILABLE",
          "Shop configuration is unavailable.",
          corsHeaders(env),
        );
  }

  const publicTrackMatch = /^\/api\/customer\/track\/([A-Za-z0-9_-]+)$/u.exec(
    pathname,
  );
  if (request.method === "GET" && publicTrackMatch) {
    const clientIp = request.headers.get("cf-connecting-ip") ?? "unknown";
    if (!checkTrackingRateLimit(clientIp)) {
      return error(
        429,
        "RATE_LIMITED",
        "Too many tracking requests. Please try again shortly.",
        corsHeaders(env),
      );
    }
    const rawCode = decodeURIComponent(publicTrackMatch[1] ?? "");
    try {
      const tracking = await actions.trackPublicOrder(rawCode);
      return ok(tracking, 200, corsHeaders(env));
    } catch (caught) {
      return mapCustomerError(caught, env);
    }
  }

  const rejected = rejectUntrustedOrigin(request, env);
  if (rejected) return rejected;

  if (
    env.APP_ENV === "development" &&
    request.method === "PUT" &&
    pathname === "/api/customer/uploads/local"
  ) {
    const key = new URL(request.url).searchParams.get("key");
    if (!key) {
      return error(400, "INVALID_KEY", "Key is required", corsHeaders(env));
    }
    await env.PDF_BUCKET.put(key, request.body);
    return new Response(null, { status: 200, headers: corsHeaders(env) });
  }

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
    const trackingMatch = /^\/api\/customer\/tracking\/([^/]+)$/u.exec(
      pathname,
    );
    if (request.method === "GET" && trackingMatch) {
      if (!token) throw new TrackingError("TRACKING_NOT_FOUND");
      return ok(
        await actions.tracking(
          decodeURIComponent(trackingMatch[1] ?? ""),
          token,
        ),
        200,
        corsHeaders(env),
      );
    }
    if (!token) {
      return error(
        401,
        "DRAFT_TOKEN_REQUIRED",
        "The draft token is required.",
        corsHeaders(env),
      );
    }
    if (request.method === "GET" && pathname === "/api/customer/draft") {
      return ok(await actions.getDraft(token), 200, corsHeaders(env));
    }
    if (request.method === "POST" && pathname === "/api/customer/draft/files") {
      const input = validateFile(await readJson(request));
      return input
        ? ok(await actions.addFile(token, input), 201, corsHeaders(env))
        : error(400, "INVALID_FILE", "Choose a valid PDF.", corsHeaders(env));
    }
    const removeMatch =
      /^\/api\/customer\/draft\/files\/([0-9a-f-]{36})$/iu.exec(pathname);
    if (request.method === "DELETE" && removeMatch) {
      return ok(
        await actions.removeFile(token, removeMatch[1] ?? ""),
        200,
        corsHeaders(env),
      );
    }
    if (
      request.method === "POST" &&
      pathname === "/api/customer/uploads/authorize"
    ) {
      const payload = await readJson(request);
      const fileId =
        isPlainRecord(payload) && typeof payload.fileId === "string"
          ? payload.fileId
          : undefined;
      return ok(
        { upload: await actions.authorizeUpload(token, fileId) },
        200,
        corsHeaders(env),
      );
    }
    if (
      request.method === "POST" &&
      pathname === "/api/customer/uploads/complete"
    ) {
      const payload = await readJson(request);
      const fileId =
        isPlainRecord(payload) && typeof payload.fileId === "string"
          ? payload.fileId
          : undefined;
      return ok(
        await actions.completeUpload(token, fileId),
        200,
        corsHeaders(env),
      );
    }
    if (
      request.method === "PUT" &&
      pathname === "/api/customer/draft/print-settings"
    ) {
      const value = await readJson(request);
      const orderInput = validateOrderSettings(value);
      const input = validateSettings(value);
      return orderInput
        ? ok(await actions.quoteOrder(token, orderInput), 200, corsHeaders(env))
        : input
          ? ok(await actions.quote(token, input), 200, corsHeaders(env))
          : error(
              400,
              "INVALID_PRINT_SETTINGS",
              "Choose valid print settings.",
              corsHeaders(env),
            );
    }
    if (
      request.method === "POST" &&
      pathname === "/api/customer/payments/create"
    ) {
      const input = validateCreatePayment(await readJson(request));
      return input
        ? ok(await actions.createPayment(token, input), 200, corsHeaders(env))
        : error(
            400,
            "INVALID_PAYMENT_REQUEST",
            "Review the current total before paying.",
            corsHeaders(env),
          );
    }
    if (
      request.method === "POST" &&
      pathname === "/api/customer/payments/verify"
    ) {
      const input = validateVerifyPayment(await readJson(request));
      return input
        ? ok(await actions.verifyPayment(token, input), 200, corsHeaders(env))
        : error(
            400,
            "INVALID_PAYMENT_VERIFICATION",
            "Payment verification details are invalid.",
            corsHeaders(env),
          );
    }
    if (
      request.method === "POST" &&
      pathname === "/api/customer/payments/cancel"
    ) {
      const input = validateCancelPayment(await readJson(request));
      return input
        ? ok(await actions.cancelPayment(token, input), 200, corsHeaders(env))
        : error(
            400,
            "INVALID_PAYMENT_CANCELLATION",
            "Payment cancellation details are invalid.",
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
