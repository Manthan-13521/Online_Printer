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
            `SELECT 
               COALESCE(
                 (SELECT created_count FROM daily_order_stats WHERE date_key = ?),
                 (SELECT COUNT(*) FROM orders WHERE strftime('%Y-%m-%d', datetime(created_at_ms / 1000 + 19800, 'unixepoch')) = ?)
               ) as created_count,
               COALESCE(
                 (
                   SELECT SUM(amount_paise) FROM (
                     SELECT p.amount_paise
                     FROM payments p
                     WHERE p.status = 'PAID'
                       AND strftime('%Y-%m-%d', datetime(p.verified_at_ms / 1000 + 19800, 'unixepoch')) = ?
                     UNION ALL
                     SELECT o.total_amount_paise AS amount_paise
                     FROM orders o
                     WHERE o.payment_method = 'CASH'
                       AND o.status NOT IN ('CANCELLED', 'DRAFT')
                       AND strftime('%Y-%m-%d', datetime(COALESCE(o.cash_confirmed_at_ms, o.paid_at_ms, o.created_at_ms) / 1000 + 19800, 'unixepoch')) = ?
                       AND NOT EXISTS (
                         SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.status = 'PAID'
                       )
                   )
                 ),
                 (SELECT earnings_paise FROM daily_order_stats WHERE date_key = ?),
                 0
               ) as earnings_paise`,
          ).bind(dateKey, dateKey, dateKey, dateKey, dateKey),
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
