import {
  FAILED_OR_CANCELLED_PAYMENT_RETENTION_MS,
  WEBHOOK_PROCESSING_STALE_TIMEOUT_MS,
} from "@printgo/domain";

import type { WorkerEnv } from "../env";
import { error, ok } from "../http";
import { D1CustomerRepository } from "../customer/repository";
import { R2PrivateObjectStore } from "../storage/r2-verification";
import { D1TrackingRepository } from "../tracking/repository";
import { TrackingService } from "../tracking/service";
import { D1PaymentRepository, type PaymentRepository } from "./repository";
import { D1PaymentReadiness } from "./readiness";
import {
  HttpRazorpayClient,
  verifyHmacSha256Hex,
  type RazorpayPayment,
} from "./razorpay";
import { PaymentService } from "./service";

const MAX_WEBHOOK_BYTES = 128 * 1024;
const NO_STORE = { "Cache-Control": "no-store" } as const;

export interface WebhookDependencies {
  payments: PaymentRepository;
  acceptCaptured(
    payment: NonNullable<
      Awaited<ReturnType<PaymentRepository["findPaymentByProviderOrderId"]>>
    >,
    providerPayment: RazorpayPayment,
  ): ReturnType<PaymentService["acceptCapturedWebhook"]>;
  now(): number;
}

function dependenciesFromEnv(env: WorkerEnv): WebhookDependencies {
  const payments = new D1PaymentRepository(env.DB);
  const customer = new D1CustomerRepository(env.DB);
  const keyId = env.RAZORPAY_KEY_ID ?? "";
  const keySecret = env.RAZORPAY_KEY_SECRET ?? "";
  const service = new PaymentService(
    payments,
    customer,
    new R2PrivateObjectStore(env.PDF_BUCKET),
    new D1PaymentReadiness(env.DB, env),
    new HttpRazorpayClient(keyId, keySecret),
    { keyId, keySecret },
    new TrackingService(new D1TrackingRepository(env.DB)),
  );
  return {
    payments,
    acceptCaptured: (payment, providerPayment) =>
      service.acceptCapturedWebhook(payment, providerPayment),
    now: Date.now,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePaymentEntity(
  body: Record<string, unknown>,
): RazorpayPayment | null {
  const payload = body.payload;
  if (!isRecord(payload) || !isRecord(payload.payment)) return null;
  const entity = payload.payment.entity;
  if (!isRecord(entity)) return null;
  if (
    typeof entity.id !== "string" ||
    typeof entity.order_id !== "string" ||
    !Number.isSafeInteger(entity.amount) ||
    entity.currency !== "INR" ||
    typeof entity.status !== "string"
  ) {
    return null;
  }
  return {
    id: entity.id,
    orderId: entity.order_id,
    amount: entity.amount as number,
    currency: "INR",
    status: entity.status,
  };
}

export async function handleRazorpayWebhook(
  request: Request,
  env: WorkerEnv,
  dependencies: WebhookDependencies = dependenciesFromEnv(env),
): Promise<Response> {
  if (request.method !== "POST") {
    return error(405, "METHOD_NOT_ALLOWED", "Method not allowed.", NO_STORE);
  }
  if (!env.RAZORPAY_WEBHOOK_SECRET) {
    return error(
      503,
      "PAYMENT_CONFIGURATION_MISSING",
      "Payment webhook is not configured.",
      NO_STORE,
    );
  }
  const contentLength = Number(request.headers.get("Content-Length") ?? 0);
  if (contentLength > MAX_WEBHOOK_BYTES) {
    return error(413, "BODY_TOO_LARGE", "Webhook body is too large.", NO_STORE);
  }
  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > MAX_WEBHOOK_BYTES) {
    return error(413, "BODY_TOO_LARGE", "Webhook body is too large.", NO_STORE);
  }
  const signature = request.headers.get("x-razorpay-signature") ?? "";
  if (
    !(await verifyHmacSha256Hex(
      rawBody,
      signature,
      env.RAZORPAY_WEBHOOK_SECRET,
    ))
  ) {
    return error(
      400,
      "WEBHOOK_SIGNATURE_INVALID",
      "Webhook signature is invalid.",
      NO_STORE,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return error(400, "INVALID_JSON", "Webhook body is invalid.", NO_STORE);
  }
  if (!isRecord(parsed) || typeof parsed.event !== "string") {
    return error(
      400,
      "WEBHOOK_INVALID",
      "Webhook payload is invalid.",
      NO_STORE,
    );
  }
  const providerEventId = request.headers.get("x-razorpay-event-id");
  if (!providerEventId || providerEventId.length > 200) {
    return error(
      400,
      "WEBHOOK_EVENT_ID_REQUIRED",
      "Webhook event id is required.",
      NO_STORE,
    );
  }
  const nowMs = dependencies.now();
  const claimed = await dependencies.payments.claimProviderEvent({
    id: crypto.randomUUID(),
    providerEventId,
    eventType: parsed.event,
    nowMs,
    staleTimeoutMs: WEBHOOK_PROCESSING_STALE_TIMEOUT_MS,
  });
  if (!claimed) return ok({ received: true, duplicate: true }, 200, NO_STORE);

  let paymentId: string | undefined;
  let orderId: string | undefined;
  try {
    if (
      !["payment.captured", "order.paid", "payment.failed"].includes(
        parsed.event,
      )
    ) {
      await dependencies.payments.finishProviderEvent({
        providerEventId,
        status: "IGNORED",
        nowMs: dependencies.now(),
      });
      return ok({ received: true, ignored: true }, 200, NO_STORE);
    }
    const entity = parsePaymentEntity(parsed);
    if (!entity) throw new Error("Webhook payment entity is invalid.");
    const payment = await dependencies.payments.findPaymentByProviderOrderId(
      entity.orderId,
    );
    if (!payment) {
      const retained =
        await dependencies.payments.findRetainedPaymentByProviderOrderId(
          entity.orderId,
        );
      if (
        !retained ||
        !["PAID", "REFUNDED"].includes(retained.status) ||
        retained.amountPaise !== entity.amount ||
        retained.currency !== entity.currency ||
        (retained.providerPaymentId !== null &&
          retained.providerPaymentId !== entity.id)
      ) {
        throw new Error("Webhook payment order is unknown.");
      }
      await dependencies.payments.finishProviderEvent({
        providerEventId,
        status: "PROCESSED",
        nowMs: dependencies.now(),
      });
      return ok({ received: true, duplicate: true }, 200, NO_STORE);
    }
    paymentId = payment.id;
    orderId = payment.orderId;
    if (
      entity.amount !== payment.amountPaise ||
      entity.currency !== payment.currency
    ) {
      throw new Error("Webhook payment details do not match.");
    }
    if (parsed.event === "payment.failed") {
      if (entity.status !== "failed")
        throw new Error("Webhook payment failure state is invalid.");
      await dependencies.payments.failPayment({
        paymentId: payment.id,
        providerPaymentId: entity.id,
        nowMs: dependencies.now(),
        retainedUntilMs:
          dependencies.now() + FAILED_OR_CANCELLED_PAYMENT_RETENTION_MS,
      });
    } else {
      await dependencies.acceptCaptured(payment, entity);
    }
    await dependencies.payments.finishProviderEvent({
      providerEventId,
      status: "PROCESSED",
      paymentId,
      orderId,
      nowMs: dependencies.now(),
    });
    void import("../agent/wake").then((m) => m.wakeAgent(env));
    return ok({ received: true }, 200, NO_STORE);
  } catch {
    await dependencies.payments.finishProviderEvent({
      providerEventId,
      status: "FAILED",
      ...(paymentId ? { paymentId } : {}),
      ...(orderId ? { orderId } : {}),
      nowMs: dependencies.now(),
    });
    return error(
      500,
      "WEBHOOK_PROCESSING_FAILED",
      "Webhook processing failed.",
      NO_STORE,
    );
  }
}
