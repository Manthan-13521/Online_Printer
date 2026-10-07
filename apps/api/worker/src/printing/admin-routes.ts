import { guardAdminOrigin, readAdminJson, withAdminCors } from "../admin/http";
import { clearAdminCookie, readAdminCookie } from "../auth/cookies";
import { D1AdminAuthRepository } from "../auth/repository";
import { AdminAuthService, AuthError } from "../auth/service";
import type { WorkerEnv } from "../env";
import { error, ok } from "../http";
import { D1OrderHistoryRepository } from "../history/repository";
import { D1PrintingRepository } from "./repository";
import { createPrintingService } from "./routes";
import { PrintingError } from "./service";

const MAX_JSON_BYTES = 8 * 1024;

export async function handleAdminOrdersRequest(
  request: Request,
  env: WorkerEnv,
  repository: D1PrintingRepository = new D1PrintingRepository(env.DB),
  authService: AdminAuthService = new AdminAuthService(
    new D1AdminAuthRepository(env.DB),
  ),
): Promise<Response> {
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
    return withAdminCors(response, env.ADMIN_ALLOWED_ORIGIN);
  }

  const pathname = new URL(request.url).pathname;

  try {
    if (request.method === "GET" && pathname === "/api/admin/orders/live") {
      return withAdminCors(
        ok({ orders: await repository.listLiveOrders() }),
        env.ADMIN_ALLOWED_ORIGIN,
      );
    }

    if (request.method === "GET" && pathname === "/api/admin/orders/history") {
      const cursor = new URL(request.url).searchParams.get("cursor");
      try {
        const history = await new D1OrderHistoryRepository(env.DB).list(cursor);
        return withAdminCors(ok(history), env.ADMIN_ALLOWED_ORIGIN);
      } catch (caught) {
        if (
          caught instanceof Error &&
          caught.message === "INVALID_HISTORY_CURSOR"
        ) {
          return withAdminCors(
            error(400, "INVALID_HISTORY_CURSOR", "Invalid history page."),
            env.ADMIN_ALLOWED_ORIGIN,
          );
        }
        throw caught;
      }
    }

    const manualCompleteMatch =
      /^\/api\/admin\/orders\/([^/]+)\/manual-complete$/u.exec(pathname);
    if (request.method === "POST" && manualCompleteMatch) {
      const orderId = decodeURIComponent(manualCompleteMatch[1] ?? "");
      let reason: string | undefined;
      try {
        const body = (await readAdminJson(request, MAX_JSON_BYTES)) as Record<
          string,
          unknown
        >;
        if (typeof body.reason === "string") {
          reason = body.reason.trim();
        }
      } catch {
        // empty body is acceptable
      }
      const printingService = createPrintingService(env);
      const result = await printingService.manualComplete(
        orderId,
        session.admin.id,
        reason,
      );
      return withAdminCors(ok(result, 200), env.ADMIN_ALLOWED_ORIGIN);
    }

    const retryMatch = /^\/api\/admin\/orders\/([^/]+)\/retry-print$/u.exec(
      pathname,
    );
    if (request.method === "POST" && retryMatch) {
      const orderId = decodeURIComponent(retryMatch[1] ?? "");
      let forceUncertain = false;
      try {
        const body = (await readAdminJson(request, MAX_JSON_BYTES)) as Record<
          string,
          unknown
        >;
        forceUncertain = body.forceUncertain === true;
      } catch {
        // empty body is acceptable
      }
      const printingService = createPrintingService(env);
      const result = await printingService.retryOrder(
        orderId,
        session.admin.id,
        forceUncertain,
      );
      return withAdminCors(ok(result, 200), env.ADMIN_ALLOWED_ORIGIN);
    }

    const pdfUrlMatch = /^\/api\/admin\/orders\/([^/]+)\/pdf-url$/u.exec(
      pathname,
    );
    if (request.method === "GET" && pdfUrlMatch) {
      const orderId = decodeURIComponent(pdfUrlMatch[1] ?? "");
      const printingService = createPrintingService(env);
      const result = await printingService.getOrderPdfUrl(orderId);
      return withAdminCors(ok(result, 200), env.ADMIN_ALLOWED_ORIGIN);
    }

    return withAdminCors(
      error(404, "NOT_FOUND", "Endpoint not found."),
      env.ADMIN_ALLOWED_ORIGIN,
    );
  } catch (caught) {
    if (caught instanceof PrintingError) {
      if (caught.code === "ORDER_PDF_EXPIRED") {
        return withAdminCors(
          error(
            410,
            "ORDER_PDF_EXPIRED",
            "The document for this order has expired according to the shop privacy policy and is no longer available.",
          ),
          env.ADMIN_ALLOWED_ORIGIN,
        );
      }
      if (
        caught.code === "ORDER_NOT_FOUND" ||
        caught.code === "ORDER_PDF_NOT_FOUND"
      ) {
        return withAdminCors(
          error(404, caught.code, "Requested resource not found."),
          env.ADMIN_ALLOWED_ORIGIN,
        );
      }
      if (caught.code === "ORDER_ALREADY_IN_PROGRESS") {
        return withAdminCors(
          error(400, "ORDER_ALREADY_IN_PROGRESS", "Already in print queue."),
          env.ADMIN_ALLOWED_ORIGIN,
        );
      }
      if (caught.code === "ORDER_IS_UNCERTAIN") {
        return withAdminCors(
          error(
            400,
            "ORDER_IS_UNCERTAIN",
            "Some pages may already have printed. Reprinting may produce duplicates. Please resolve the uncertainty first.",
          ),
          env.ADMIN_ALLOWED_ORIGIN,
        );
      }
      if (caught.code === "ORDER_CANNOT_BE_RETRIED") {
        return withAdminCors(
          error(
            400,
            "ORDER_CANNOT_BE_RETRIED",
            "Order is not in a retriable state.",
          ),
          env.ADMIN_ALLOWED_ORIGIN,
        );
      }
      if (caught.code === "UNCERTAIN_RETRY_CONFIRMATION_REQUIRED") {
        return withAdminCors(
          error(
            400,
            "UNCERTAIN_RETRY_CONFIRMATION_REQUIRED",
            "Confirmation is required to retry an uncertain print order.",
          ),
          env.ADMIN_ALLOWED_ORIGIN,
        );
      }
      if (
        caught.code === "ORDER_CANNOT_BE_COMPLETED" ||
        caught.code === "ORDER_CONFIRMATION_REQUIRED"
      ) {
        return withAdminCors(
          error(
            409,
            caught.code,
            caught.code === "ORDER_CONFIRMATION_REQUIRED"
              ? "Enter a brief physical print confirmation before completing this order."
              : "This order still has active or unresolved print work.",
          ),
          env.ADMIN_ALLOWED_ORIGIN,
        );
      }
    }
    return withAdminCors(
      error(500, "ADMIN_ORDER_FAILED", "Order action failed."),
      env.ADMIN_ALLOWED_ORIGIN,
    );
  }
}

// Backward-compatible alias for existing imports
export const handleAdminLiveOrdersRequest = handleAdminOrdersRequest;
