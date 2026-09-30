/* eslint-disable @typescript-eslint/unbound-method -- Vitest inspects method mocks without invoking them. */
import { describe, expect, it, vi } from "vitest";
import {
  COMPLETED_CUSTOMER_PII_PURGE_MS,
  COMPLETED_PDF_RETENTION_MS,
  FAILED_OR_CANCELLED_PAYMENT_RETENTION_MS,
  UNPAID_RETENTION_MS,
  UNRESOLVED_PAID_FAILURE_RETENTION_MS,
} from "@printgo/domain";
import type {
  ExpiredUploadRecord,
  PiiPurgeCandidateRecord,
  RetentionRepository,
} from "./repository";
import { RetentionService } from "./service";

function createMockRepository(
  overrides: Partial<RetentionRepository> = {},
): RetentionRepository {
  return {
    findExpiredUploads: vi.fn(() => Promise.resolve([])),
    markUploadDeletePending: vi.fn(() => Promise.resolve(true)),
    recordUploadDeleted: vi.fn(() => Promise.resolve()),
    recordUploadDeleteFailed: vi.fn(() => Promise.resolve()),
    findPiiPurgeCandidates: vi.fn(() => Promise.resolve([])),
    purgeOrderPii: vi.fn(() => Promise.resolve(true)),
    getRetentionStats: vi.fn(() =>
      Promise.resolve({
        unpaidExpired: 0,
        failedExpired: 0,
        completedPdfExpired: 0,
        unresolvedPaidExpired: 0,
        piiPurgeCandidates: 0,
        totalPendingCleanup: 0,
      }),
    ),
    ...overrides,
  };
}

function createMockR2Bucket(overrides: Partial<R2Bucket> = {}): R2Bucket {
  return {
    delete: vi.fn(() => Promise.resolve()),
    get: vi.fn(() => Promise.resolve(null)),
    put: vi.fn(() => Promise.resolve({} as R2Object)),
    head: vi.fn(() => Promise.resolve(null)),
    list: vi.fn(() =>
      Promise.resolve({ objects: [], truncated: false, delimitedPrefixes: [] }),
    ),
    ...overrides,
  } as unknown as R2Bucket;
}

describe("RetentionService — Automated Cleanup & Privacy Purge", () => {
  const baseTime = 1_000_000_000;

  it("retains unpaid upload at 9m59s and expires at 10m", () => {
    const createdAt = baseTime;
    const expiry = createdAt + UNPAID_RETENTION_MS;

    const at9m59s = expiry - 1_000;
    expect(at9m59s < expiry).toBe(true);

    const at10m = expiry;
    expect(at10m >= expiry).toBe(true);
  });

  it("retains failed payment at 29m59s and expires at 30m", () => {
    const failedAt = baseTime;
    const expiry = failedAt + FAILED_OR_CANCELLED_PAYMENT_RETENTION_MS;

    const at29m59s = expiry - 1_000;
    expect(at29m59s < expiry).toBe(true);

    const at30m = expiry;
    expect(at30m >= expiry).toBe(true);
  });

  it("retains completed print PDF at 59m59s and expires at 60m", () => {
    const completedAt = baseTime;
    const expiry = completedAt + COMPLETED_PDF_RETENTION_MS;

    const at59m59s = expiry - 1_000;
    expect(at59m59s < expiry).toBe(true);

    const at60m = expiry;
    expect(at60m >= expiry).toBe(true);
  });

  it("retains customer PII at 4h59m and purges at 5h", () => {
    const completedAt = baseTime;
    const purgeTime = completedAt + COMPLETED_CUSTOMER_PII_PURGE_MS;

    const at4h59m = purgeTime - 1_000;
    expect(at4h59m < purgeTime).toBe(true);

    const at5h = purgeTime;
    expect(at5h >= purgeTime).toBe(true);
  });

  it("retains unresolved paid failure at 23h59m and expires at 24h", () => {
    const paidAt = baseTime;
    const expiry = paidAt + UNRESOLVED_PAID_FAILURE_RETENTION_MS;

    const at23h59m = expiry - 1_000;
    expect(at23h59m < expiry).toBe(true);

    const at24h = expiry;
    expect(at24h >= expiry).toBe(true);
  });

  it("deletes expired R2 objects idempotently and updates D1 status", async () => {
    const expiredUpload: ExpiredUploadRecord = {
      id: "upload_1",
      orderId: "order_1",
      r2ObjectKey: "uploads/order_1/file.pdf",
      retentionReason: "COMPLETED",
      deleteAfterMs: baseTime - 100,
      deletionAttemptCount: 0,
    };

    const repo = createMockRepository({
      findExpiredUploads: vi.fn(() => Promise.resolve([expiredUpload])),
    });
    const r2 = createMockR2Bucket();

    const service = new RetentionService(repo, r2, () => baseTime);
    const result = await service.runCleanup();

    expect(result.processedUploads).toBe(1);
    expect(result.deletedUploads).toBe(1);
    expect(result.failedUploads).toBe(0);
    expect(result.stats).toBeNull();
    expect(repo.getRetentionStats).not.toHaveBeenCalled();
    expect(repo.markUploadDeletePending).toHaveBeenCalledWith(
      "upload_1",
      baseTime,
    );
    expect(r2.delete).toHaveBeenCalledWith("uploads/order_1/file.pdf");
    expect(repo.recordUploadDeleted).toHaveBeenCalledWith(
      "upload_1",
      "order_1",
      baseTime,
    );
  });

  it("handles R2 deletion failures gracefully without crashing", async () => {
    const expiredUpload: ExpiredUploadRecord = {
      id: "upload_err",
      orderId: "order_err",
      r2ObjectKey: "uploads/order_err/file.pdf",
      retentionReason: "UNPAID",
      deleteAfterMs: baseTime - 100,
      deletionAttemptCount: 0,
    };

    const repo = createMockRepository({
      findExpiredUploads: vi.fn(() => Promise.resolve([expiredUpload])),
    });
    const r2 = createMockR2Bucket({
      delete: vi.fn(() => Promise.reject(new Error("R2_RATE_LIMITED"))),
    });

    const service = new RetentionService(repo, r2, () => baseTime);
    const result = await service.runCleanup();

    expect(result.processedUploads).toBe(1);
    expect(result.deletedUploads).toBe(0);
    expect(result.failedUploads).toBe(1);
    expect(repo.recordUploadDeleteFailed).toHaveBeenCalledWith(
      "upload_err",
      "R2_RATE_LIMITED",
      baseTime,
    );
  });

  it("skips uploads locked by overlapping cron execution", async () => {
    const expiredUpload: ExpiredUploadRecord = {
      id: "upload_concurrent",
      orderId: "order_concurrent",
      r2ObjectKey: "uploads/order_concurrent/file.pdf",
      retentionReason: "UNPAID",
      deleteAfterMs: baseTime - 100,
      deletionAttemptCount: 0,
    };

    const repo = createMockRepository({
      findExpiredUploads: vi.fn(() => Promise.resolve([expiredUpload])),
      markUploadDeletePending: vi.fn(() => Promise.resolve(false)), // Conflict: already picked
    });
    const r2 = createMockR2Bucket();

    const service = new RetentionService(repo, r2, () => baseTime);
    const result = await service.runCleanup();

    expect(result.processedUploads).toBe(1);
    expect(result.deletedUploads).toBe(0);
    expect(r2.delete).not.toHaveBeenCalled();
    expect(repo.recordUploadDeleted).not.toHaveBeenCalled();
  });

  it("purges customer PII for eligible completed orders", async () => {
    const piiCandidate: PiiPurgeCandidateRecord = {
      id: "order_pii",
      customerName: "Rahul Sharma",
      customerPhone: "+91 98765 43210",
      completedAtMs: baseTime - COMPLETED_CUSTOMER_PII_PURGE_MS - 1_000,
    };

    const repo = createMockRepository({
      findPiiPurgeCandidates: vi.fn(() => Promise.resolve([piiCandidate])),
    });
    const r2 = createMockR2Bucket();

    const service = new RetentionService(repo, r2, () => baseTime);
    const result = await service.runCleanup();

    expect(result.purgedPiiCount).toBe(1);
    expect(repo.purgeOrderPii).toHaveBeenCalledWith("order_pii", baseTime);
  });

  it("supports dry-run mode without modifying R2 or D1", async () => {
    const expiredUpload: ExpiredUploadRecord = {
      id: "upload_dry",
      orderId: "order_dry",
      r2ObjectKey: "uploads/order_dry/file.pdf",
      retentionReason: "UNPAID",
      deleteAfterMs: baseTime - 100,
      deletionAttemptCount: 0,
    };
    const piiCandidate: PiiPurgeCandidateRecord = {
      id: "order_dry",
      customerName: "Asha",
      customerPhone: "+91 99999 88888",
      completedAtMs: baseTime - COMPLETED_CUSTOMER_PII_PURGE_MS - 100,
    };

    const repo = createMockRepository({
      findExpiredUploads: vi.fn(() => Promise.resolve([expiredUpload])),
      findPiiPurgeCandidates: vi.fn(() => Promise.resolve([piiCandidate])),
    });
    const r2 = createMockR2Bucket();

    const service = new RetentionService(repo, r2, () => baseTime);
    const result = await service.runCleanup({ dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.stats).not.toBeNull();
    expect(repo.getRetentionStats).toHaveBeenCalledTimes(1);
    expect(result.processedUploads).toBe(1);
    expect(result.deletedUploads).toBe(0);
    expect(result.purgedPiiCount).toBe(0);
    expect(r2.delete).not.toHaveBeenCalled();
    expect(repo.markUploadDeletePending).not.toHaveBeenCalled();
    expect(repo.purgeOrderPii).not.toHaveBeenCalled();
  });

  it("caps cleanup to the per-invocation free-tier query budget", async () => {
    const repo = createMockRepository();
    const r2 = createMockR2Bucket();

    const service = new RetentionService(repo, r2, () => baseTime);
    await service.runCleanup({ batchLimit: 25 });

    expect(repo.findExpiredUploads).toHaveBeenCalledWith(baseTime, 5);
    expect(repo.findPiiPurgeCandidates).toHaveBeenCalledWith(
      baseTime - COMPLETED_CUSTOMER_PII_PURGE_MS,
      5,
    );
  });
});
