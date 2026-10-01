import type {
  CreateCustomerPaymentData,
  CustomerFileQuoteData,
  CustomerPaymentSuccessData,
  CustomerQuoteData,
  VerifyCustomerPaymentRequest,
} from "@printgo/api-contract";
import { hashSessionToken } from "@printgo/auth";
import {
  FAILED_OR_CANCELLED_PAYMENT_RETENTION_MS,
  parsePageRange,
} from "@printgo/domain";
import { calculatePrintPrice, PricingError } from "@printgo/pricing";

import type { CustomerRepository } from "../customer/repository";
import type { PrivateObjectStore } from "../storage/r2-verification";
import type { TrackingService } from "../tracking/service";
import { generateJobCode } from "./job-code";
import type {
  PayableDraftRecord,
  PayableFileRecord,
  PaymentRecord,
  PaymentRepository,
} from "./repository";
import type { PaymentReadiness } from "./readiness";
import type { RazorpayClient, RazorpayPayment } from "./razorpay";
import { verifyHmacSha256Hex } from "./razorpay";

export type PaymentErrorCode =
  | "DRAFT_INVALID"
  | "DRAFT_EXPIRED"
  | "PAYMENT_STATE_INVALID"
  | "UPLOAD_NOT_FOUND"
  | "UPLOAD_INVALID"
  | "ONLINE_PRINTING_DISABLED"
  | "PRINTER_NOT_READY"
  | "PAYMENT_CONFIGURATION_MISSING"
  | "PAYMENT_CREATION_IN_PROGRESS"
  | "PAYMENT_PROVIDER_UNAVAILABLE"
  | "PAYMENT_ORDER_MISMATCH"
  | "PAYMENT_SIGNATURE_INVALID"
  | "PAYMENT_NOT_CAPTURED"
  | "PAYMENT_DETAILS_MISMATCH"
  | "PAYMENT_AMOUNT_INVALID";

export class PaymentError extends Error {
  constructor(readonly code: PaymentErrorCode) {
    super(code);
    this.name = "PaymentError";
  }
}

export interface PaymentServiceConfiguration {
  keyId: string;
  keySecret: string;
}

export class PaymentService {
  constructor(
    private readonly payments: PaymentRepository,
    private readonly customer: Pick<
      CustomerRepository,
      "getPublicConfig" | "getPricingConfiguration"
    > & {
      getOrderAddonAmountPaise?: (orderId: string) => Promise<number>;
    },
    private readonly objects: Pick<PrivateObjectStore, "head">,
    private readonly readiness: PaymentReadiness,
    private readonly razorpay: RazorpayClient,
    private readonly configuration: PaymentServiceConfiguration,
    private readonly tracking: Pick<TrackingService, "attachToVerifiedOrder">,
    private readonly now: () => number = Date.now,
  ) {}

  private async findDraft(rawToken: string): Promise<PayableDraftRecord> {
    const draft = await this.payments.findDraft(
      await hashSessionToken(rawToken),
    );
    if (!draft) throw new PaymentError("DRAFT_INVALID");
    return draft;
  }

  private validateDraftState(draft: PayableDraftRecord): void {
    if (
      draft.expiresAtMs <= this.now() ||
      draft.deleteAfterMs === null ||
      draft.deleteAfterMs <= this.now()
    )
      throw new PaymentError("DRAFT_EXPIRED");
    if (
      !["PAYMENT_PENDING", "PAYMENT_FAILED", "PAYMENT_CANCELLED"].includes(
        draft.orderStatus,
      ) ||
      draft.storageStatus !== "UPLOADED" ||
      !draft.actualSizeBytes
    ) {
      throw new PaymentError("PAYMENT_STATE_INVALID");
    }
  }

  private async requireDraft(rawToken: string): Promise<PayableDraftRecord> {
    const draft = await this.findDraft(rawToken);
    this.validateDraftState(draft);
    return draft;
  }

  private files(draft: PayableDraftRecord): PayableFileRecord[] {
    return draft.files && draft.files.length > 0
      ? draft.files
      : [
          {
            id: draft.uploadId,
            position: 1,
            objectKey: draft.objectKey,
            originalFilename: draft.originalFilename,
            sourcePageCount: draft.sourcePageCount,
            selectedPages: draft.selectedPages,
            selectedPageCount: null,
            copies: draft.copies,
            paperSize: draft.paperSize,
            colorMode: draft.colorMode,
            sides: draft.sides,
            expectedSizeBytes: draft.expectedSizeBytes,
            actualSizeBytes: draft.actualSizeBytes,
            uploadStatus: draft.storageStatus,
          },
        ];
  }

  private async reprice(draft: PayableDraftRecord): Promise<CustomerQuoteData> {
    const config = await this.customer.getPublicConfig();
    if (!config?.onlinePrintingEnabled)
      throw new PaymentError("ONLINE_PRINTING_DISABLED");
    const draftFiles = this.files(draft);
    if (draftFiles.length < 1 || draftFiles.length > 10)
      throw new PaymentError("PAYMENT_STATE_INVALID");
    try {
      const configuration = await this.customer.getPricingConfiguration();
      const files: CustomerFileQuoteData[] = [];
      for (const file of draftFiles) {
        if (file.uploadStatus !== "UPLOADED" || !file.actualSizeBytes)
          throw new PaymentError("UPLOAD_INVALID");
        const object = await this.objects.head(file.objectKey);
        if (!object) throw new PaymentError("UPLOAD_NOT_FOUND");
        if (object.size !== file.actualSizeBytes)
          throw new PaymentError("UPLOAD_INVALID");
        const pages = parsePageRange(file.selectedPages, file.sourcePageCount);
        const price = calculatePrintPrice(
          {
            pageCount: pages.selectedPageCount,
            copies: file.copies,
            fileSizeBytes: object.size,
            paperSize: file.paperSize,
            colorMode: file.colorMode,
            sides: file.sides,
          },
          configuration,
        );
        files.push({
          fileId: file.id,
          originalFilename: file.originalFilename,
          sizeBytes: file.actualSizeBytes,
          sourcePageCount: file.sourcePageCount,
          selectedPages: pages.normalized,
          selectedPageCount: pages.selectedPageCount,
          copies: file.copies,
          paperSize: file.paperSize,
          colorMode: file.colorMode,
          sides: file.sides,
          printingAmountPaise: price.printingAmountPaise,
          serviceChargePaise: price.serviceChargePaise,
          uploadStatus: file.uploadStatus,
        });
      }
      const first = files[0];
      if (!first) throw new PaymentError("PAYMENT_STATE_INVALID");
      const printingAmountPaise = files.reduce(
        (total, file) => total + file.printingAmountPaise,
        0,
      );
      const serviceChargePaise = files.reduce(
        (total, file) => total + file.serviceChargePaise,
        0,
      );
      const addonAmountPaise = this.customer.getOrderAddonAmountPaise
        ? await this.customer.getOrderAddonAmountPaise(draft.orderId)
        : 0;
      const totalAmountPaise =
        printingAmountPaise + serviceChargePaise + addonAmountPaise;
      return {
        normalizedSelectedPages: first.selectedPages,
        selectedPageCount: first.selectedPageCount,
        copies: first.copies,
        paperSize: first.paperSize,
        colorMode: first.colorMode,
        sides: first.sides,
        printingAmountPaise,
        serviceChargePaise,
        totalAmountPaise,
        currency: "INR",
        expiresAt: new Date(draft.expiresAtMs).toISOString(),
        files,
        addonAmountPaise,
      };
    } catch (caught) {
      if (
        caught instanceof PricingError ||
        (caught instanceof Error && caught.name === "PageRangeError")
      ) {
        throw new PaymentError("PAYMENT_STATE_INVALID");
      }
      throw caught;
    }
  }

  private async saveQuote(
    draft: PayableDraftRecord,
    quote: CustomerQuoteData,
  ): Promise<void> {
    const saved = await this.payments.saveRecalculatedQuote({
      orderId: draft.orderId,
      selectedPages: quote.normalizedSelectedPages,
      printingAmountPaise: quote.printingAmountPaise,
      serviceChargePaise: quote.serviceChargePaise,
      totalAmountPaise: quote.totalAmountPaise,
      nowMs: this.now(),
    });
    if (!saved) throw new PaymentError("PAYMENT_STATE_INVALID");
  }

  async createCheckout(
    rawToken: string,
    acknowledgedTotalPaise: number,
  ): Promise<CreateCustomerPaymentData> {
    if (!this.configuration.keyId || !this.configuration.keySecret) {
      throw new PaymentError("PAYMENT_CONFIGURATION_MISSING");
    }
    const draft = await this.requireDraft(rawToken);
    const draftFiles = this.files(draft);
    const quote = await this.reprice(draft);
    const active = await this.payments.findActivePayment(draft.orderId);
    if (active && active.amountPaise !== quote.totalAmountPaise) {
      if (quote.totalAmountPaise !== acknowledgedTotalPaise) {
        return { status: "PRICE_CHANGED", quote };
      }
      throw new PaymentError("PAYMENT_STATE_INVALID");
    }
    await this.saveQuote(draft, quote);
    if (quote.totalAmountPaise <= 0)
      throw new PaymentError("PAYMENT_AMOUNT_INVALID");
    if (quote.totalAmountPaise !== acknowledgedTotalPaise) {
      return { status: "PRICE_CHANGED", quote };
    }
    const checked = new Set<string>();
    for (const file of draftFiles) {
      const key = `${file.paperSize}:${file.colorMode}:${file.sides}`;
      if (checked.has(key)) continue;
      checked.add(key);
      const readiness = await this.readiness.check({
        paperSize: file.paperSize,
        colorMode: file.colorMode,
        sides: file.sides,
      });
      if (!readiness.ready) throw new PaymentError("PRINTER_NOT_READY");
    }

    if (active) {
      if (
        active.status === "PENDING" &&
        active.amountPaise === quote.totalAmountPaise &&
        active.providerOrderId.startsWith("order_")
      ) {
        return this.checkoutData(draft, quote, active.providerOrderId);
      }
      if (active.status === "CREATED") {
        throw new PaymentError("PAYMENT_CREATION_IN_PROGRESS");
      }
      throw new PaymentError("PAYMENT_STATE_INVALID");
    }

    const paymentId = crypto.randomUUID();
    try {
      await this.payments.reservePayment({
        paymentId,
        orderId: draft.orderId,
        temporaryProviderOrderId: `local_${paymentId}`,
        amountPaise: quote.totalAmountPaise,
        nowMs: this.now(),
      });
    } catch {
      const concurrent = await this.payments.findActivePayment(draft.orderId);
      if (
        concurrent?.status === "PENDING" &&
        concurrent.amountPaise === quote.totalAmountPaise &&
        concurrent.providerOrderId.startsWith("order_")
      ) {
        return this.checkoutData(draft, quote, concurrent.providerOrderId);
      }
      throw new PaymentError("PAYMENT_CREATION_IN_PROGRESS");
    }

    try {
      const receipt = `pg_${draft.orderId.replaceAll("-", "").slice(0, 23)}_${quote.totalAmountPaise}`;
      const providerOrder = await this.razorpay.createOrder({
        amountPaise: quote.totalAmountPaise,
        currency: "INR",
        receipt,
      });
      if (
        !providerOrder.id.startsWith("order_") ||
        providerOrder.amount !== quote.totalAmountPaise ||
        providerOrder.currency !== "INR" ||
        providerOrder.status !== "created"
      ) {
        throw new PaymentError("PAYMENT_DETAILS_MISMATCH");
      }
      await this.payments.activatePayment({
        paymentId,
        providerOrderId: providerOrder.id,
        nowMs: this.now(),
      });
      return this.checkoutData(draft, quote, providerOrder.id);
    } catch (caught) {
      await this.payments.abandonReservation(paymentId, this.now());
      if (caught instanceof PaymentError) throw caught;
      throw new PaymentError("PAYMENT_PROVIDER_UNAVAILABLE");
    }
  }

  private async checkoutData(
    draft: PayableDraftRecord,
    quote: CustomerQuoteData,
    providerOrderId: string,
  ) {
    const config = await this.customer.getPublicConfig();
    if (!config?.onlinePrintingEnabled)
      throw new PaymentError("ONLINE_PRINTING_DISABLED");
    return {
      status: "CHECKOUT_READY" as const,
      razorpayKeyId: this.configuration.keyId,
      razorpayOrderId: providerOrderId,
      amountPaise: quote.totalAmountPaise,
      currency: "INR" as const,
      shopName: config.shopName,
      customerName: draft.customerName,
      customerPhone: draft.customerPhone,
      description: `Printing: ${draft.originalFilename}`,
    };
  }

  private validateCapturedPayment(
    payment: PaymentRecord,
    providerPayment: RazorpayPayment,
  ): void {
    if (providerPayment.status !== "captured")
      throw new PaymentError("PAYMENT_NOT_CAPTURED");
    if (
      providerPayment.id.length === 0 ||
      providerPayment.orderId !== payment.providerOrderId ||
      providerPayment.amount !== payment.amountPaise ||
      payment.amountPaise !== payment.orderAmountPaise ||
      providerPayment.currency !== payment.currency
    ) {
      throw new PaymentError("PAYMENT_DETAILS_MISMATCH");
    }
  }

  async verify(
    rawToken: string,
    input: VerifyCustomerPaymentRequest,
  ): Promise<CustomerPaymentSuccessData> {
    if (!this.configuration.keySecret)
      throw new PaymentError("PAYMENT_CONFIGURATION_MISSING");
    const draft = await this.findDraft(rawToken);
    const payment = await this.payments.findPaymentByProviderOrderId(
      input.razorpayOrderId,
    );
    if (!payment || payment.orderId !== draft.orderId)
      throw new PaymentError("PAYMENT_ORDER_MISMATCH");
    if (
      payment.status === "PAID" &&
      payment.providerPaymentId !== input.razorpayPaymentId
    ) {
      throw new PaymentError("PAYMENT_ORDER_MISMATCH");
    }
    const valid = await verifyHmacSha256Hex(
      `${payment.providerOrderId}|${input.razorpayPaymentId}`,
      input.razorpaySignature,
      this.configuration.keySecret,
    );
    if (!valid) throw new PaymentError("PAYMENT_SIGNATURE_INVALID");
    if (payment.status === "PAID" && payment.publicJobCode) {
      return this.successData(payment, input.trackingToken);
    }
    this.validateDraftState(draft);
    if (
      payment.providerOrderId !== input.razorpayOrderId ||
      payment.status !== "PENDING"
    ) {
      throw new PaymentError("PAYMENT_ORDER_MISMATCH");
    }
    let providerPayment: RazorpayPayment;
    try {
      providerPayment = await this.razorpay.fetchPayment(
        input.razorpayPaymentId,
      );
    } catch {
      throw new PaymentError("PAYMENT_PROVIDER_UNAVAILABLE");
    }
    this.validateCapturedPayment(payment, providerPayment);
    return this.successData(
      await this.finalizeWithUniqueJobCode(
        payment,
        input.razorpayPaymentId,
        "CUSTOMER",
      ),
      input.trackingToken,
    );
  }

  async acceptCapturedWebhook(
    payment: PaymentRecord,
    providerPayment: RazorpayPayment,
  ): Promise<PaymentRecord> {
    this.validateCapturedPayment(payment, providerPayment);
    if (payment.status === "PAID" && payment.publicJobCode) return payment;
    if (!["PENDING", "FAILED", "CANCELLED"].includes(payment.status)) {
      throw new PaymentError("PAYMENT_STATE_INVALID");
    }
    return this.finalizeWithUniqueJobCode(
      payment,
      providerPayment.id,
      "PAYMENT_PROVIDER",
    );
  }

  private async finalizeWithUniqueJobCode(
    payment: PaymentRecord,
    providerPaymentId: string,
    actorType: "CUSTOMER" | "PAYMENT_PROVIDER",
  ): Promise<PaymentRecord> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        const nowMs = this.now();
        const finalized = await this.payments.finalizePaid({
          paymentId: payment.id,
          providerPaymentId,
          jobCode: generateJobCode(),
          nowMs,
          actorType,
        });
        // Route to MANUAL_PRINT if any addon service requires manual handling.
        // No-op for orders without addon services (preserves existing behavior).
        await this.payments.routeOrderAfterPayment(finalized.orderId, nowMs);
        return finalized;
      } catch (caught) {
        if (
          !(caught instanceof Error) ||
          !/unique constraint failed: orders\.public_job_code/iu.test(
            caught.message,
          )
        ) {
          throw caught;
        }
      }
    }
    throw new Error("Could not allocate a unique public job code.");
  }

  async cancel(rawToken: string, providerOrderId: string) {
    const draft = await this.requireDraft(rawToken);
    const payment =
      await this.payments.findPaymentByProviderOrderId(providerOrderId);
    if (!payment || payment.orderId !== draft.orderId)
      throw new PaymentError("PAYMENT_ORDER_MISMATCH");
    if (payment.status === "PAID")
      throw new PaymentError("PAYMENT_STATE_INVALID");
    if (payment.status === "CANCELLED" && draft.deleteAfterMs) {
      return {
        status: "PAYMENT_CANCELLED" as const,
        retainedUntil: new Date(draft.deleteAfterMs).toISOString(),
      };
    }
    if (!["CREATED", "PENDING"].includes(payment.status))
      throw new PaymentError("PAYMENT_STATE_INVALID");
    const retainedUntilMs =
      this.now() + FAILED_OR_CANCELLED_PAYMENT_RETENTION_MS;
    await this.payments.cancelPayment({
      paymentId: payment.id,
      nowMs: this.now(),
      retainedUntilMs,
    });
    return {
      status: "PAYMENT_CANCELLED" as const,
      retainedUntil: new Date(retainedUntilMs).toISOString(),
    };
  }

  private async successData(
    payment: PaymentRecord,
    rawTrackingToken: string,
  ): Promise<CustomerPaymentSuccessData> {
    if (!payment.publicJobCode)
      throw new Error("Paid payment is missing a public job code.");
    const tracking = await this.tracking.attachToVerifiedOrder(
      payment.orderId,
      rawTrackingToken,
    );
    return {
      jobCode: payment.publicJobCode,
      amountPaidPaise: payment.amountPaise,
      currency: payment.currency,
      status: "QUEUED",
      message: "Payment verified. Your print job is queued.",
      trackingToken: tracking.rawToken,
      trackingExpiresAt: tracking.expiresAt,
    };
  }
}
