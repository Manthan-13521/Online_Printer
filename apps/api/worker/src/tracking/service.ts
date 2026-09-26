import type {
  CustomerFileRetentionStatus,
  CustomerSafeTimelineEvent,
  CustomerTrackingData,
} from "@printgo/api-contract";
import { hashSessionToken } from "@printgo/auth";
import {
  CUSTOMER_TRACKING_LIFETIME_MS,
  toCustomerOrderStatus,
} from "@printgo/domain";

import type {
  CustomerTrackingRecord,
  TrackingEventRecord,
  TrackingRepository,
} from "./repository";

export type TrackingErrorCode =
  "TRACKING_NOT_FOUND" | "TRACKING_ACCESS_CONFLICT";

export class TrackingError extends Error {
  constructor(readonly code: TrackingErrorCode) {
    super(code);
    this.name = "TrackingError";
  }
}

const TRACKING_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const JOB_CODE_PATTERN = /^PG-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/u;

function fileRetentionStatus(
  storageStatus: CustomerTrackingRecord["storageStatus"],
): CustomerFileRetentionStatus {
  if (storageStatus === "DELETED") return "DELETED";
  if (["EXPIRED", "DELETE_PENDING", "DELETE_FAILED"].includes(storageStatus)) {
    return "DELETION_PENDING";
  }
  return "TEMPORARILY_RETAINED";
}

function safeTimeline(
  events: TrackingEventRecord[],
): CustomerSafeTimelineEvent[] {
  const timeline: CustomerSafeTimelineEvent[] = [];
  for (const event of events) {
    if (event.eventType === "PAYMENT_VERIFIED") {
      if (!timeline.some((item) => item.status === "PAYMENT_RECEIVED")) {
        timeline.push({
          status: "PAYMENT_RECEIVED",
          label: "Payment received",
          occurredAt: new Date(event.createdAtMs).toISOString(),
        });
      }
      continue;
    }
    if (!event.toStatus) continue;
    const customer = toCustomerOrderStatus(event.toStatus);
    if (timeline.at(-1)?.status === customer.code) continue;
    timeline.push({
      status: customer.code,
      label: customer.label,
      occurredAt: new Date(event.createdAtMs).toISOString(),
    });
  }
  return timeline;
}

export class TrackingService {
  constructor(
    private readonly tracking: TrackingRepository,
    private readonly now: () => number = Date.now,
  ) {}

  async attachToVerifiedOrder(orderId: string, rawToken: string) {
    if (!TRACKING_TOKEN_PATTERN.test(rawToken)) {
      throw new TrackingError("TRACKING_ACCESS_CONFLICT");
    }
    const tokenHash = await hashSessionToken(rawToken);
    let authorization = await this.tracking.findAuthorization(orderId);
    if (!authorization?.jobCode) {
      throw new TrackingError("TRACKING_ACCESS_CONFLICT");
    }
    if (!authorization.tokenHash) {
      const createdAtMs = this.now();
      await this.tracking.createAuthorization({
        orderId,
        tokenHash,
        createdAtMs,
        expiresAtMs: createdAtMs + CUSTOMER_TRACKING_LIFETIME_MS,
      });
      authorization = await this.tracking.findAuthorization(orderId);
    }
    if (
      !authorization?.tokenHash ||
      authorization.tokenHash !== tokenHash ||
      authorization.createdAtMs === null ||
      authorization.expiresAtMs === null
    ) {
      throw new TrackingError("TRACKING_ACCESS_CONFLICT");
    }
    return {
      rawToken,
      expiresAt: new Date(authorization.expiresAtMs).toISOString(),
    };
  }

  async get(
    jobCodeInput: string,
    rawToken: string,
  ): Promise<CustomerTrackingData> {
    const jobCode = jobCodeInput.trim().toUpperCase();
    if (
      !JOB_CODE_PATTERN.test(jobCode) ||
      !TRACKING_TOKEN_PATTERN.test(rawToken)
    ) {
      throw new TrackingError("TRACKING_NOT_FOUND");
    }
    const tokenHash = await hashSessionToken(rawToken);
    const order = await this.tracking.findByCredential(jobCode, tokenHash);
    if (!order || order.trackingExpiresAtMs <= this.now()) {
      throw new TrackingError("TRACKING_NOT_FOUND");
    }
    const status = toCustomerOrderStatus(order.orderStatus);
    return {
      jobCode: order.jobCode,
      customerName: order.customerName,
      paymentStatus: "PAYMENT_RECEIVED",
      orderStatus: status.code,
      statusLabel: status.label,
      statusMessage: status.message,
      submittedAt: new Date(order.submittedAtMs).toISOString(),
      paidAt: new Date(order.paidAtMs).toISOString(),
      printSummary: {
        selectedPages: order.selectedPages,
        copies: order.copies,
        paperSize: order.paperSize,
        colorMode: order.colorMode,
        sides: order.sides,
      },
      amountPaidPaise: order.amountPaidPaise,
      currency: order.currency,
      instructions: order.instructions,
      fileRetentionStatus: fileRetentionStatus(order.storageStatus),
      timeline: safeTimeline(
        await this.tracking.listSafeTimeline(order.orderId),
      ),
      trackingExpiresAt: new Date(order.trackingExpiresAtMs).toISOString(),
    };
  }
}
