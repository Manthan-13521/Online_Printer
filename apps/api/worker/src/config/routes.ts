import {
  validatePricingUpdateInput,
  validateShopSettingsInput,
} from "@printgo/validation";
import { PricingError } from "@printgo/pricing";

import {
  adminRequestErrorResponse,
  guardAdminOrigin,
  readAdminJson,
  withAdminCors,
} from "../admin/http";
import { readAdminCookie, clearAdminCookie } from "../auth/cookies";
import { D1AdminAuthRepository } from "../auth/repository";
import {
  AdminAuthService,
  AuthError,
  type RequiredSession,
} from "../auth/service";
import type { WorkerEnv } from "../env";
import { error, ok } from "../http";
import { D1ConfigurationRepository } from "./repository";
import { ConfigurationError, ConfigurationService } from "./service";

const MAX_CONFIGURATION_BODY_BYTES = 32 * 1024;

export interface ConfigurationActions {
  getSettings(): ReturnType<ConfigurationService["getSettings"]>;
  updateSettings: ConfigurationService["updateSettings"];
  getPricing(): ReturnType<ConfigurationService["getPricing"]>;
  updatePricing: ConfigurationService["updatePricing"];
  resetPickupCode(adminId: string): Promise<string>;
}

export interface SessionActions {
  requireSession(rawToken: string | null): Promise<RequiredSession>;
}

function configurationErrorResponse(
  caught: unknown,
  clearCookie: string,
): Response {
  if (caught instanceof AuthError) {
    return error(
      401,
      caught.code,
      "Your session has expired. Please sign in again.",
      { "set-cookie": clearCookie },
    );
  }
  const requestError = adminRequestErrorResponse(caught);
  if (requestError) return requestError;
  if (caught instanceof PricingError) {
    return error(400, caught.code, "The pricing configuration is not valid.");
  }
  if (caught instanceof ConfigurationError) {
    return error(
      500,
      caught.code,
      "PrintGo configuration is not available. Please contact support.",
    );
  }
  throw caught;
}

export async function handleAdminConfigurationRequest(
  request: Request,
  env: WorkerEnv,
  configuration: ConfigurationActions = new ConfigurationService(
    new D1ConfigurationRepository(env.DB),
  ),
  sessions: SessionActions = new AdminAuthService(
    new D1AdminAuthRepository(env.DB),
  ),
): Promise<Response> {
  const allowedOrigin = env.ADMIN_ALLOWED_ORIGIN;
  const isProduction = env.APP_ENV === "production";
  const originGuard = guardAdminOrigin(request, allowedOrigin);
  if (originGuard) return originGuard;

  const rawToken = readAdminCookie(request, isProduction);
  const url = new URL(request.url);
  let response: Response;
  try {
    const session = await sessions.requireSession(rawToken);
    if (request.method === "GET" && url.pathname === "/api/admin/settings") {
      response = ok({ settings: await configuration.getSettings() });
    } else if (
      request.method === "PUT" &&
      url.pathname === "/api/admin/settings"
    ) {
      const input = validateShopSettingsInput(
        await readAdminJson(request, MAX_CONFIGURATION_BODY_BYTES),
      );
      if (!input.ok) {
        response = error(
          400,
          "VALIDATION_ERROR",
          input.issues[0]?.message ?? "Check the shop settings.",
        );
      } else {
        response = ok({
          settings: await configuration.updateSettings(
            input.value,
            session.admin.id,
          ),
          message: "Shop settings saved.",
        });
      }
    } else if (
      request.method === "POST" &&
      url.pathname === "/api/admin/settings/reset-pickup-code"
    ) {
      const nextPickupCode = await configuration.resetPickupCode(
        session.admin.id,
      );
      response = ok({
        nextPickupCode,
        message: "Next pickup code reset to PA-001.",
      });
    } else if (
      request.method === "GET" &&
      url.pathname === "/api/admin/pricing"
    ) {
      response = ok({ pricing: await configuration.getPricing() });
    } else if (
      request.method === "PUT" &&
      url.pathname === "/api/admin/pricing"
    ) {
      const input = validatePricingUpdateInput(
        await readAdminJson(request, MAX_CONFIGURATION_BODY_BYTES),
      );
      if (!input.ok) {
        response = error(
          400,
          "VALIDATION_ERROR",
          input.issues[0]?.message ?? "Check the pricing configuration.",
        );
      } else {
        response = ok({
          pricing: await configuration.updatePricing(
            input.value,
            session.admin.id,
          ),
          message: "Pricing saved.",
        });
      }
    } else {
      response = error(
        404,
        "NOT_FOUND",
        "The requested resource was not found.",
      );
    }
  } catch (caught: unknown) {
    response = configurationErrorResponse(
      caught,
      clearAdminCookie(isProduction),
    );
  }
  return withAdminCors(response, allowedOrigin);
}
