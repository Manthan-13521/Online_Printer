import type {
  AdminChangePasswordRequest,
  AdminChangePasswordResponse,
  AdminCreatePairCodeResponse,
  AdminLoginRequest,
  AdminLoginResponse,
  AdminLiveOrdersResponse,
  AdminOrderHistoryResponse,
  AdminLogoutResponse,
  AdminMeResponse,
  AdminPricingResponse,
  AdminPricingUpdateRequest,
  AdminPrintersResponse,
  AdminRevokeAgentResponse,
  AdminSettingsResponse,
  AdminSettingsUpdateRequest,
  AdminTestPrintResponse,
  AdminTogglePrinterResponse,
  AdminManualCompleteOrderResponse,
  AdminRetryOrderResponse,
  AdminOrderPdfUrlResponse,
  AdminSetDefaultPrinterResponse,
  AdminCheckPrinterHealthResponse,
  ApiFailure,
  ApiResponse,
  AdminDashboardData,
  AdminCleanupPreviewData,
  AdminCleanupRunData,
  CleanupScope,
  AdminAddonServiceRequest,
  AdminAddonServicesResponse,
  AdminAddonServiceResponse,
  AdminManualOrdersResponse,
  AdminSetPickupChargeResponse,
  AdminDiscountRuleRequest,
  AdminDiscountRulesResponse,
  AdminDiscountRuleResponse,
  AdminResetPickupCodeResponse,
} from "@printgo/api-contract";

const API_BASE_URL =
  (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(
    /\/$/u,
    "",
  ) ?? "";

export class AdminApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AdminApiError";
  }
}

export function friendlyAdminError(caught: unknown): string {
  return caught instanceof AdminApiError
    ? caught.message
    : "PrintGo could not complete that action. Please try again.";
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      credentials: "include",
      headers: {
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new AdminApiError(
      "NETWORK_ERROR",
      0,
      "We couldn't connect to PrintGo. Check your internet connection and try again.",
    );
  }
  const body = (await response.json()) as T | ApiFailure;
  if (!response.ok || (body as ApiFailure).ok === false) {
    const failure = body as ApiFailure;
    throw new AdminApiError(
      failure.error?.code ?? "SERVICE_ERROR",
      response.status,
      failure.error?.message ?? "PrintGo could not complete that action.",
    );
  }
  return body as T;
}

export function brandingUrl(url: string): string {
  return `${API_BASE_URL}${url}`;
}

export const adminApi = {
  getDashboard(): Promise<ApiResponse<AdminDashboardData>> {
    return request("/api/admin/dashboard");
  },
  uploadLogo(
    file: File,
  ): Promise<ApiResponse<{ logoUrl: string; message: string }>> {
    return request("/api/admin/branding/logo", {
      method: "PUT",
      body: file,
      headers: { "Content-Type": file.type },
    });
  },
  removeLogo(): Promise<ApiResponse<{ logoUrl: null; message: string }>> {
    return request("/api/admin/branding/logo/remove", {
      method: "POST",
      body: "{}",
    });
  },
  login(input: AdminLoginRequest): Promise<AdminLoginResponse> {
    return request("/api/admin/auth/login", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  me(): Promise<AdminMeResponse> {
    return request("/api/admin/auth/me");
  },
  logout(): Promise<AdminLogoutResponse> {
    return request("/api/admin/auth/logout", { method: "POST", body: "{}" });
  },
  revokeAllSessions(): Promise<AdminLogoutResponse> {
    return request("/api/admin/auth/sessions/revoke-all", {
      method: "POST",
      body: "{}",
    });
  },
  changePassword(
    input: AdminChangePasswordRequest,
  ): Promise<AdminChangePasswordResponse> {
    return request("/api/admin/auth/change-password", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  getSettings(): Promise<AdminSettingsResponse> {
    return request("/api/admin/settings");
  },
  updateSettings(
    input: AdminSettingsUpdateRequest,
  ): Promise<AdminSettingsResponse> {
    return request("/api/admin/settings", {
      method: "PUT",
      body: JSON.stringify(input),
    });
  },
  cleanupPreview(
    scope: Extract<CleanupScope, "ALL_COMPLETED" | "ALL_PRINT_DATA">,
  ): Promise<ApiResponse<AdminCleanupPreviewData>> {
    return request(
      `/api/admin/cleanup/preview?scope=${encodeURIComponent(scope)}`,
    );
  },
  startCleanup(
    scope: Extract<CleanupScope, "ALL_COMPLETED" | "ALL_PRINT_DATA">,
    confirmation: string,
  ): Promise<ApiResponse<AdminCleanupRunData>> {
    return request("/api/admin/cleanup/runs", {
      method: "POST",
      body: JSON.stringify({ scope, confirmation }),
    });
  },
  getCleanupRun(runId: string): Promise<ApiResponse<AdminCleanupRunData>> {
    return request(`/api/admin/cleanup/runs/${encodeURIComponent(runId)}`);
  },
  getPricing(): Promise<AdminPricingResponse> {
    return request("/api/admin/pricing");
  },
  updatePricing(
    input: AdminPricingUpdateRequest,
  ): Promise<AdminPricingResponse> {
    return request("/api/admin/pricing", {
      method: "PUT",
      body: JSON.stringify(input),
    });
  },
  getPrinters(): Promise<AdminPrintersResponse> {
    return request("/api/admin/printers");
  },
  getLiveOrders(): Promise<AdminLiveOrdersResponse> {
    return request("/api/admin/orders/live");
  },
  getOrderHistory(cursor?: string): Promise<AdminOrderHistoryResponse> {
    return request(
      `/api/admin/orders/history${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
  },
  createPairCode(): Promise<AdminCreatePairCodeResponse> {
    return request("/api/admin/agents/pair-code", {
      method: "POST",
      body: "{}",
    });
  },
  revokeAgent(agentId: string): Promise<AdminRevokeAgentResponse> {
    return request(`/api/admin/agents/${encodeURIComponent(agentId)}/revoke`, {
      method: "POST",
      body: "{}",
    });
  },
  togglePrinter(
    printerId: string,
    enabled: boolean,
  ): Promise<AdminTogglePrinterResponse> {
    return request(`/api/admin/printers/${encodeURIComponent(printerId)}`, {
      method: "PUT",
      body: JSON.stringify({ enabled }),
    });
  },
  requestTestPrint(printerId: string): Promise<AdminTestPrintResponse> {
    return request(
      `/api/admin/printers/${encodeURIComponent(printerId)}/test-print`,
      {
        method: "POST",
        body: "{}",
      },
    );
  },
  getTestPrintStatus(printerId: string): Promise<AdminTestPrintResponse> {
    return request(
      `/api/admin/printers/${encodeURIComponent(printerId)}/test-print`,
    );
  },
  checkPrinterHealth(
    printerId: string,
  ): Promise<AdminCheckPrinterHealthResponse> {
    return request(
      `/api/admin/printers/${encodeURIComponent(printerId)}/check-health`,
      {
        method: "POST",
        body: "{}",
      },
    );
  },
  setDefaultPrinter(
    printerId: string,
  ): Promise<AdminSetDefaultPrinterResponse> {
    return request(
      `/api/admin/printers/${encodeURIComponent(printerId)}/default`,
      {
        method: "POST",
        body: "{}",
      },
    );
  },
  manualCompleteOrder(
    orderId: string,
    reason?: string,
  ): Promise<AdminManualCompleteOrderResponse> {
    return request(
      `/api/admin/orders/${encodeURIComponent(orderId)}/manual-complete`,
      {
        method: "POST",
        body: JSON.stringify({ reason }),
      },
    );
  },
  retryOrder(
    orderId: string,
    forceUncertain?: boolean,
  ): Promise<AdminRetryOrderResponse> {
    return request(
      `/api/admin/orders/${encodeURIComponent(orderId)}/retry-print`,
      {
        method: "POST",
        body: JSON.stringify({ forceUncertain }),
      },
    );
  },
  getOrderPdfUrl(orderId: string): Promise<AdminOrderPdfUrlResponse> {
    return request(`/api/admin/orders/${encodeURIComponent(orderId)}/pdf-url`);
  },
  // ── Add-on Services ──────────────────────────────────────────────
  listAddonServices(): Promise<AdminAddonServicesResponse> {
    return request("/api/admin/addon-services");
  },
  createAddonService(
    input: AdminAddonServiceRequest,
  ): Promise<AdminAddonServiceResponse> {
    return request("/api/admin/addon-services", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  updateAddonService(
    id: string,
    input: AdminAddonServiceRequest,
  ): Promise<AdminAddonServiceResponse> {
    return request(`/api/admin/addon-services/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
  },
  deleteAddonService(id: string): Promise<ApiResponse<{ deleted: boolean }>> {
    return request(`/api/admin/addon-services/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  },
  toggleAddonService(
    id: string,
    enabled: boolean,
  ): Promise<AdminAddonServiceResponse> {
    return request(
      `/api/admin/addon-services/${encodeURIComponent(id)}/toggle`,
      { method: "POST", body: JSON.stringify({ enabled }) },
    );
  },
  // ── Manual Orders ─────────────────────────────────────────────────
  getManualOrders(): Promise<AdminManualOrdersResponse> {
    return request("/api/admin/orders/manual");
  },
  markOrderPrinted(
    orderId: string,
  ): Promise<ApiResponse<{ orderId: string; status: string }>> {
    return request(
      `/api/admin/orders/${encodeURIComponent(orderId)}/mark-printed`,
      { method: "POST", body: "{}" },
    );
  },
  markOrderFinished(
    orderId: string,
  ): Promise<ApiResponse<{ orderId: string; status: string }>> {
    return request(
      `/api/admin/orders/${encodeURIComponent(orderId)}/mark-finished`,
      { method: "POST", body: "{}" },
    );
  },
  setPickupCharge(
    orderId: string,
    dueAtPickupPaise: number,
  ): Promise<AdminSetPickupChargeResponse> {
    return request(
      `/api/admin/orders/${encodeURIComponent(orderId)}/set-pickup-charge`,
      { method: "POST", body: JSON.stringify({ dueAtPickupPaise }) },
    );
  },
  // ── Discount Rules ───────────────────────────────────────────────
  getDiscountRules(): Promise<AdminDiscountRulesResponse> {
    return request("/api/admin/discount-rules");
  },
  createDiscountRule(
    input: AdminDiscountRuleRequest,
  ): Promise<AdminDiscountRuleResponse> {
    return request("/api/admin/discount-rules", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  updateDiscountRule(
    id: string,
    input: AdminDiscountRuleRequest,
  ): Promise<AdminDiscountRuleResponse> {
    return request(`/api/admin/discount-rules/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
  },
  deleteDiscountRule(id: string): Promise<ApiResponse<{ deleted: true }>> {
    return request(`/api/admin/discount-rules/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  },
  toggleDiscountRule(
    id: string,
    enabled: boolean,
  ): Promise<AdminDiscountRuleResponse> {
    return request(
      `/api/admin/discount-rules/${encodeURIComponent(id)}/toggle`,
      { method: "PATCH", body: JSON.stringify({ enabled }) },
    );
  },
  // ── Pickup Code Sequence ─────────────────────────────────────────
  resetPickupCode(): Promise<AdminResetPickupCodeResponse> {
    return request("/api/admin/settings/reset-pickup-code", {
      method: "POST",
      body: "{}",
    });
  },
  // ── Fallback Configuration ──────────────────────────────────────
  configureFallback(
    printerId: string,
    fallbackPrinterId: string | null,
    autoFallbackEnabled: boolean,
  ): Promise<
    ApiResponse<{
      printerId: string;
      fallbackPrinterId: string | null;
      autoFallbackEnabled: boolean;
    }>
  > {
    return request(
      `/api/admin/printers/${encodeURIComponent(printerId)}/fallback`,
      {
        method: "PUT",
        body: JSON.stringify({ fallbackPrinterId, autoFallbackEnabled }),
      },
    );
  },
};
