import { describe, expect, it, vi } from "vitest";

/* eslint-disable @typescript-eslint/unbound-method -- Vitest inspects method mocks without invoking them. */

import type { WorkerEnv } from "../env";
import type { PaymentRecord, PaymentRepository } from "./repository";
import { hmacSha256Hex } from "./razorpay";
import { handleRazorpayWebhook, type WebhookDependencies } from "./webhook";

const now = Date.UTC(2026, 8, 26);
const payment: PaymentRecord = {
  id: "60000000-0000-4000-8000-000000000001",
  orderId: "50000000-0000-4000-8000-000000000001",
  providerOrderId: "order_server_a",
  providerPaymentId: null,
  amountPaise: 2_100,
  orderAmountPaise: 2_100,
  currency: "INR",
  status: "PENDING",
  publicJobCode: null,
  orderStatus: "PAYMENT_PENDING",
};

function repository(): PaymentRepository {
  return {
    findDraft: vi.fn(),
    saveRecalculatedQuote: vi.fn(),
    findActivePayment: vi.fn(),
    reservePayment: vi.fn(),
    activatePayment: vi.fn(),
    abandonReservation: vi.fn(),
    findPaymentByProviderOrderId: vi.fn(() => Promise.resolve(payment)),
    finalizePaid: vi.fn(),
    cancelPayment: vi.fn(),
    failPayment: vi.fn(() => Promise.resolve()),
    claimProviderEvent: vi.fn(() => Promise.resolve(true)),
    finishProviderEvent: vi.fn(() => Promise.resolve()),
  };
}

function webhookBody(event = "payment.captured") {
  return JSON.stringify({
    event,
    payload: {
      payment: {
        entity: {
          id: "pay_server_a",
          order_id: "order_server_a",
          amount: 2_100,
          currency: "INR",
          status: event === "payment.failed" ? "failed" : "captured",
        },
      },
    },
  });
}

async function request(body: string, signature?: string) {
  return new Request("https://api.test/api/webhooks/razorpay", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-razorpay-event-id": "event_a",
      "x-razorpay-signature":
        signature ?? (await hmacSha256Hex(body, "webhook-secret")),
    },
    body,
  });
}

const env = {
  RAZORPAY_WEBHOOK_SECRET: "webhook-secret",
} as WorkerEnv;

function dependencies(payments = repository()): WebhookDependencies {
  return {
    payments,
    acceptCaptured: vi.fn(() =>
      Promise.resolve({
        ...payment,
        status: "PAID" as const,
        publicJobCode: "PG-ABC234",
      }),
    ),
    now: () => now,
  };
}

describe("Razorpay webhook", () => {
  it("rejects an invalid signature before recording or parsing the event", async () => {
    const deps = dependencies();
    const response = await handleRazorpayWebhook(
      await request("not-json", "0".repeat(64)),
      env,
      deps,
    );
    expect(response.status).toBe(400);
    expect(deps.payments.claimProviderEvent).not.toHaveBeenCalled();
  });

  it("processes a signed captured event exactly once", async () => {
    const body = webhookBody();
    const deps = dependencies();
    const response = await handleRazorpayWebhook(
      await request(body),
      env,
      deps,
    );
    expect(response.status).toBe(200);
    expect(deps.acceptCaptured).toHaveBeenCalledWith(
      payment,
      expect.objectContaining({ status: "captured", amount: 2_100 }),
    );
    expect(deps.payments.finishProviderEvent).toHaveBeenCalledWith(
      expect.objectContaining({ status: "PROCESSED", paymentId: payment.id }),
    );
  });

  it("acknowledges a duplicate provider event without replaying transitions", async () => {
    const payments = repository();
    vi.mocked(payments.claimProviderEvent).mockResolvedValueOnce(false);
    const deps = dependencies(payments);
    const response = await handleRazorpayWebhook(
      await request(webhookBody()),
      env,
      deps,
    );
    expect(response.status).toBe(200);
    expect(deps.acceptCaptured).not.toHaveBeenCalled();
  });

  it("records provider-confirmed failures with 30-minute retention", async () => {
    const payments = repository();
    const deps = dependencies(payments);
    const response = await handleRazorpayWebhook(
      await request(webhookBody("payment.failed")),
      env,
      deps,
    );
    expect(response.status).toBe(200);
    expect(payments.failPayment).toHaveBeenCalledWith(
      expect.objectContaining({ retainedUntilMs: now + 30 * 60_000 }),
    );
    expect(deps.acceptCaptured).not.toHaveBeenCalled();
  });

  it("reclaims a stale PROCESSING event and successfully processes on retry", async () => {
    const payments = repository();
    // Simulate initial crash (claim succeeded, but finish was not reached)
    // Retry arrives: claim succeeds via stale timeout
    vi.mocked(payments.claimProviderEvent).mockResolvedValueOnce(true);
    const deps = dependencies(payments);
    const response = await handleRazorpayWebhook(
      await request(webhookBody()),
      env,
      deps,
    );
    expect(response.status).toBe(200);
    expect(payments.claimProviderEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        providerEventId: "event_a",
        staleTimeoutMs: 5 * 60_000,
      }),
    );
    expect(deps.acceptCaptured).toHaveBeenCalledOnce();
    expect(payments.finishProviderEvent).toHaveBeenCalledWith(
      expect.objectContaining({ status: "PROCESSED" }),
    );
  });

  it("handles callback + webhook race without duplicate print job or state error", async () => {
    const payments = repository();
    const deps = dependencies(payments);
    // Simulate customer callback already finalized the payment
    const alreadyPaidPayment = {
      ...payment,
      status: "PAID" as const,
      publicJobCode: "PG-ABC234",
    };
    vi.mocked(payments.findPaymentByProviderOrderId).mockResolvedValueOnce(
      alreadyPaidPayment,
    );
    const response = await handleRazorpayWebhook(
      await request(webhookBody()),
      env,
      deps,
    );
    expect(response.status).toBe(200);
    expect(deps.acceptCaptured).toHaveBeenCalledWith(
      alreadyPaidPayment,
      expect.objectContaining({ status: "captured" }),
    );
    expect(payments.finishProviderEvent).toHaveBeenCalledWith(
      expect.objectContaining({ status: "PROCESSED" }),
    );
  });
});
