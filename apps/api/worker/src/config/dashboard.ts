import type { WorkerEnv } from "../env";
import { error, ok } from "../http";
import { guardAdminOrigin, withAdminCors } from "../admin/http";
import { readAdminCookie } from "../auth/cookies";
import { AdminAuthService, AuthError } from "../auth/service";
import { D1AdminAuthRepository } from "../auth/repository";
import { D1ConfigurationRepository } from "./repository";
import { D1AgentRepository } from "../agent/repository";

export async function handleDashboard(
  request: Request,
  env: WorkerEnv,
): Promise<Response> {
  const guard = guardAdminOrigin(request, env.ADMIN_ALLOWED_ORIGIN);
  if (guard) return guard;
  let response: Response;
  try {
    await new AdminAuthService(
      new D1AdminAuthRepository(env.DB),
    ).requireSession(readAdminCookie(request, env.APP_ENV === "production"));
    if (request.method !== "GET")
      return withAdminCors(
        error(405, "METHOD_NOT_ALLOWED", "Use GET."),
        env.ADMIN_ALLOWED_ORIGIN,
      );
    const now = Date.now();
    // Shop business date is India Standard Time, consistent with customer INR flow.
    const midnight =
      Math.floor((now + 19_800_000) / 86_400_000) * 86_400_000 - 19_800_000;
    const dateKey = new Date(now + 19_800_000).toISOString().slice(0, 10);
    const agentsRepo = new D1AgentRepository(env.DB);
    const [settings, agents, defaultProductionPrinterId, counts] =
      await Promise.all([
        new D1ConfigurationRepository(env.DB).getSettings(),
        agentsRepo.listAgentsWithPrinters(now),
        agentsRepo.getDefaultProductionPrinterId(),
        env.DB.batch<{ n: number }>([
          env.DB.prepare(
            "SELECT COUNT(*) n FROM orders WHERE status IN ('QUEUED','CLAIMED','PRINTING','SPOOLING')",
          ),
          env.DB.prepare(
            "SELECT COUNT(*) n FROM orders WHERE status IN ('ADMIN_ACTION_REQUIRED','PRINT_BLOCKED')",
          ),
          env.DB.prepare(
            `SELECT MAX(
              COALESCE((SELECT completed_count FROM daily_order_stats WHERE date_key = ?), 0),
              COALESCE((SELECT COUNT(*) FROM orders WHERE status = 'COMPLETED' AND completed_at_ms >= ? AND completed_at_ms < ?), 0)
            ) AS n`,
          ).bind(dateKey, midnight, midnight + 86_400_000),
        ]),
      ]);
    response = ok(
      {
        settings,
        agents,
        defaultProductionPrinterId,
        queue: counts[0]?.results[0]?.n ?? 0,
        attention: counts[1]?.results[0]?.n ?? 0,
        completedToday: counts[2]?.results[0]?.n ?? 0,
      },
      200,
      { "Cache-Control": "no-store" },
    );
  } catch (caught) {
    response =
      caught instanceof AuthError
        ? error(
            401,
            caught.code,
            "Your session has expired. Please sign in again.",
          )
        : error(500, "DASHBOARD_FAILED", "Shop status could not be loaded.");
  }
  return withAdminCors(response, env.ADMIN_ALLOWED_ORIGIN);
}
