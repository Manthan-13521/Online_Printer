import type {
  AdminChangePasswordRequest,
  AdminChangePasswordResponse,
  AdminLoginRequest,
  AdminLoginResponse,
  AdminLogoutResponse,
  AdminMeResponse,
  AdminPricingResponse,
  AdminPricingUpdateRequest,
  AdminSettingsResponse,
  AdminSettingsUpdateRequest,
  ApiFailure,
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

export const adminApi = {
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
};
