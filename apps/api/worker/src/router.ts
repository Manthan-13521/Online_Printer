import { error, ok } from "./http";
import { handleAdminAuthRequest } from "./auth/routes";
import { handleAdminConfigurationRequest } from "./config/routes";
import { handleAdminPrinterRequest } from "./agent/admin-routes";
import { handleAgentRequest } from "./agent/routes";
import { handleCustomerRequest } from "./customer/routes";
import type { WorkerEnv } from "./env";
import { handleRazorpayWebhook } from "./payments/webhook";

export async function routeRequest(
  request: Request,
  env: WorkerEnv,
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/health") {
    return ok({ service: "printgo-api", status: "available" });
  }

  if (url.pathname.startsWith("/api/admin/auth/")) {
    return handleAdminAuthRequest(request, env);
  }

  if (
    url.pathname === "/api/admin/settings" ||
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

  if (url.pathname.startsWith("/api/agent/")) {
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
