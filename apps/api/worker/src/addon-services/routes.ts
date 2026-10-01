import type {
  AdminAddonServiceRequest,
  AdminManualOrder,
  HandlingMode,
  OrderAddonServiceSnapshot,
  PricingType,
} from "@printgo/api-contract";
import { isIntegerPaise } from "@printgo/validation";

import {
  adminRequestErrorResponse,
  guardAdminOrigin,
  readAdminJson,
  withAdminCors,
} from "../admin/http";
import { readAdminCookie, clearAdminCookie } from "../auth/cookies";
import { D1AdminAuthRepository } from "../auth/repository";
import { AdminAuthService, AuthError } from "../auth/service";
import type { WorkerEnv } from "../env";
import { error, ok } from "../http";
import { AddonServiceError, D1AddonServiceRepository } from "./repository";

const MAX_BODY_BYTES = 16 * 1024;

const VALID_PRICING_TYPES = new Set<string>(["FIXED_PRICE", "STAFF_PRICED"]);
const VALID_HANDLING_MODES = new Set<string>([
  "AUTO",
  "POST_PRINT",
  "MANUAL_PRINT",
]);

function validateAddonServiceRequest(
  body: unknown,
):
  | { ok: true; value: AdminAddonServiceRequest }
  | { ok: false; message: string } {
  if (typeof body !== "object" || body === null) {
    return { ok: false, message: "Invalid request body." };
  }
  const record = body as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!name || name.length > 100) {
    return { ok: false, message: "Name is required (max 100 characters)." };
  }
  if (!VALID_PRICING_TYPES.has(record.pricingType as string)) {
    return {
      ok: false,
      message: "Pricing type must be FIXED_PRICE or STAFF_PRICED.",
    };
  }
  const pricingType = record.pricingType as PricingType;
  const fixedPricePaise =
    pricingType === "FIXED_PRICE" ? (record.fixedPricePaise as number) : 0;
  if (pricingType === "FIXED_PRICE" && !isIntegerPaise(fixedPricePaise)) {
    return {
      ok: false,
      message: "Fixed price must be a non-negative integer (paise).",
    };
  }
  if (!VALID_HANDLING_MODES.has(record.handlingMode as string)) {
    return {
      ok: false,
      message: "Handling mode must be AUTO, POST_PRINT, or MANUAL_PRINT.",
    };
  }
  if (typeof record.enabled !== "boolean") {
    return { ok: false, message: "Enabled must be true or false." };
  }
  if (
    !Number.isSafeInteger(record.displayOrder) ||
    (record.displayOrder as number) < 0
  ) {
    return {
      ok: false,
      message: "Display order must be a non-negative integer.",
    };
  }
  return {
    ok: true,
    value: {
      name,
      pricingType,
      fixedPricePaise,
      handlingMode: record.handlingMode as HandlingMode,
      enabled: record.enabled,
      displayOrder: record.displayOrder as number,
    },
  };
}

function addonServiceError(caught: unknown): Response | null {
  if (caught instanceof AddonServiceError) {
    return error(404, caught.code, caught.message);
  }
  return null;
}

export async function handleAdminAddonServicesRequest(
  request: Request,
  env: WorkerEnv,
): Promise<Response> {
  const allowedOrigin = env.ADMIN_ALLOWED_ORIGIN;
  const isProduction = env.APP_ENV === "production";
  const originGuard = guardAdminOrigin(request, allowedOrigin);
  if (originGuard) return originGuard;

  const rawToken = readAdminCookie(request, isProduction);
  const url = new URL(request.url);
  const repo = new D1AddonServiceRepository(env.DB);
  const sessions = new AdminAuthService(new D1AdminAuthRepository(env.DB));

  let response: Response;
  try {
    await sessions.requireSession(rawToken);

    const idMatch = url.pathname.match(
      /^\/api\/admin\/addon-services\/([^/]+)(?:\/([^/]+))?$/,
    );
    const serviceId = idMatch?.[1];
    const action = idMatch?.[2];

    if (
      request.method === "GET" &&
      url.pathname === "/api/admin/addon-services"
    ) {
      // GET /api/admin/addon-services
      const services = await repo.listServices();
      response = ok({ addonServices: services });
    } else if (
      request.method === "POST" &&
      url.pathname === "/api/admin/addon-services"
    ) {
      // POST /api/admin/addon-services — create
      const body = await readAdminJson(request, MAX_BODY_BYTES);
      const validated = validateAddonServiceRequest(body);
      if (!validated.ok) {
        response = error(400, "VALIDATION_ERROR", validated.message);
      } else {
        const service = await repo.createService(validated.value);
        response = ok({ addonService: service });
      }
    } else if (request.method === "PUT" && serviceId && !action) {
      // PUT /api/admin/addon-services/:id — update
      const body = await readAdminJson(request, MAX_BODY_BYTES);
      const validated = validateAddonServiceRequest(body);
      if (!validated.ok) {
        response = error(400, "VALIDATION_ERROR", validated.message);
      } else {
        const service = await repo.updateService(serviceId, validated.value);
        if (!service) {
          response = error(404, "NOT_FOUND", "Add-on service not found.");
        } else {
          response = ok({ addonService: service });
        }
      }
    } else if (request.method === "DELETE" && serviceId && !action) {
      // DELETE /api/admin/addon-services/:id
      const deleted = await repo.deleteService(serviceId);
      if (!deleted) {
        response = error(404, "NOT_FOUND", "Add-on service not found.");
      } else {
        response = ok({ deleted: true });
      }
    } else if (request.method === "POST" && serviceId && action === "toggle") {
      // POST /api/admin/addon-services/:id/toggle
      const body = await readAdminJson(request, MAX_BODY_BYTES);
      const rec = body as Record<string, unknown>;
      if (typeof rec.enabled !== "boolean") {
        response = error(
          400,
          "VALIDATION_ERROR",
          "enabled must be true or false.",
        );
      } else {
        const service = await repo.toggleService(serviceId, rec.enabled);
        if (!service) {
          response = error(404, "NOT_FOUND", "Add-on service not found.");
        } else {
          response = ok({ addonService: service });
        }
      }
    } else {
      response = error(
        404,
        "NOT_FOUND",
        "The requested resource was not found.",
      );
    }
  } catch (caught: unknown) {
    if (caught instanceof AuthError) {
      response = error(
        401,
        caught.code,
        "Your session has expired. Please sign in again.",
        { "set-cookie": clearAdminCookie(isProduction) },
      );
    } else {
      const svcError = addonServiceError(caught);
      const reqError = adminRequestErrorResponse(caught);
      response =
        svcError ??
        reqError ??
        (() => {
          throw caught;
        })();
    }
  }
  return withAdminCors(response, allowedOrigin);
}

export async function handleAdminManualOrdersRequest(
  request: Request,
  env: WorkerEnv,
): Promise<Response> {
  const allowedOrigin = env.ADMIN_ALLOWED_ORIGIN;
  const isProduction = env.APP_ENV === "production";
  const originGuard = guardAdminOrigin(request, allowedOrigin);
  if (originGuard) return originGuard;

  const rawToken = readAdminCookie(request, isProduction);
  const url = new URL(request.url);
  const db = env.DB;
  const sessions = new AdminAuthService(new D1AdminAuthRepository(db));
  const addonRepo = new D1AddonServiceRepository(db);

  let response: Response;
  try {
    await sessions.requireSession(rawToken);

    // GET /api/admin/orders/manual
    if (
      request.method === "GET" &&
      url.pathname === "/api/admin/orders/manual"
    ) {
      interface ManualOrderRow {
        id: string;
        public_job_code: string;
        pickup_code: string | null;
        is_priority: number;
        identification_required: number;
        customer_name: string;
        customer_phone: string;
        status: string;
        instructions: string | null;
        total_amount_paise: number;
        due_at_pickup_paise: number;
        paid_at_ms: number;
        file_count: number;
      }
      const result = await db
        .prepare(
          `SELECT o.id, o.public_job_code, o.pickup_code, o.is_priority, o.identification_required,
                  o.customer_name, o.customer_phone,
                  o.status, o.instructions, o.total_amount_paise, o.due_at_pickup_paise,
                  o.paid_at_ms,
                  (SELECT COUNT(*) FROM order_files f WHERE f.order_id = o.id) file_count
           FROM orders o
           WHERE o.status IN ('MANUAL_PRINT', 'AWAITING_FINISHING')
             AND o.cleanup_state = 'ACTIVE'
           ORDER BY o.paid_at_ms`,
        )
        .all<ManualOrderRow>();

      const orderIds = result.results.map((r) => r.id);
      const snapshotsMap = await addonRepo.getOrderSnapshotsBatch(orderIds);

      const orders: AdminManualOrder[] = result.results.map((row) => {
        const snapshots: OrderAddonServiceSnapshot[] =
          snapshotsMap.get(row.id) ?? [];
        const hasStaffPriced = snapshots.some(
          (s) => s.pricingType === "STAFF_PRICED",
        );
        const hasPostPrint = snapshots.some(
          (s) => s.handlingMode === "POST_PRINT",
        );
        return {
          orderId: row.id,
          jobCode: row.public_job_code,
          pickupCode: row.pickup_code,
          isPriority: row.is_priority === 1,
          identificationRequired: row.identification_required === 1,
          customerName: row.customer_name,
          customerPhone: row.customer_phone,
          status: row.status,
          instructions: row.instructions,
          fileCount: row.file_count,
          onlineAmountPaise: row.total_amount_paise,
          dueAtPickupPaise: row.due_at_pickup_paise,
          currency: "INR" as const,
          paidAt: new Date(row.paid_at_ms).toISOString(),
          addonServices: snapshots,
          hasStaffPriced,
          hasPostPrint,
        };
      });

      response = ok({ orders });
    } else if (
      request.method === "POST" &&
      url.pathname.startsWith("/api/admin/orders/")
    ) {
      // Extract order ID and sub-action
      const match = url.pathname.match(
        /^\/api\/admin\/orders\/([^/]+)\/([^/]+)$/,
      );
      if (!match) {
        response = error(404, "NOT_FOUND", "Not found.");
      } else {
        const orderId = match[1]!;
        const action = match[2]!;
        const nowMs = Date.now();

        if (action === "mark-printed") {
          // MANUAL_PRINT → AWAITING_FINISHING (if any POST_PRINT addon) or → COMPLETED
          const snapshots = await addonRepo.getOrderSnapshots(orderId);
          const hasPostPrint = snapshots.some(
            (s) => s.handlingMode === "POST_PRINT",
          );
          const nextStatus = hasPostPrint ? "AWAITING_FINISHING" : "COMPLETED";
          const completedAt = hasPostPrint ? null : nowMs;

          const result = await db
            .prepare(
              `UPDATE orders
               SET status = ?, updated_at_ms = ?,
                   completed_at_ms = COALESCE(completed_at_ms, ?)
               WHERE id = ? AND status = 'MANUAL_PRINT' AND cleanup_state = 'ACTIVE'`,
            )
            .bind(nextStatus, nowMs, completedAt, orderId)
            .run();

          if (result.meta.changes === 0) {
            response = error(
              409,
              "INVALID_TRANSITION",
              "Order is not in MANUAL_PRINT status.",
            );
          } else {
            response = ok({ orderId, status: nextStatus });
          }
        } else if (action === "mark-finished") {
          // AWAITING_FINISHING → COMPLETED
          const result = await db
            .prepare(
              `UPDATE orders
               SET status = 'COMPLETED', completed_at_ms = ?, updated_at_ms = ?
               WHERE id = ? AND status = 'AWAITING_FINISHING' AND cleanup_state = 'ACTIVE'`,
            )
            .bind(nowMs, nowMs, orderId)
            .run();

          if (result.meta.changes === 0) {
            response = error(
              409,
              "INVALID_TRANSITION",
              "Order is not in AWAITING_FINISHING status.",
            );
          } else {
            response = ok({ orderId, status: "COMPLETED" });
          }
        } else if (action === "set-pickup-charge") {
          // Set staff-priced pickup amount — server-side validated
          const body = await readAdminJson(request, MAX_BODY_BYTES);
          const rec = body as Record<string, unknown>;
          if (!isIntegerPaise(rec.dueAtPickupPaise)) {
            response = error(
              400,
              "VALIDATION_ERROR",
              "dueAtPickupPaise must be a non-negative integer.",
            );
          } else {
            await addonRepo.setPickupCharge(
              orderId,
              rec.dueAtPickupPaise,
              nowMs,
            );
            response = ok({ orderId, dueAtPickupPaise: rec.dueAtPickupPaise });
          }
        } else {
          response = error(404, "NOT_FOUND", "Not found.");
        }
      }
    } else {
      response = error(404, "NOT_FOUND", "Not found.");
    }
  } catch (caught: unknown) {
    if (caught instanceof AuthError) {
      response = error(
        401,
        caught.code,
        "Your session has expired. Please sign in again.",
        { "set-cookie": clearAdminCookie(isProduction) },
      );
    } else {
      const reqError = adminRequestErrorResponse(caught);
      response =
        reqError ??
        (() => {
          throw caught;
        })();
    }
  }
  return withAdminCors(response, allowedOrigin);
}
