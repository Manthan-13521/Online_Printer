import { validateDiscountRuleRequest } from "@printgo/validation";

import {
  adminRequestErrorResponse,
  guardAdminOrigin,
  readAdminJson,
  withAdminCors,
} from "../admin/http";
import { readAdminCookie, clearAdminCookie } from "../auth/cookies";
import { D1AdminAuthRepository } from "../auth/repository";
import { AdminAuthService, AuthError } from "../auth/service";
import type { WorkerEnv } from "../env";
import { error, ok } from "../http";
import { D1DiscountRuleRepository, DiscountRuleError } from "./repository";

const MAX_BODY_BYTES = 16 * 1024;

export async function handleAdminDiscountRulesRequest(
  request: Request,
  env: WorkerEnv,
): Promise<Response> {
  const allowedOrigin = env.ADMIN_ALLOWED_ORIGIN;
  const isProduction = env.APP_ENV === "production";
  const originGuard = guardAdminOrigin(request, allowedOrigin);
  if (originGuard) return originGuard;

  const rawToken = readAdminCookie(request, isProduction);
  const url = new URL(request.url);

  let response: Response;
  try {
    const authService = new AdminAuthService(new D1AdminAuthRepository(env.DB));
    await authService.requireSession(rawToken);

    const repo = new D1DiscountRuleRepository(env.DB);
    const nowMs = Date.now();

    const listOrPostMatch = url.pathname === "/api/admin/discount-rules";
    const itemMatch = /^\/api\/admin\/discount-rules\/([^/]+)$/.exec(
      url.pathname,
    );
    const toggleMatch = /^\/api\/admin\/discount-rules\/([^/]+)\/toggle$/.exec(
      url.pathname,
    );

    if (request.method === "GET" && listOrPostMatch) {
      const discountRules = await repo.listRules();
      response = ok({ discountRules });
    } else if (request.method === "POST" && listOrPostMatch) {
      const body = await readAdminJson(request, MAX_BODY_BYTES);
      const validation = validateDiscountRuleRequest(body);
      if (!validation.ok) {
        response = error(
          400,
          "VALIDATION_ERROR",
          validation.issues[0]?.message ?? "Invalid discount rule.",
        );
      } else {
        const discountRule = await repo.createRule(validation.value, nowMs);
        response = ok({ discountRule }, 201);
      }
    } else if (request.method === "PUT" && itemMatch) {
      const id = decodeURIComponent(itemMatch[1] ?? "");
      const body = await readAdminJson(request, MAX_BODY_BYTES);
      const validation = validateDiscountRuleRequest(body);
      if (!validation.ok) {
        response = error(
          400,
          "VALIDATION_ERROR",
          validation.issues[0]?.message ?? "Invalid discount rule.",
        );
      } else {
        const discountRule = await repo.updateRule(id, validation.value, nowMs);
        response = ok({ discountRule });
      }
    } else if (request.method === "DELETE" && itemMatch) {
      const id = decodeURIComponent(itemMatch[1] ?? "");
      await repo.deleteRule(id);
      response = ok({ deleted: true });
    } else if (request.method === "PATCH" && toggleMatch) {
      const id = decodeURIComponent(toggleMatch[1] ?? "");
      const discountRule = await repo.toggleRule(id, nowMs);
      response = ok({ discountRule });
    } else {
      response = error(404, "NOT_FOUND", "Resource not found.");
    }
  } catch (caught: unknown) {
    if (caught instanceof AuthError) {
      response = error(
        401,
        caught.code,
        "Your session has expired. Please sign in again.",
        { "set-cookie": clearAdminCookie(isProduction) },
      );
    } else if (caught instanceof DiscountRuleError) {
      response = error(
        caught.code === "DISCOUNT_RULE_NOT_FOUND" ? 404 : 400,
        caught.code,
        caught.message,
      );
    } else {
      const requestError = adminRequestErrorResponse(caught);
      if (requestError) {
        response = requestError;
      } else {
        throw caught;
      }
    }
  }

  return withAdminCors(response, allowedOrigin);
}
