import { describe, expect, it, vi } from "vitest";

/* eslint-disable @typescript-eslint/unbound-method -- Vitest inspects method mocks without invoking them. */

import type { WorkerEnv } from "../env";
import { handleCustomerRequest, type CustomerActions } from "./routes";

const env = {
  CUSTOMER_ALLOWED_ORIGIN: "https://print.example.test",
} as WorkerEnv;
const token = "A".repeat(43);

function actions(): CustomerActions {
  return {
    getConfig: vi.fn(() =>
      Promise.resolve({
        shopName: "ABC Xerox",
        contactPhone: null,
        customerNotice: null,
        onlinePrintingEnabled: true,
        maxPdfSizeBytes: 100,
        availablePrintOptions: [
          {
            paperSize: "A4" as const,
            colorMode: "BW" as const,
            sides: "SINGLE" as const,
          },
        ],
      }),
    ),
    createDraft: vi.fn(() =>
      Promise.resolve({
        draftToken: token,
        draftExpiresAt: "2026-09-26T00:10:00.000Z",
        upload: {
          uploadUrl: "https://r2.test/signed",
          expiresAt: "2026-09-26T00:05:00.000Z",
          requiredHeaders: {},
        },
      }),
    ),
    authorizeUpload: vi.fn(() =>
      Promise.resolve({
        uploadUrl: "https://r2.test/signed",
        expiresAt: "soon",
        requiredHeaders: {},
      }),
    ),
    completeUpload: vi.fn(() =>
      Promise.resolve({
        sizeBytes: 10,
        uploadedAt: "now",
        draftExpiresAt: "later",
      }),
    ),
    quote: vi.fn(() =>
      Promise.resolve({
        normalizedSelectedPages: "1-3",
        selectedPageCount: 3,
        copies: 1,
        paperSize: "A4" as const,
        colorMode: "BW" as const,
        sides: "SINGLE" as const,
        printingAmountPaise: 300,
        serviceChargePaise: 100,
        totalAmountPaise: 400,
        currency: "INR" as const,
        expiresAt: "later",
      }),
    ),
    createPayment: vi.fn(() =>
      Promise.resolve({
        status: "CHECKOUT_READY" as const,
        razorpayKeyId: "rzp_test_key",
        razorpayOrderId: "order_server_a",
        amountPaise: 400,
        currency: "INR" as const,
        shopName: "ABC Xerox",
        customerName: "Rahul",
        customerPhone: "9876543210",
        description: "Printing: notes.pdf",
      }),
    ),
    verifyPayment: vi.fn(() =>
      Promise.resolve({
        jobCode: "PG-ABC234",
        amountPaidPaise: 400,
        currency: "INR" as const,
        status: "QUEUED" as const,
        message: "Payment verified. Your print job is queued.",
      }),
    ),
    cancelPayment: vi.fn(() =>
      Promise.resolve({
        status: "PAYMENT_CANCELLED" as const,
        retainedUntil: "later",
      }),
    ),
  };
}

function request(
  path: string,
  method: string,
  body?: unknown,
  origin = env.CUSTOMER_ALLOWED_ORIGIN,
) {
  return new Request(`https://api.test${path}`, {
    method,
    headers: {
      Origin: origin,
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("customer routes", () => {
  it("returns safe public configuration with no-store", async () => {
    const response = await handleCustomerRequest(
      request("/api/customer/config", "GET"),
      env,
      actions(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(JSON.stringify(await response.json())).not.toContain("secret");
  });

  it("rejects state changes from untrusted origins before actions", async () => {
    const api = actions();
    const response = await handleCustomerRequest(
      request("/api/customer/drafts", "POST", {}, "https://evil.test"),
      env,
      api,
    );
    expect(response.status).toBe(403);
    expect(api.createDraft).not.toHaveBeenCalled();
  });

  it("ignores a client-selected page count instead of treating it as authoritative", async () => {
    const api = actions();
    const response = await handleCustomerRequest(
      request("/api/customer/draft/print-settings", "PUT", {
        selectedPages: "1-3",
        selectedPageCount: 1,
        copies: 1,
        paperSize: "A4",
        colorMode: "BW",
        sides: "SINGLE",
      }),
      env,
      api,
    );
    expect(response.status).toBe(200);
    expect(api.quote).toHaveBeenCalledWith(token, {
      selectedPages: "1-3",
      copies: 1,
      paperSize: "A4",
      colorMode: "BW",
      sides: "SINGLE",
    });
  });

  it("does not accept a token in the body", async () => {
    const api = actions();
    const response = await handleCustomerRequest(
      new Request("https://api.test/api/customer/uploads/complete", {
        method: "POST",
        headers: {
          Origin: env.CUSTOMER_ALLOWED_ORIGIN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ draftToken: token }),
      }),
      env,
      api,
    );
    expect(response.status).toBe(401);
    expect(api.completeUpload).not.toHaveBeenCalled();
  });

  it("accepts only a reviewed integer total for payment creation", async () => {
    const api = actions();
    const invalid = await handleCustomerRequest(
      request("/api/customer/payments/create", "POST", {
        acknowledgedTotalPaise: "400",
        amountPaise: 1,
      }),
      env,
      api,
    );
    expect(invalid.status).toBe(400);
    expect(api.createPayment).not.toHaveBeenCalled();

    const valid = await handleCustomerRequest(
      request("/api/customer/payments/create", "POST", {
        acknowledgedTotalPaise: 400,
      }),
      env,
      api,
    );
    expect(valid.status).toBe(200);
    expect(api.createPayment).toHaveBeenCalledWith(token, {
      acknowledgedTotalPaise: 400,
    });
  });

  it("rejects malformed provider verification identifiers", async () => {
    const api = actions();
    const response = await handleCustomerRequest(
      request("/api/customer/payments/verify", "POST", {
        razorpayOrderId: "attacker-order",
        razorpayPaymentId: "pay_a",
        razorpaySignature: "a".repeat(64),
      }),
      env,
      api,
    );
    expect(response.status).toBe(400);
    expect(api.verifyPayment).not.toHaveBeenCalled();
  });
});
