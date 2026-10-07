import { describe, expect, it, vi } from "vitest";

/* eslint-disable @typescript-eslint/unbound-method -- Vitest inspects method mocks without invoking them. */

import type { WorkerEnv } from "../env";
import { TrackingError } from "../tracking/service";
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
    addFile: vi.fn(() => Promise.reject(new Error("not used"))),
    removeFile: vi.fn(() =>
      Promise.resolve({
        customerName: "Rahul",
        customerPhone: "9876543210",
        instructions: null,
        status: "UPLOADED",
        draftExpiresAt: "later",
        files: [],
      }),
    ),
    getDraft: vi.fn(() =>
      Promise.resolve({
        customerName: "Rahul",
        customerPhone: "9876543210",
        instructions: null,
        status: "UPLOADED",
        draftExpiresAt: "later",
        files: [],
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
    quoteOrder: vi.fn(() => Promise.reject(new Error("not used"))),
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
        trackingToken: "T".repeat(43),
        trackingExpiresAt: "2026-10-10T00:00:00.000Z",
      }),
    ),
    cancelPayment: vi.fn(() =>
      Promise.resolve({
        status: "PAYMENT_CANCELLED" as const,
        retainedUntil: "later",
      }),
    ),
    tracking: vi.fn(() =>
      Promise.resolve({
        jobCode: "PG-ABC234",
        customerName: "Rahul",
        paymentStatus: "PAYMENT_RECEIVED" as const,
        orderStatus: "QUEUED" as const,
        statusLabel: "In queue",
        statusMessage: "Your paid print job is in the printer queue.",
        submittedAt: "2026-09-26T00:00:00.000Z",
        paidAt: "2026-09-26T00:01:00.000Z",
        printSummary: {
          selectedPages: "1-3",
          copies: 1,
          paperSize: "A4" as const,
          colorMode: "BW" as const,
          sides: "SINGLE" as const,
        },
        amountPaidPaise: 400,
        currency: "INR" as const,
        instructions: null,
        fileRetentionStatus: "TEMPORARILY_RETAINED" as const,
        timeline: [
          {
            status: "PAYMENT_RECEIVED" as const,
            label: "Payment received",
            occurredAt: "2026-09-26T00:01:00.000Z",
          },
        ],
        trackingExpiresAt: "2026-10-10T00:01:00.000Z",
      }),
    ),
    trackPublicOrder: vi.fn(() => Promise.reject(new Error("not used"))),
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
  it("returns safe public configuration with edge cache header", async () => {
    const response = await handleCustomerRequest(
      request("/api/customer/config", "GET"),
      env,
      actions(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(
      "public, max-age=30, stale-while-revalidate=60",
    );
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

  it("rejects manipulated copies exceeding 100 or below 1", async () => {
    const api = actions();
    const overLimit = await handleCustomerRequest(
      request("/api/customer/draft/print-settings", "PUT", {
        selectedPages: "1",
        copies: 101,
        paperSize: "A4",
        colorMode: "BW",
        sides: "SINGLE",
      }),
      env,
      api,
    );
    expect(overLimit.status).toBe(400);

    const zeroCopies = await handleCustomerRequest(
      request("/api/customer/draft/print-settings", "PUT", {
        selectedPages: "1",
        copies: 0,
        paperSize: "A4",
        colorMode: "BW",
        sides: "SINGLE",
      }),
      env,
      api,
    );
    expect(zeroCopies.status).toBe(400);
    expect(api.quote).not.toHaveBeenCalled();
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
        acknowledgedTotalPaise: 400, trackingToken: "test",
      }),
      env,
      api,
    );
    expect(valid.status).toBe(200);
    expect(api.createPayment).toHaveBeenCalledWith(token, {
      acknowledgedTotalPaise: 400, trackingToken: "test",
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

  it("returns a no-store customer-safe tracking response", async () => {
    const api = actions();
    const response = await handleCustomerRequest(
      request("/api/customer/tracking/pg-abc234", "GET"),
      env,
      api,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(api.tracking).toHaveBeenCalledWith("pg-abc234", token);
    const serialized = JSON.stringify(await response.json());
    expect(serialized).toContain("PG-ABC234");
    expect(serialized).not.toMatch(/orderId|r2|objectKey|provider|phone/iu);
  });

  it("does not reveal whether a job code exists when the token is wrong", async () => {
    const existing = actions();
    const missing = actions();
    vi.mocked(existing.tracking).mockRejectedValueOnce(
      new TrackingError("TRACKING_NOT_FOUND"),
    );
    vi.mocked(missing.tracking).mockRejectedValueOnce(
      new TrackingError("TRACKING_NOT_FOUND"),
    );
    const existingResponse = await handleCustomerRequest(
      request("/api/customer/tracking/PG-ABC234", "GET"),
      env,
      existing,
    );
    const missingResponse = await handleCustomerRequest(
      request("/api/customer/tracking/PG-ZZZZZZ", "GET"),
      env,
      missing,
    );
    expect(existingResponse.status).toBe(404);
    expect(missingResponse.status).toBe(404);
    expect(await existingResponse.text()).toBe(await missingResponse.text());
  });
});
