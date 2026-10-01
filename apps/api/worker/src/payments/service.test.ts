import { describe, expect, it, vi } from "vitest";

/* eslint-disable @typescript-eslint/unbound-method -- Vitest inspects method mocks without invoking them. */

import { FILE_SIZE_SERVICE_CHARGE_BANDS } from "@printgo/domain";

import type { CustomerRepository } from "../customer/repository";
import type {
  PayableDraftRecord,
  PaymentRecord,
  PaymentRepository,
} from "./repository";
import type { PaymentReadiness } from "./readiness";
import { hmacSha256Hex, type RazorpayClient } from "./razorpay";
import { PaymentService } from "./service";

const now = Date.UTC(2026, 8, 26);
const draft: PayableDraftRecord = {
  orderId: "50000000-0000-4000-8000-000000000001",
  uploadId: "upload-a",
  objectKey: "uploads/private.pdf",
  customerName: "Rahul",
  customerPhone: "9876543210",
  originalFilename: "notes.pdf",
  sourcePageCount: 10,
  selectedPages: "1-10",
  copies: 1,
  paperSize: "A4",
  colorMode: "BW",
  sides: "SINGLE",
  printingAmountPaise: 2_000,
  serviceChargePaise: 100,
  totalAmountPaise: 2_100,
  currency: "INR",
  orderStatus: "PAYMENT_PENDING",
  publicJobCode: null,
  expectedSizeBytes: 100,
  actualSizeBytes: 100,
  storageStatus: "UPLOADED",
  expiresAtMs: now + 60_000,
  deleteAfterMs: now + 60_000,
};

const payment: PaymentRecord = {
  id: "60000000-0000-4000-8000-000000000001",
  orderId: draft.orderId,
  providerOrderId: "order_server_a",
  providerPaymentId: null,
  amountPaise: 2_100,
  orderAmountPaise: 2_100,
  currency: "INR",
  status: "PENDING",
  publicJobCode: null,
  orderStatus: "PAYMENT_PENDING",
};

function paymentRepository(): PaymentRepository {
  return {
    findDraft: vi.fn(() => Promise.resolve(draft)),
    saveRecalculatedQuote: vi.fn(() => Promise.resolve(true)),
    findActivePayment: vi.fn(() => Promise.resolve(null)),
    reservePayment: vi.fn(() => Promise.resolve()),
    activatePayment: vi.fn(() => Promise.resolve()),
    abandonReservation: vi.fn(() => Promise.resolve()),
    findPaymentByProviderOrderId: vi.fn(() => Promise.resolve(payment)),
    findRetainedPaymentByProviderOrderId: vi.fn(() => Promise.resolve(null)),
    finalizePaid: vi.fn(
      (input: Parameters<PaymentRepository["finalizePaid"]>[0]) =>
        Promise.resolve({
          ...payment,
          providerPaymentId: input.providerPaymentId,
          status: "PAID" as const,
          publicJobCode: input.jobCode,
          orderStatus: "QUEUED",
        }),
    ),
    cancelPayment: vi.fn(() => Promise.resolve()),
    failPayment: vi.fn(() => Promise.resolve()),
    claimProviderEvent: vi.fn(() => Promise.resolve(true)),
    finishProviderEvent: vi.fn(() => Promise.resolve()),
  };
}

function customerRepository(pricePerPagePaise = 200) {
  return {
    getPublicConfig: vi.fn(() =>
      Promise.resolve({
        shopName: "ABC Xerox",
        contactPhone: null,
        customerNotice: null,
        onlinePrintingEnabled: true,
        maxPdfSizeBytes: 25 * 1024 * 1024,
        availablePrintOptions: [],
      }),
    ),
    getPricingConfiguration: vi.fn(() =>
      Promise.resolve({
        maxPdfSizeBytes: 25 * 1024 * 1024,
        printRates: (["A4", "A3"] as const).flatMap((paperSize) =>
          (["BW", "COLOR"] as const).flatMap((colorMode) =>
            (["SINGLE", "DOUBLE"] as const).map((sides) => ({
              paperSize,
              colorMode,
              sides,
              pricePerPagePaise,
              enabled: true,
            })),
          ),
        ),
        fileSizeServiceCharges: FILE_SIZE_SERVICE_CHARGE_BANDS.map((band) => ({
          ...band,
          chargePaise: 100,
          enabled: true,
        })),
      }),
    ),
  } satisfies Pick<
    CustomerRepository,
    "getPublicConfig" | "getPricingConfiguration"
  >;
}

function provider(): RazorpayClient {
  return {
    createOrder: vi.fn(() =>
      Promise.resolve({
        id: "order_server_a",
        amount: 2_100,
        currency: "INR" as const,
        status: "created",
      }),
    ),
    fetchPayment: vi.fn(() =>
      Promise.resolve({
        id: "pay_server_a",
        orderId: "order_server_a",
        amount: 2_100,
        currency: "INR" as const,
        status: "captured",
      }),
    ),
  };
}

function makeService(options?: {
  payments?: PaymentRepository;
  customer?: ReturnType<typeof customerRepository>;
  readiness?: PaymentReadiness;
  provider?: RazorpayClient;
  tracking?: {
    attachToVerifiedOrder(
      orderId: string,
      rawToken: string,
    ): Promise<{
      rawToken: string;
      expiresAt: string;
    }>;
  };
}) {
  return new PaymentService(
    options?.payments ?? paymentRepository(),
    options?.customer ?? customerRepository(),
    { head: vi.fn(() => Promise.resolve({ size: 100 })) },
    options?.readiness ?? {
      check: vi.fn(() =>
        Promise.resolve({
          ready: true as const,
          source: "DEVELOPMENT_BYPASS" as const,
        }),
      ),
    },
    options?.provider ?? provider(),
    { keyId: "rzp_test_key", keySecret: "secret" },
    options?.tracking ?? {
      attachToVerifiedOrder: (_orderId: string, rawToken: string) =>
        Promise.resolve({
          rawToken,
          expiresAt: "2026-10-10T00:00:00.000Z",
        }),
    },
    () => now,
  );
}

describe("PaymentService", () => {
  it("rejects expired uploads before checking readiness or creating an order", async () => {
    const payments = paymentRepository();
    vi.mocked(payments.findDraft).mockResolvedValueOnce({
      ...draft,
      expiresAtMs: now,
    });
    const razorpay = provider();
    await expect(
      makeService({ payments, provider: razorpay }).createCheckout(
        "token",
        2_100,
      ),
    ).rejects.toEqual(expect.objectContaining({ code: "DRAFT_EXPIRED" }));
    expect(razorpay.createOrder).not.toHaveBeenCalled();
  });

  it("treats the upload retention deadline as logical expiry", async () => {
    const payments = paymentRepository();
    vi.mocked(payments.findDraft).mockResolvedValueOnce({
      ...draft,
      deleteAfterMs: now,
    });
    await expect(
      makeService({ payments }).createCheckout("token", 2_100),
    ).rejects.toEqual(expect.objectContaining({ code: "DRAFT_EXPIRED" }));
  });

  it("rejects payment when Online Printing is off", async () => {
    const customer = customerRepository();
    vi.mocked(customer.getPublicConfig).mockResolvedValueOnce({
      shopName: "ABC Xerox",
      contactPhone: null,
      customerNotice: null,
      onlinePrintingEnabled: false,
      maxPdfSizeBytes: 25 * 1024 * 1024,
      availablePrintOptions: [],
    });
    const razorpay = provider();
    await expect(
      makeService({ customer, provider: razorpay }).createCheckout(
        "token",
        2_100,
      ),
    ).rejects.toEqual(
      expect.objectContaining({ code: "ONLINE_PRINTING_DISABLED" }),
    );
    expect(razorpay.createOrder).not.toHaveBeenCalled();
  });

  it("returns PRICE_CHANGED and never creates a provider order before acknowledgement", async () => {
    const razorpay = provider();
    const payments = paymentRepository();
    const result = await makeService({
      payments,
      customer: customerRepository(300),
      provider: razorpay,
    }).createCheckout("token", 2_100);
    expect(result.status).toBe("PRICE_CHANGED");
    if (result.status !== "PRICE_CHANGED") throw new Error("Unexpected result");
    expect(result.quote.totalAmountPaise).toBe(3_100);
    expect(payments.saveRecalculatedQuote).toHaveBeenCalledWith(
      expect.objectContaining({ totalAmountPaise: 3_100 }),
    );
    expect(razorpay.createOrder).not.toHaveBeenCalled();
  });

  it("fails closed on printer readiness before calling Razorpay", async () => {
    const razorpay = provider();
    await expect(
      makeService({
        provider: razorpay,
        readiness: {
          check: vi.fn(() =>
            Promise.resolve({
              ready: false as const,
              reason: "AGENT_READINESS_UNAVAILABLE" as const,
              message: "Printer is not ready.",
            }),
          ),
        },
      }).createCheckout("token", 2_100),
    ).rejects.toEqual(expect.objectContaining({ code: "PRINTER_NOT_READY" }));
    expect(razorpay.createOrder).not.toHaveBeenCalled();
  });

  it("uses the recalculated server amount and persists the provider order", async () => {
    const razorpay = provider();
    const payments = paymentRepository();
    await expect(
      makeService({ payments, provider: razorpay }).createCheckout(
        "token",
        2_100,
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        status: "CHECKOUT_READY",
        razorpayOrderId: "order_server_a",
        amountPaise: 2_100,
      }),
    );
    expect(razorpay.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({ amountPaise: 2_100, currency: "INR" }),
    );
    expect(payments.activatePayment).toHaveBeenCalledWith(
      expect.objectContaining({ providerOrderId: "order_server_a" }),
    );
  });

  it("reuses an existing usable pending order on a repeated click", async () => {
    const razorpay = provider();
    const payments = paymentRepository();
    vi.mocked(payments.findActivePayment).mockResolvedValueOnce(payment);
    const result = await makeService({
      payments,
      provider: razorpay,
    }).createCheckout("token", 2_100);
    expect(result).toEqual(
      expect.objectContaining({ razorpayOrderId: "order_server_a" }),
    );
    expect(razorpay.createOrder).not.toHaveBeenCalled();
    expect(payments.reservePayment).not.toHaveBeenCalled();
  });

  it("does not overwrite a commercial snapshot behind an active order", async () => {
    const payments = paymentRepository();
    vi.mocked(payments.findActivePayment).mockResolvedValueOnce({
      ...payment,
      amountPaise: 2_100,
      orderAmountPaise: 2_100,
    });
    const result = await makeService({
      payments,
      customer: customerRepository(300),
    }).createCheckout("token", 2_100);
    expect(result).toEqual(
      expect.objectContaining({ status: "PRICE_CHANGED" }),
    );
    expect(payments.saveRecalculatedQuote).not.toHaveBeenCalled();
  });

  it("rejects a callback signed for a different payment id", async () => {
    const payments = paymentRepository();
    const signature = await hmacSha256Hex("order_server_a|pay_other", "secret");
    await expect(
      makeService({ payments }).verify("token", {
        razorpayOrderId: "order_server_a",
        razorpayPaymentId: "pay_server_a",
        razorpaySignature: signature,
        trackingToken: "T".repeat(43),
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: "PAYMENT_SIGNATURE_INVALID" }),
    );
    expect(payments.finalizePaid).not.toHaveBeenCalled();
  });

  it("cannot use Order B's provider payment to mark Order A paid", async () => {
    const payments = paymentRepository();
    vi.mocked(payments.findPaymentByProviderOrderId).mockResolvedValueOnce({
      ...payment,
      orderId: "50000000-0000-4000-8000-000000000002",
    });
    const signature = await hmacSha256Hex(
      "order_server_a|pay_server_a",
      "secret",
    );
    await expect(
      makeService({ payments }).verify("token", {
        razorpayOrderId: "order_server_a",
        razorpayPaymentId: "pay_server_a",
        razorpaySignature: signature,
        trackingToken: "T".repeat(43),
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: "PAYMENT_ORDER_MISMATCH" }),
    );
    expect(payments.finalizePaid).not.toHaveBeenCalled();
  });

  it("does not accept an authorized but uncaptured provider payment", async () => {
    const payments = paymentRepository();
    const razorpay = provider();
    vi.mocked(razorpay.fetchPayment).mockResolvedValueOnce({
      id: "pay_server_a",
      orderId: "order_server_a",
      amount: 2_100,
      currency: "INR",
      status: "authorized",
    });
    const signature = await hmacSha256Hex(
      "order_server_a|pay_server_a",
      "secret",
    );
    await expect(
      makeService({ payments, provider: razorpay }).verify("token", {
        razorpayOrderId: "order_server_a",
        razorpayPaymentId: "pay_server_a",
        razorpaySignature: signature,
        trackingToken: "T".repeat(43),
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: "PAYMENT_NOT_CAPTURED" }),
    );
    expect(payments.finalizePaid).not.toHaveBeenCalled();
  });

  it("returns a job code only after captured payment finalization", async () => {
    const payments = paymentRepository();
    const signature = await hmacSha256Hex(
      "order_server_a|pay_server_a",
      "secret",
    );
    const result = await makeService({ payments }).verify("token", {
      razorpayOrderId: "order_server_a",
      razorpayPaymentId: "pay_server_a",
      razorpaySignature: signature,
      trackingToken: "T".repeat(43),
    });
    expect(result.jobCode).toMatch(
      /^PG-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/u,
    );
    expect(result.status).toBe("QUEUED");
    expect(payments.finalizePaid).toHaveBeenCalledWith(
      expect.objectContaining({ providerPaymentId: "pay_server_a" }),
    );
  });

  it("retries a job-code collision", async () => {
    const payments = paymentRepository();
    vi.mocked(payments.finalizePaid)
      .mockRejectedValueOnce(
        new Error("UNIQUE constraint failed: orders.public_job_code"),
      )
      .mockImplementationOnce((input) =>
        Promise.resolve({
          ...payment,
          providerPaymentId: input.providerPaymentId,
          status: "PAID",
          publicJobCode: input.jobCode,
          orderStatus: "QUEUED",
        }),
      );
    const signature = await hmacSha256Hex(
      "order_server_a|pay_server_a",
      "secret",
    );
    const result = await makeService({ payments }).verify("token", {
      razorpayOrderId: "order_server_a",
      razorpayPaymentId: "pay_server_a",
      razorpaySignature: signature,
      trackingToken: "T".repeat(43),
    });
    expect(result.jobCode).toMatch(/^PG-/u);
    expect(payments.finalizePaid).toHaveBeenCalledTimes(2);
  });

  it("returns the already-issued job code on a repeated callback", async () => {
    const payments = paymentRepository();
    vi.mocked(payments.findDraft).mockResolvedValueOnce({
      ...draft,
      expiresAtMs: now - 1,
    });
    vi.mocked(payments.findPaymentByProviderOrderId).mockResolvedValueOnce({
      ...payment,
      status: "PAID",
      providerPaymentId: "pay_server_a",
      publicJobCode: "PG-ABC234",
      orderStatus: "QUEUED",
    });
    const signature = await hmacSha256Hex(
      "order_server_a|pay_server_a",
      "secret",
    );
    await expect(
      makeService({ payments }).verify("token", {
        razorpayOrderId: "order_server_a",
        razorpayPaymentId: "pay_server_a",
        razorpaySignature: signature,
        trackingToken: "T".repeat(43),
      }),
    ).resolves.toEqual(expect.objectContaining({ jobCode: "PG-ABC234" }));
    expect(payments.finalizePaid).not.toHaveBeenCalled();
  });

  it("sets the 30-minute cancellation retention deadline", async () => {
    const payments = paymentRepository();
    const result = await makeService({ payments }).cancel(
      "token",
      "order_server_a",
    );
    expect(result.retainedUntil).toBe(
      new Date(now + 30 * 60_000).toISOString(),
    );
    expect(payments.cancelPayment).toHaveBeenCalledWith(
      expect.objectContaining({ retainedUntilMs: now + 30 * 60_000 }),
    );
  });
});
