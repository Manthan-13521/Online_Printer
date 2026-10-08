import {
  validateAdminLoginInput,
  validateAdminPasswordChangeInput,
} from "@printgo/validation";

import type { WorkerEnv } from "../env";
import { error, ok } from "../http";
import {
  adminRequestErrorResponse,
  guardAdminOrigin,
  readAdminJson,
  resolveAdminCorsOrigin,
  withAdminCors,
} from "../admin/http";
import {
  clearAdminCookie,
  createAdminCookie,
  readAdminCookie,
} from "./cookies";
import { D1AdminAuthRepository } from "./repository";
import {
  AdminAuthService,
  AuthError,
  type IssuedSession,
  type RequiredSession,
} from "./service";

const MAX_AUTH_BODY_BYTES = 2048;

export interface AdminAuthActions {
  login(loginIdentifier: string, password: string): Promise<IssuedSession>;
  requireSession(rawToken: string | null): Promise<RequiredSession>;
  logout(rawToken: string | null): Promise<void>;
  revokeAllSessions(required: RequiredSession): Promise<void>;
  changePassword(
    required: RequiredSession,
    currentPassword: string,
    newPassword: string,
  ): Promise<IssuedSession>;
}

function authErrorResponse(caught: unknown, clearCookie: string): Response {
  if (caught instanceof AuthError) {
    if (caught.code === "AUTH_INVALID_CREDENTIALS") {
      return error(401, caught.code, "Incorrect login or password.");
    }
    if (caught.code === "AUTH_CURRENT_PASSWORD_INVALID") {
      return error(400, caught.code, "Your current password is incorrect.");
    }
    return error(
      401,
      caught.code,
      "Your session has expired. Please sign in again.",
      { "set-cookie": clearCookie },
    );
  }
  const requestError = adminRequestErrorResponse(caught);
  if (requestError) return requestError;
  throw caught;
}

export async function handleAdminAuthRequest(
  request: Request,
  env: WorkerEnv,
  service: AdminAuthActions = new AdminAuthService(
    new D1AdminAuthRepository(env.DB),
  ),
): Promise<Response> {
  const allowedOrigin = env.ADMIN_ALLOWED_ORIGIN;
  const isProduction = env.APP_ENV === "production";
  const clearCookie = clearAdminCookie(isProduction);

  const originGuard = guardAdminOrigin(request, allowedOrigin);
  if (originGuard) return originGuard;

  const corsOrigin = resolveAdminCorsOrigin(
    request.headers.get("origin"),
    allowedOrigin,
  );

  const url = new URL(request.url);
  const rawToken = readAdminCookie(request, isProduction);
  let response: Response;

  try {
    if (request.method === "POST" && url.pathname === "/api/admin/auth/login") {
      const input = validateAdminLoginInput(
        await readAdminJson(request, MAX_AUTH_BODY_BYTES),
      );
      if (!input.ok) {
        response = error(
          400,
          "VALIDATION_ERROR",
          input.issues[0]?.message ?? "Check your details.",
        );
      } else {
        const session = await service.login(
          input.value.loginIdentifier,
          input.value.password,
        );
        response = ok(
          {
            admin: session.admin,
            token: session.rawToken,
          },
          200,
          {
            "set-cookie": createAdminCookie(
              session.rawToken,
              session.expiresAtMs,
              Date.now(),
              isProduction,
            ),
          },
        );
      }
    } else if (
      request.method === "GET" &&
      url.pathname === "/api/admin/auth/me"
    ) {
      const required = await service.requireSession(rawToken);
      response = ok({
        admin: required.admin,
        token: rawToken ?? undefined,
      });
    } else if (
      request.method === "POST" &&
      url.pathname === "/api/admin/auth/logout"
    ) {
      await service.logout(rawToken);
      response = ok({ message: "You have been signed out." }, 200, {
        "set-cookie": clearCookie,
      });
    } else if (
      request.method === "POST" &&
      url.pathname === "/api/admin/auth/sessions/revoke-all"
    ) {
      const required = await service.requireSession(rawToken);
      await service.revokeAllSessions(required);
      response = ok({ message: "All sessions have been signed out." }, 200, {
        "set-cookie": clearCookie,
      });
    } else if (
      request.method === "POST" &&
      url.pathname === "/api/admin/auth/change-password"
    ) {
      const required = await service.requireSession(rawToken);
      const input = validateAdminPasswordChangeInput(
        await readAdminJson(request, MAX_AUTH_BODY_BYTES),
      );
      if (!input.ok) {
        response = error(
          400,
          "VALIDATION_ERROR",
          input.issues[0]?.message ?? "Check your details.",
        );
      } else {
        const session = await service.changePassword(
          required,
          input.value.currentPassword,
          input.value.newPassword,
        );
        response = ok(
          {
            admin: session.admin,
            token: session.rawToken,
            message: "Your password has been changed.",
          },
          200,
          {
            "set-cookie": createAdminCookie(
              session.rawToken,
              session.expiresAtMs,
              Date.now(),
              isProduction,
            ),
          },
        );
      }
    } else {
      response = error(
        404,
        "NOT_FOUND",
        "The requested resource was not found.",
      );
    }
  } catch (caught: unknown) {
    response = authErrorResponse(caught, clearCookie);
  }

  return withAdminCors(response, corsOrigin);
}
