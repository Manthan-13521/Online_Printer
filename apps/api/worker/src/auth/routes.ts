import {
  validateAdminLoginInput,
  validateAdminPasswordChangeInput,
} from "@printgo/validation";

import type { WorkerEnv } from "../env";
import { error, ok } from "../http";
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

function corsHeaders(origin: string): Record<string, string> {
  return {
    "access-control-allow-credentials": "true",
    "access-control-allow-origin": origin,
    vary: "Origin",
  };
}

function withCors(response: Response, origin: string): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(corsHeaders(origin))) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function readJson(request: Request): Promise<unknown> {
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  ) {
    throw new Error("UNSUPPORTED_CONTENT_TYPE");
  }
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_AUTH_BODY_BYTES) throw new Error("BODY_TOO_LARGE");
  const text = await request.text();
  if (text.length > MAX_AUTH_BODY_BYTES) throw new Error("BODY_TOO_LARGE");
  return JSON.parse(text) as unknown;
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
  if (caught instanceof SyntaxError) {
    return error(400, "VALIDATION_ERROR", "The request could not be read.");
  }
  if (
    caught instanceof Error &&
    caught.message === "UNSUPPORTED_CONTENT_TYPE"
  ) {
    return error(415, "UNSUPPORTED_CONTENT_TYPE", "Send a JSON request.");
  }
  if (caught instanceof Error && caught.message === "BODY_TOO_LARGE") {
    return error(413, "REQUEST_TOO_LARGE", "The request is too large.");
  }
  throw caught;
}

export async function handleAdminAuthRequest(
  request: Request,
  env: WorkerEnv,
  service: AdminAuthActions = new AdminAuthService(
    new D1AdminAuthRepository(env.DB),
  ),
): Promise<Response> {
  const origin = request.headers.get("origin");
  const allowedOrigin = env.ADMIN_ALLOWED_ORIGIN;
  const isProduction = env.APP_ENV === "production";
  const clearCookie = clearAdminCookie(isProduction);

  if (request.method === "OPTIONS") {
    if (origin !== allowedOrigin) {
      return error(403, "ORIGIN_NOT_ALLOWED", "This request is not allowed.");
    }
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders(allowedOrigin),
        "access-control-allow-headers": "Content-Type",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-max-age": "600",
      },
    });
  }

  if (origin && origin !== allowedOrigin) {
    return error(403, "ORIGIN_NOT_ALLOWED", "This request is not allowed.");
  }
  if (request.method === "POST" && origin !== allowedOrigin) {
    return error(403, "ORIGIN_REQUIRED", "This request is not allowed.");
  }

  const url = new URL(request.url);
  const rawToken = readAdminCookie(request, isProduction);
  let response: Response;

  try {
    if (request.method === "POST" && url.pathname === "/api/admin/auth/login") {
      const input = validateAdminLoginInput(await readJson(request));
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
        response = ok({ admin: session.admin }, 200, {
          "set-cookie": createAdminCookie(
            session.rawToken,
            session.expiresAtMs,
            Date.now(),
            isProduction,
          ),
        });
      }
    } else if (
      request.method === "GET" &&
      url.pathname === "/api/admin/auth/me"
    ) {
      const required = await service.requireSession(rawToken);
      response = ok({ admin: required.admin });
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
      const input = validateAdminPasswordChangeInput(await readJson(request));
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

  return withCors(response, allowedOrigin);
}
