import { guardAdminOrigin, withAdminCors } from "../admin/http";
import { clearAdminCookie, readAdminCookie } from "../auth/cookies";
import { D1AdminAuthRepository } from "../auth/repository";
import { AdminAuthService, AuthError } from "../auth/service";
import type { WorkerEnv } from "../env";
import { error, ok } from "../http";
import { D1RetentionRepository } from "./repository";
import { RetentionService } from "./service";

export async function handleAdminRetentionRequest(
  request: Request,
  env: WorkerEnv,
  retentionService?: RetentionService,
  authService?: AdminAuthService,
): Promise<Response> {
  const originGuard = guardAdminOrigin(request, env.ADMIN_ALLOWED_ORIGIN);
  if (originGuard) return originGuard;

  const isProd = env.APP_ENV === "production";
  const rawCookie = readAdminCookie(request, isProd);
  const auth =
    authService ?? new AdminAuthService(new D1AdminAuthRepository(env.DB));

  try {
    await auth.requireSession(rawCookie);
  } catch (caught) {
    if (caught instanceof AuthError) {
      return withAdminCors(
        error(
          401,
          caught.code,
          "Your session has expired. Please sign in again.",
          { "set-cookie": clearAdminCookie(isProd) },
        ),
        env.ADMIN_ALLOWED_ORIGIN,
      );
    }
    return withAdminCors(
      error(401, "UNAUTHORIZED", "Valid admin session required."),
      env.ADMIN_ALLOWED_ORIGIN,
    );
  }

  const service =
    retentionService ??
    new RetentionService(
      new D1RetentionRepository(env.DB),
      env.PDF_BUCKET,
      () => Date.now(),
    );

  const url = new URL(request.url);

  if (
    url.pathname === "/api/admin/retention/stats" &&
    request.method === "GET"
  ) {
    const stats = await service.getStats();
    return withAdminCors(ok(stats), env.ADMIN_ALLOWED_ORIGIN);
  }

  if (
    url.pathname === "/api/admin/retention/cleanup" &&
    request.method === "POST"
  ) {
    return withAdminCors(
      error(
        410,
        "RETENTION_CLEANUP_REPLACED",
        "Use the resumable Storage & Privacy cleanup controls.",
      ),
      env.ADMIN_ALLOWED_ORIGIN,
    );
  }

  return withAdminCors(
    error(404, "NOT_FOUND", "The requested resource was not found."),
    env.ADMIN_ALLOWED_ORIGIN,
  );
}
