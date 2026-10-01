import type { CleanupScope } from "@printgo/api-contract";

import {
  adminRequestErrorResponse,
  guardAdminOrigin,
  readAdminJson,
  withAdminCors,
} from "../admin/http";
import { clearAdminCookie, readAdminCookie } from "../auth/cookies";
import { D1AdminAuthRepository } from "../auth/repository";
import { AdminAuthService, AuthError } from "../auth/service";
import type { WorkerEnv } from "../env";
import { error, ok } from "../http";
import { D1CleanupRepository } from "./repository";
import { CleanupRequestError, CleanupService } from "./service";

const MAX_JSON_BYTES = 4 * 1024;
const ADMIN_SCOPES: CleanupScope[] = ["ALL_COMPLETED", "ALL_PRINT_DATA"];

function isAdminScope(value: string | null): value is CleanupScope {
  return value !== null && ADMIN_SCOPES.includes(value as CleanupScope);
}

export async function handleAdminCleanupRequest(
  request: Request,
  env: WorkerEnv,
  injectedService?: CleanupService,
  injectedAuth?: AdminAuthService,
): Promise<Response> {
  const originGuard = guardAdminOrigin(request, env.ADMIN_ALLOWED_ORIGIN);
  if (originGuard) return withAdminCors(originGuard, env.ADMIN_ALLOWED_ORIGIN);

  const isProd = env.APP_ENV === "production";
  const auth =
    injectedAuth ?? new AdminAuthService(new D1AdminAuthRepository(env.DB));
  let session;
  try {
    session = await auth.requireSession(readAdminCookie(request, isProd));
  } catch (caught) {
    const response =
      caught instanceof AuthError
        ? error(
            401,
            caught.code,
            "Your session has expired. Please sign in again.",
            {
              "set-cookie": clearAdminCookie(isProd),
            },
          )
        : error(401, "UNAUTHORIZED", "Valid admin session required.");
    return withAdminCors(response, env.ADMIN_ALLOWED_ORIGIN);
  }

  const service =
    injectedService ??
    new CleanupService(new D1CleanupRepository(env.DB), env.PDF_BUCKET);
  const url = new URL(request.url);

  try {
    if (
      url.pathname === "/api/admin/cleanup/preview" &&
      request.method === "GET"
    ) {
      const scope = url.searchParams.get("scope");
      if (!isAdminScope(scope)) {
        return withAdminCors(
          error(400, "VALIDATION_ERROR", "Choose a supported cleanup scope."),
          env.ADMIN_ALLOWED_ORIGIN,
        );
      }
      return withAdminCors(
        ok(await service.preview(scope)),
        env.ADMIN_ALLOWED_ORIGIN,
      );
    }

    if (
      url.pathname === "/api/admin/cleanup/runs" &&
      request.method === "POST"
    ) {
      const body = (await readAdminJson(request, MAX_JSON_BYTES)) as {
        scope?: unknown;
        confirmation?: unknown;
      };
      if (
        typeof body !== "object" ||
        !body ||
        typeof body.scope !== "string" ||
        !isAdminScope(body.scope) ||
        typeof body.confirmation !== "string"
      ) {
        return withAdminCors(
          error(
            400,
            "VALIDATION_ERROR",
            "Cleanup scope and confirmation are required.",
          ),
          env.ADMIN_ALLOWED_ORIGIN,
        );
      }
      const run = await service.requestAdminRun(
        body.scope,
        session.admin.id,
        body.confirmation,
      );
      return withAdminCors(ok(run), env.ADMIN_ALLOWED_ORIGIN);
    }

    const match = /^\/api\/admin\/cleanup\/runs\/([0-9a-f-]{36})$/i.exec(
      url.pathname,
    );
    if (match && request.method === "GET") {
      return withAdminCors(
        ok(await service.getRun(match[1]!)),
        env.ADMIN_ALLOWED_ORIGIN,
      );
    }
  } catch (caught) {
    const requestError = adminRequestErrorResponse(caught);
    if (requestError)
      return withAdminCors(requestError, env.ADMIN_ALLOWED_ORIGIN);
    if (caught instanceof CleanupRequestError) {
      const notFound = caught.code === "CLEANUP_RUN_NOT_FOUND";
      return withAdminCors(
        error(
          notFound ? 404 : 400,
          caught.code,
          notFound
            ? "Cleanup run not found."
            : "The cleanup request could not be confirmed.",
        ),
        env.ADMIN_ALLOWED_ORIGIN,
      );
    }
    throw caught;
  }

  return withAdminCors(
    error(404, "NOT_FOUND", "The requested resource was not found."),
    env.ADMIN_ALLOWED_ORIGIN,
  );
}
