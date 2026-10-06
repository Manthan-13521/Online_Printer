import { handleDashboard } from "./config/dashboard";
import { handleBrandingRequest } from "./branding/routes";
import { error, ok } from "./http";
import { handleAdminAuthRequest } from "./auth/routes";
import { handleAdminConfigurationRequest } from "./config/routes";
import { handleAdminPrinterRequest } from "./agent/admin-routes";
import { handleAgentRequest } from "./agent/routes";
import { handleCustomerRequest } from "./customer/routes";
import type { WorkerEnv } from "./env";
import { handleRazorpayWebhook } from "./payments/webhook";
import { handleAgentPrintingRequest } from "./printing/routes";
import { handleAdminLiveOrdersRequest } from "./printing/admin-routes";
import { handleAdminRetentionRequest } from "./retention/admin-routes";
import { handleAdminCleanupRequest } from "./cleanup/admin-routes";
import {
  handleAdminAddonServicesRequest,
  handleAdminManualOrdersRequest,
} from "./addon-services/routes";
import { handleAdminDiscountRulesRequest } from "./discount-rules/routes";

export async function routeRequest(
  request: Request,
  env: WorkerEnv,
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/health") {
    return ok({ service: "printgo-api", status: "available" });
  }

  if (
    url.pathname.startsWith("/api/branding/") ||
    url.pathname.startsWith("/api/admin/branding/")
  )
    return handleBrandingRequest(request, env);

  if (url.pathname === "/api/admin/dashboard")
    return handleDashboard(request, env);

  if (url.pathname.startsWith("/api/admin/auth/")) {
    return handleAdminAuthRequest(request, env);
  }

  if (
    url.pathname === "/api/admin/settings" ||
    url.pathname === "/api/admin/settings/reset-pickup-code" ||
    url.pathname === "/api/admin/pricing"
  ) {
    return handleAdminConfigurationRequest(request, env);
  }

  if (
    url.pathname.startsWith("/api/admin/agents") ||
    url.pathname.startsWith("/api/admin/printers")
  ) {
    return handleAdminPrinterRequest(request, env);
  }

  if (url.pathname.startsWith("/api/admin/addon-services")) {
    return handleAdminAddonServicesRequest(request, env);
  }

  if (url.pathname.startsWith("/api/admin/discount-rules")) {
    return handleAdminDiscountRulesRequest(request, env);
  }

  if (url.pathname.startsWith("/api/admin/print-system")) {
    const { handleAdminPrintSystemRequest } =
      await import("./printing/recovery-admin-routes");
    return handleAdminPrintSystemRequest(request, env);
  }

  if (url.pathname.startsWith("/api/admin/orders")) {
    // Manual orders management (mark-printed, mark-finished, set-pickup-charge, list manual)
    const isManualPath =
      url.pathname === "/api/admin/orders/manual" ||
      /^\/api\/admin\/orders\/[^/]+\/(mark-printed|mark-finished|set-pickup-charge)$/.test(
        url.pathname,
      );
    if (isManualPath) {
      return handleAdminManualOrdersRequest(request, env);
    }
    return handleAdminLiveOrdersRequest(request, env);
  }

  if (url.pathname.startsWith("/api/admin/retention")) {
    return handleAdminRetentionRequest(request, env);
  }

  if (url.pathname.startsWith("/api/admin/cleanup")) {
    return handleAdminCleanupRequest(request, env);
  }

  if (url.pathname.startsWith("/api/agent/")) {
    if (url.pathname.startsWith("/api/agent/print-jobs/")) {
      return handleAgentPrintingRequest(request, env);
    }
    return handleAgentRequest(request, env);
  }

  if (url.pathname.startsWith("/api/customer/")) {
    return handleCustomerRequest(request, env);
  }

  if (url.pathname === "/api/webhooks/razorpay") {
    return handleRazorpayWebhook(request, env);
  }

  return error(404, "NOT_FOUND", "The requested resource was not found.");
}
