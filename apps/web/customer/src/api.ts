import type {
  ApiResponse,
  CompleteCustomerUploadData,
  CancelCustomerPaymentData,
  CancelCustomerPaymentRequest,
  CreateCustomerDraftData,
  CreateCustomerDraftRequest,
  CreateCustomerPaymentData,
  CreateCustomerPaymentRequest,
  CustomerConfigData,
  CustomerDraftData,
  CustomerOrderQuoteRequest,
  CustomerPaymentSuccessData,
  CustomerTrackingData,
  CustomerPrintSettingsRequest,
  CustomerQuoteData,
  PublicOrderTrackingData,
  UploadAuthorization,
  AddCustomerFileData,
  AddCustomerFileRequest,
  VerifyCustomerPaymentRequest,
} from "@printgo/api-contract";

export const API_BASE_URL =
  (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(
    /\/$/u,
    "",
  ) ?? "";

export function resolveCustomerApiUrl(
  path: string,
  baseUrl: string = API_BASE_URL,
): string {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }
  const cleanBase = baseUrl.replace(/\/$/u, "");
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  return cleanBase ? `${cleanBase}${cleanPath}` : cleanPath;
}

async function jsonRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const url = resolveCustomerApiUrl(path);
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
    cache: "no-store",
  });
  const body = (await response.json()) as ApiResponse<T>;
  if (!response.ok || !body.ok)
    throw new Error(body.ok ? "REQUEST_FAILED" : (body.error.message || body.error.code));
  return body.data;
}

function authorized(token: string, init?: RequestInit): RequestInit {
  return {
    ...init,
    headers: { ...init?.headers, Authorization: `Bearer ${token}` },
  };
}

export const customerApi = {
  config: () => jsonRequest<CustomerConfigData>("/api/customer/config"),
  createDraft: (input: CreateCustomerDraftRequest) =>
    jsonRequest<CreateCustomerDraftData>("/api/customer/drafts", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  complete: (token: string, fileId?: string) =>
    jsonRequest<CompleteCustomerUploadData>(
      "/api/customer/uploads/complete",
      authorized(token, {
        method: "POST",
        body: JSON.stringify(fileId ? { fileId } : {}),
      }),
    ),
  authorize: (token: string, fileId?: string) =>
    jsonRequest<{ upload: UploadAuthorization }>(
      "/api/customer/uploads/authorize",
      authorized(token, {
        method: "POST",
        body: JSON.stringify(fileId ? { fileId } : {}),
      }),
    ),
  getDraft: (token: string) =>
    jsonRequest<CustomerDraftData>("/api/customer/draft", authorized(token)),
  addFile: (token: string, input: AddCustomerFileRequest) =>
    jsonRequest<AddCustomerFileData>(
      "/api/customer/draft/files",
      authorized(token, { method: "POST", body: JSON.stringify(input) }),
    ),
  removeFile: (token: string, fileId: string) =>
    jsonRequest<CustomerDraftData>(
      `/api/customer/draft/files/${encodeURIComponent(fileId)}`,
      authorized(token, { method: "DELETE" }),
    ),
  quote: (token: string, input: CustomerPrintSettingsRequest) =>
    jsonRequest<CustomerQuoteData>(
      "/api/customer/draft/print-settings",
      authorized(token, { method: "PUT", body: JSON.stringify(input) }),
    ),
  quoteOrder: (token: string, input: CustomerOrderQuoteRequest) =>
    jsonRequest<CustomerQuoteData>(
      "/api/customer/draft/print-settings",
      authorized(token, { method: "PUT", body: JSON.stringify(input) }),
    ),
  createPayment: (token: string, input: CreateCustomerPaymentRequest) =>
    jsonRequest<CreateCustomerPaymentData>(
      "/api/customer/payments/create",
      authorized(token, { method: "POST", body: JSON.stringify(input) }),
    ),
  verifyPayment: (token: string, input: VerifyCustomerPaymentRequest) =>
    jsonRequest<CustomerPaymentSuccessData>(
      "/api/customer/payments/verify",
      authorized(token, { method: "POST", body: JSON.stringify(input) }),
    ),
  cancelPayment: (token: string, input: CancelCustomerPaymentRequest) =>
    jsonRequest<CancelCustomerPaymentData>(
      "/api/customer/payments/cancel",
      authorized(token, { method: "POST", body: JSON.stringify(input) }),
    ),
  tracking: (jobCode: string, token: string) =>
    jsonRequest<CustomerTrackingData>(
      `/api/customer/tracking/${encodeURIComponent(jobCode)}`,
      authorized(token),
    ),
  trackPublic: (pickupCode: string) =>
    jsonRequest<PublicOrderTrackingData>(
      `/api/customer/track/${encodeURIComponent(pickupCode)}`,
    ),
};

export function uploadDirectly(
  file: File,
  uploadUrl: string,
  headers: Readonly<Record<string, string>>,
  onProgress: (percent: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("UPLOAD_ABORTED"));
    const request = new XMLHttpRequest();
    const abortHandler = () => request.abort();
    if (signal) {
      signal.addEventListener("abort", abortHandler);
    }
    request.open("PUT", uploadUrl);
    for (const [name, value] of Object.entries(headers))
      request.setRequestHeader(name, value);
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable)
        onProgress(Math.round((event.loaded / event.total) * 100));
    });
    request.addEventListener("load", () => {
      if (signal) signal.removeEventListener("abort", abortHandler);
      if (request.status >= 200 && request.status < 300) resolve();
      else reject(new Error(`UPLOAD_HTTP_${request.status}`));
    });
    request.addEventListener("abort", () => {
      if (signal) signal.removeEventListener("abort", abortHandler);
      reject(new Error("UPLOAD_ABORTED"));
    });
    request.addEventListener("error", () => {
      if (signal) signal.removeEventListener("abort", abortHandler);
      reject(new Error("UPLOAD_NETWORK_ERROR"));
    });
    request.send(file);
  });
}
