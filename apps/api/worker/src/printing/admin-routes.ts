import { guardAdminOrigin, withAdminCors } from "../admin/http";
import { clearAdminCookie, readAdminCookie } from "../auth/cookies";
import { D1AdminAuthRepository } from "../auth/repository";
import { AdminAuthService, AuthError } from "../auth/service";
import type { WorkerEnv } from "../env";
import { error, ok } from "../http";
import { D1PrintingRepository } from "./repository";

export async function handleAdminLiveOrdersRequest(
  request: Request,
  env: WorkerEnv,
  repository: D1PrintingRepository = new D1PrintingRepository(env.DB),
  authService: AdminAuthService = new AdminAuthService(
    new D1AdminAuthRepository(env.DB),
  ),
): Promise<Response> {
  const originGuard = guardAdminOrigin(request, env.ADMIN_ALLOWED_ORIGIN);
  if (originGuard) return originGuard;
  try {
    await authService.requireSession(
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
    return withAdminCors(response, env.ADMIN_ALLOWED_ORIGIN);
  }
  if (
    request.method !== "GET" ||
    new URL(request.url).pathname !== "/api/admin/orders/live"
  ) {
    return withAdminCors(
      error(404, "NOT_FOUND", "Endpoint not found."),
      env.ADMIN_ALLOWED_ORIGIN,
    );
  }
  try {
    return withAdminCors(
      ok({ orders: await repository.listLiveOrders() }),
      env.ADMIN_ALLOWED_ORIGIN,
    );
  } catch {
    return withAdminCors(
      error(500, "LIVE_ORDERS_FAILED", "Live orders could not be loaded."),
      env.ADMIN_ALLOWED_ORIGIN,
    );
  }
}
