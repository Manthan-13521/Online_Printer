import { validateTogglePrinterInput } from "@printgo/validation";

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
import { D1AgentRepository } from "./repository";
import { AgentError, AgentService } from "./service";

const MAX_JSON_BYTES = 16 * 1024;

export async function handleAdminPrinterRequest(
  request: Request,
  env: WorkerEnv,
  agentService: AgentService = new AgentService(new D1AgentRepository(env.DB)),
  authService: AdminAuthService = new AdminAuthService(
    new D1AdminAuthRepository(env.DB),
  ),
): Promise<Response> {
  const originGuard = guardAdminOrigin(request, env.ADMIN_ALLOWED_ORIGIN);
  if (originGuard) return originGuard;

  const url = new URL(request.url);
  const pathname = url.pathname;
  const isProd = env.APP_ENV === "production";
  const rawCookie = readAdminCookie(request, isProd);

  let session: Awaited<ReturnType<AdminAuthService["requireSession"]>>;
  try {
    session = await authService.requireSession(rawCookie);
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
      error(500, "AUTH_ERROR", "Authentication check failed."),
      env.ADMIN_ALLOWED_ORIGIN,
    );
  }

  try {
    if (
      request.method === "POST" &&
      pathname === "/api/admin/agents/pair-code"
    ) {
      const pairCodeData = await agentService.createPairCode();
      return withAdminCors(ok(pairCodeData, 201), env.ADMIN_ALLOWED_ORIGIN);
    }

    if (request.method === "GET" && pathname === "/api/admin/printers") {
      const agents = await agentService.listAgentsWithPrinters();
      const defaultProductionPrinterId =
        await agentService.getDefaultProductionPrinterId();
      return withAdminCors(
        ok({ agents, defaultProductionPrinterId }, 200),
        env.ADMIN_ALLOWED_ORIGIN,
      );
    }

    const defaultPrinterMatch =
      /^\/api\/admin\/printers\/([^/]+)\/default$/u.exec(pathname);
    if (request.method === "POST" && defaultPrinterMatch) {
      const printerId = decodeURIComponent(defaultPrinterMatch[1] ?? "");
      const result = await agentService.setDefaultProductionPrinter(
        printerId,
        session.admin.id,
      );
      return withAdminCors(
        ok(
          {
            defaultPrinterId: result.printerId,
            windowsPrinterName: result.windowsPrinterName,
          },
          200,
        ),
        env.ADMIN_ALLOWED_ORIGIN,
      );
    }

    const revokeMatch = /^\/api\/admin\/agents\/([^/]+)\/revoke$/u.exec(
      pathname,
    );
    if (request.method === "POST" && revokeMatch) {
      const agentId = decodeURIComponent(revokeMatch[1] ?? "");
      await agentService.revokeAgent(agentId, session.admin.id);
      return withAdminCors(
        ok({ revoked: true }, 200),
        env.ADMIN_ALLOWED_ORIGIN,
      );
    }

    const testPrintMatch =
      /^\/api\/admin\/printers\/([^/]+)\/test-print$/u.exec(pathname);
    if (request.method === "POST" && testPrintMatch) {
      const printerId = decodeURIComponent(testPrintMatch[1] ?? "");
      const testPrint = await agentService.requestTestPrint(
        printerId,
        session.admin.id,
      );
      return withAdminCors(ok({ testPrint }, 201), env.ADMIN_ALLOWED_ORIGIN);
    }

    if (request.method === "GET" && testPrintMatch) {
      const printerId = decodeURIComponent(testPrintMatch[1] ?? "");
      const testPrint = await agentService.getLatestTestPrint(printerId);
      return withAdminCors(ok({ testPrint }, 200), env.ADMIN_ALLOWED_ORIGIN);
    }

    const checkHealthMatch =
      /^\/api\/admin\/printers\/([^/]+)\/check-health$/u.exec(pathname);
    if (request.method === "POST" && checkHealthMatch) {
      const printerId = decodeURIComponent(checkHealthMatch[1] ?? "");
      const result = await agentService.checkPrinterHealth(
        printerId,
        session.admin.id,
      );
      return withAdminCors(ok(result, 200), env.ADMIN_ALLOWED_ORIGIN);
    }

    const printerMatch = /^\/api\/admin\/printers\/([^/]+)$/u.exec(pathname);
    if (request.method === "PUT" && printerMatch) {
      const printerId = decodeURIComponent(printerMatch[1] ?? "");
      const rawBody = await readAdminJson(request, MAX_JSON_BYTES);
      const validation = validateTogglePrinterInput(rawBody);
      if (!validation.ok) {
        return withAdminCors(
          error(
            400,
            "VALIDATION_ERROR",
            validation.issues[0]?.message ?? "Invalid request body.",
          ),
          env.ADMIN_ALLOWED_ORIGIN,
        );
      }
      await agentService.togglePrinter(
        printerId,
        validation.value.enabled,
        session.admin.id,
      );
      return withAdminCors(
        ok({ id: printerId, enabled: validation.value.enabled }, 200),
        env.ADMIN_ALLOWED_ORIGIN,
      );
    }

    const fallbackMatch =
      /^\/api\/admin\/printers\/([^/]+)\/fallback$/u.exec(pathname);
    if (request.method === "PUT" && fallbackMatch) {
      const printerId = decodeURIComponent(fallbackMatch[1] ?? "");
      const rawBody = await readAdminJson(request, MAX_JSON_BYTES);
      if (
        !rawBody ||
        typeof rawBody !== "object" ||
        typeof (rawBody as Record<string, unknown>).autoFallbackEnabled !==
          "boolean"
      ) {
        return withAdminCors(
          error(400, "VALIDATION_ERROR", "Invalid fallback configuration."),
          env.ADMIN_ALLOWED_ORIGIN,
        );
      }
      const body = rawBody as {
        fallbackPrinterId?: string | null;
        autoFallbackEnabled: boolean;
      };
      const result = await agentService.configureFallback(
        printerId,
        body.fallbackPrinterId ?? null,
        body.autoFallbackEnabled,
        session.admin.id,
      );
      return withAdminCors(ok(result, 200), env.ADMIN_ALLOWED_ORIGIN);
    }

    return withAdminCors(
      error(404, "NOT_FOUND", "Endpoint not found."),
      env.ADMIN_ALLOWED_ORIGIN,
    );
  } catch (caught) {
    if (caught instanceof AgentError) {
      if (
        caught.code === "AGENT_NOT_FOUND" ||
        caught.code === "PRINTER_NOT_FOUND"
      ) {
        return withAdminCors(
          error(404, caught.code, "Requested resource not found."),
          env.ADMIN_ALLOWED_ORIGIN,
        );
      }
      if (caught.code === "PRINTER_DISABLED") {
        return withAdminCors(
          error(400, "PRINTER_DISABLED", "Printer is disabled."),
          env.ADMIN_ALLOWED_ORIGIN,
        );
      }
      if (caught.code === "AGENT_OFFLINE") {
        return withAdminCors(
          error(
            400,
            "AGENT_OFFLINE",
            "Agent is offline. Cannot send test print.",
          ),
          env.ADMIN_ALLOWED_ORIGIN,
        );
      }
      if (
        caught.code === "PRINTER_NOT_ELIGIBLE" ||
        caught.code === "CANNOT_ENABLE_VIRTUAL_PRINTER"
      ) {
        return withAdminCors(
          error(
            400,
            caught.code,
            "Virtual or ineligible printers cannot be used for production printing.",
          ),
          env.ADMIN_ALLOWED_ORIGIN,
        );
      }
      if (caught.code === "FALLBACK_SELF_REFERENCE") {
        return withAdminCors(
          error(
            400,
            caught.code,
            "A printer cannot be its own fallback.",
          ),
          env.ADMIN_ALLOWED_ORIGIN,
        );
      }
      if (caught.code === "FALLBACK_PRINTER_NOT_FOUND") {
        return withAdminCors(
          error(
            404,
            caught.code,
            "The selected fallback printer was not found.",
          ),
          env.ADMIN_ALLOWED_ORIGIN,
        );
      }
      if (caught.code === "FALLBACK_LOOP_DETECTED") {
        return withAdminCors(
          error(
            400,
            caught.code,
            "This would create a circular fallback loop.",
          ),
          env.ADMIN_ALLOWED_ORIGIN,
        );
      }
    }
    const requestError = adminRequestErrorResponse(caught);
    if (requestError) {
      return withAdminCors(requestError, env.ADMIN_ALLOWED_ORIGIN);
    }
    return withAdminCors(
      error(500, "ADMIN_REQUEST_FAILED", "Could not complete admin action."),
      env.ADMIN_ALLOWED_ORIGIN,
    );
  }
}
