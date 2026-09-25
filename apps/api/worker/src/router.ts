import { error, ok } from "./http";
import { handleAdminAuthRequest } from "./auth/routes";
import type { WorkerEnv } from "./env";

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

  return error(404, "NOT_FOUND", "The requested resource was not found.");
}
