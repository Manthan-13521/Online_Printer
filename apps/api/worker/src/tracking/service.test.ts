import { describe, expect, it, vi } from "vitest";

import { hashSessionToken } from "@printgo/auth";
import { CUSTOMER_TRACKING_LIFETIME_MS } from "@printgo/domain";

import type {
  CustomerTrackingRecord,
  TrackingAuthorizationRecord,
  TrackingRepository,
} from "./repository";
import { TrackingService } from "./service";

/* eslint-disable @typescript-eslint/unbound-method -- Vitest inspects method mocks without invoking them. */

const now = Date.UTC(2026, 8, 26);
const orderId = "50000000-0000-4000-8000-000000000001";
const token = "T".repeat(43);

const trackingOrder: CustomerTrackingRecord = {
  orderId,
  jobCode: "PG-ABC234",
  customerName: "Rahul",
  orderStatus: "QUEUED",
  submittedAtMs: now - 60_000,
  updatedAtMs: now,
  paidAtMs: now,
  selectedPages: "1-12",
  copies: 2,
  paperSize: "A4",
  colorMode: "BW",
  sides: "DOUBLE",
  amountPaidPaise: 4_200,
  currency: "INR",
  instructions: "Staple after printing",
  storageStatus: "UPLOADED",
  deleteAfterMs: null,
  piiPurgedAtMs: null,
  trackingExpiresAtMs: now + CUSTOMER_TRACKING_LIFETIME_MS,
};

function repository(options?: {
  authorization?: TrackingAuthorizationRecord | null;
  trackingOrder?: CustomerTrackingRecord | null;
}): TrackingRepository {
  let authorization = options?.authorization ?? {
    orderId,
    jobCode: "PG-ABC234",
    orderStatus: "QUEUED" as const,
    tokenHash: null,
    createdAtMs: null,
    expiresAtMs: null,
  };
  return {
    findAuthorization: vi.fn(() => Promise.resolve(authorization)),
    createAuthorization: vi.fn(
      (input: Parameters<TrackingRepository["createAuthorization"]>[0]) => {
        if (!authorization || authorization.tokenHash)
          return Promise.resolve(false);
        authorization = {
          ...authorization,
          tokenHash: input.tokenHash,
          createdAtMs: input.createdAtMs,
          expiresAtMs: input.expiresAtMs,
        };
        return Promise.resolve(true);
      },
    ),
    findByCredential: vi.fn(async (jobCode: string, tokenHash: string) => {
      const expected = await hashSessionToken(token);
      const record = options?.trackingOrder ?? trackingOrder;
      return jobCode === record?.jobCode && tokenHash === expected
        ? record
        : null;
    }),
    listSafeTimeline: vi.fn(() =>
      Promise.resolve([
        {
          eventType: "PAYMENT_VERIFIED",
          toStatus: "PAID" as const,
          createdAtMs: now,
        },
        {
          eventType: "QUEUED",
          toStatus: "QUEUED" as const,
          createdAtMs: now + 1,
        },
      ]),
    ),
  };
}

describe("TrackingService", () => {
  it("stores only the token hash and reuses the same authorization", async () => {
    const tracking = repository();
    const service = new TrackingService(tracking, () => now);
    const first = await service.attachToVerifiedOrder(orderId, token);
    const second = await service.attachToVerifiedOrder(orderId, token);
    expect(first).toEqual(second);
    expect(first.rawToken).toBe(token);
    expect(first.expiresAt).toBe(
      new Date(now + CUSTOMER_TRACKING_LIFETIME_MS).toISOString(),
    );
    expect(tracking.createAuthorization).toHaveBeenCalledOnce();
    const stored = vi.mocked(tracking.createAuthorization).mock.calls[0]?.[0];
    expect(stored?.tokenHash).toBe(await hashSessionToken(token));
    expect(stored?.tokenHash).not.toBe(token);
    expect(JSON.stringify(stored)).not.toContain(token);
  });

  it("does not replace an existing credential with a conflicting token", async () => {
    const tracking = repository({
      authorization: {
        orderId,
        jobCode: "PG-ABC234",
        orderStatus: "QUEUED",
        tokenHash: await hashSessionToken(token),
        createdAtMs: now,
        expiresAtMs: now + CUSTOMER_TRACKING_LIFETIME_MS,
      },
    });
    await expect(
      new TrackingService(tracking, () => now).attachToVerifiedOrder(
        orderId,
        "X".repeat(43),
      ),
    ).rejects.toEqual(
      expect.objectContaining({ code: "TRACKING_ACCESS_CONFLICT" }),
    );
    expect(tracking.createAuthorization).not.toHaveBeenCalled();
  });

  it("accepts the matching token and returns only customer-safe fields", async () => {
    const result = await new TrackingService(repository(), () => now).get(
      "pg-abc234",
      token,
    );
    expect(result).toEqual(
      expect.objectContaining({
        jobCode: "PG-ABC234",
        paymentStatus: "PAYMENT_RECEIVED",
        orderStatus: "WAITING_TO_PRINT",
        amountPaidPaise: 4_200,
        fileRetentionStatus: "TEMPORARILY_RETAINED",
      }),
    );
    expect(result.timeline.map((item) => item.label)).toEqual([
      "Payment received",
      "Waiting to print",
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      /orderId|r2|objectKey|providerPayment|customerPhone/iu,
    );
  });

  it("rejects wrong, cross-order, expired, and unpaid credentials generically", async () => {
    const wrong = new TrackingService(repository(), () => now);
    await expect(wrong.get("PG-ABC234", "X".repeat(43))).rejects.toEqual(
      expect.objectContaining({ code: "TRACKING_NOT_FOUND" }),
    );
    await expect(wrong.get("PG-XYZ234", token)).rejects.toEqual(
      expect.objectContaining({ code: "TRACKING_NOT_FOUND" }),
    );

    const expired = repository({
      trackingOrder: { ...trackingOrder, trackingExpiresAtMs: now },
    });
    await expect(
      new TrackingService(expired, () => now).get("PG-ABC234", token),
    ).rejects.toEqual(expect.objectContaining({ code: "TRACKING_NOT_FOUND" }));

    const unpaid = repository({ trackingOrder: null });
    vi.mocked(unpaid.findByCredential).mockResolvedValueOnce(null);
    await expect(
      new TrackingService(unpaid, () => now).get("PG-ABC234", token),
    ).rejects.toEqual(expect.objectContaining({ code: "TRACKING_NOT_FOUND" }));
  });

  it("keeps completed orders trackable after file deletion", async () => {
    const completed = repository({
      trackingOrder: {
        ...trackingOrder,
        orderStatus: "COMPLETED",
        storageStatus: "DELETED",
      },
    });
    const result = await new TrackingService(completed, () => now).get(
      "PG-ABC234",
      token,
    );
    expect(result.orderStatus).toBe("COMPLETED");
    expect(result.fileRetentionStatus).toBe("DELETED");
  });
});
