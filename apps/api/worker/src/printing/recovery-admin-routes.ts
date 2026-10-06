/* eslint-disable */
import { guardAdminOrigin, withAdminCors } from "../admin/http";
import { readAdminCookie } from "../auth/cookies";
import { D1AdminAuthRepository } from "../auth/repository";
import { AdminAuthService } from "../auth/service";
import type { WorkerEnv } from "../env";
import { error, ok } from "../http";
import { QueueController } from "./queue-controller";
import { RecoveryController } from "./recovery-controller";
import { D1PrintingRepository } from "./repository";

export async function handleAdminPrintSystemRequest(
  request: Request,
  env: WorkerEnv,
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
    return withAdminCors(
      error(401, "UNAUTHORIZED", "Unauthorized"),
      env.ADMIN_ALLOWED_ORIGIN,
    );
  }

  const pathname = new URL(request.url).pathname;
  const printingRepo = new D1PrintingRepository(env.DB);
  const recoveryController = new RecoveryController(printingRepo);
  const queueController = new QueueController(printingRepo);
  const nowMs = Date.now();

  if (
    request.method === "POST" &&
    pathname === "/api/admin/print-system/clear-queue"
  ) {
    try {
      const result = await queueController.clearWaitingQueue(nowMs);
      return withAdminCors(ok(result), env.ADMIN_ALLOWED_ORIGIN);
    } catch (e: any) {
      return withAdminCors(
        error(500, "INTERNAL_ERROR", e.message),
        env.ADMIN_ALLOWED_ORIGIN,
      );
    }
  }

  if (
    request.method === "GET" &&
    pathname === "/api/admin/print-system/status"
  ) {
    try {
      const status = await recoveryController.getSystemStatus(nowMs);
      return withAdminCors(ok(status), env.ADMIN_ALLOWED_ORIGIN);
    } catch (e: any) {
      return withAdminCors(
        error(500, "INTERNAL_ERROR", e.message),
        env.ADMIN_ALLOWED_ORIGIN,
      );
    }
  }

  if (
    request.method === "POST" &&
    pathname === "/api/admin/print-system/recover"
  ) {
    try {
      const result = await recoveryController.executeRecovery(
        session.admin.id,
        nowMs,
      );
      return withAdminCors(ok(result), env.ADMIN_ALLOWED_ORIGIN);
    } catch (e: any) {
      const reason = e.message;
      if (
        [
          "AGENT_OFFLINE",
          "AGENT_STALE",
          "PRINTER_ERROR",
          "PAPER_JAM",
          "PAPER_OUT",
          "PRINTER_OFFLINE",
          "RECOVERY_ALREADY_RUNNING",
          "RECOVERY_REQUIRED",
        ].includes(reason)
      ) {
        return withAdminCors(
          error(400, reason, "Cannot recover: " + reason),
          env.ADMIN_ALLOWED_ORIGIN,
        );
      }
      return withAdminCors(
        error(500, "INTERNAL_ERROR", e.message),
        env.ADMIN_ALLOWED_ORIGIN,
      );
    }
  }

  return withAdminCors(
    error(404, "NOT_FOUND", "Endpoint not found"),
    env.ADMIN_ALLOWED_ORIGIN,
  );
}
