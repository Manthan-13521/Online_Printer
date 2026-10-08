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
    const dateKey = new Date(now + 19_800_000).toISOString().slice(0, 10);
    const agentsRepo = new D1AgentRepository(env.DB);
    const [settings, agents, defaultProductionPrinterId, counts] =
      await Promise.all([
        new D1ConfigurationRepository(env.DB).getSettings(),
        agentsRepo.listAgentsWithPrinters(now),
        agentsRepo.getDefaultProductionPrinterId(),
        env.DB.batch([
          env.DB.prepare(
            "SELECT created_count, earnings_paise FROM daily_order_stats WHERE date_key = ?",
          ).bind(dateKey),
          env.DB.prepare(
            `SELECT status, COUNT(*) as count 
             FROM orders 
             WHERE status IN ('QUEUED', 'CLAIMED', 'SPOOLING', 'PRINTING', 'PRINTED', 'AWAITING_FINISHING', 'ADMIN_ACTION_REQUIRED', 'PRINT_BLOCKED', 'NEEDS_ADMIN', 'COMPLETION_UNKNOWN', 'RETRY_PENDING')
             GROUP BY status`,
          ),
        ]),
      ]);

    const dailyStats = counts[0]?.results[0] as
      { created_count: number; earnings_paise: number } | undefined;
    const statusRows = counts[1]?.results as
      { status: string; count: number }[] | undefined;

    let waiting = 0;
    let printing = 0;
    let readyForPickup = 0;
    let needsAttention = 0;

    if (statusRows) {
      for (const row of statusRows) {
        if (["QUEUED", "CLAIMED"].includes(row.status)) {
          waiting += row.count;
        } else if (["SPOOLING", "PRINTING"].includes(row.status)) {
          printing += row.count;
        } else if (["PRINTED", "AWAITING_FINISHING"].includes(row.status)) {
          readyForPickup += row.count;
        } else {
          needsAttention += row.count;
        }
      }
    }

    response = ok(
      {
        settings,
        agents,
        defaultProductionPrinterId,
        todaysEarningsPaise: dailyStats?.earnings_paise ?? 0,
        todaysOrders: dailyStats?.created_count ?? 0,
        inQueue: waiting,
        printingNow: printing,
        statusCounts: {
          waiting,
          printing,
          readyForPickup,
          needsAttention,
        },
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
