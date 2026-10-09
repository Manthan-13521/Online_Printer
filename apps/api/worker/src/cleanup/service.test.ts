import { describe, expect, it, vi } from "vitest";

import type { D1CleanupRepository } from "./repository";
import {
  CleanupService,
  isOwnedUploadKey,
  nextDailyOccurrenceMs,
} from "./service";

describe("daily cleanup scheduling", () => {
  it("resolves the next configured local IANA time instead of treating it as UTC", () => {
    const now = Date.parse("2026-09-30T17:00:00.000Z");
    expect(nextDailyOccurrenceMs(now, "23:30", "Asia/Kolkata")).toBe(
      Date.parse("2026-09-30T18:00:00.000Z"),
    );
  });

  it("moves to the following day after today's local time has passed", () => {
    const now = Date.parse("2026-09-30T18:01:00.000Z");
    expect(nextDailyOccurrenceMs(now, "23:30", "Asia/Kolkata")).toBe(
      Date.parse("2026-10-01T18:00:00.000Z"),
    );
  });

  it("rejects malformed times and unknown timezones", () => {
    expect(() => nextDailyOccurrenceMs(0, "29:30", "Asia/Kolkata")).toThrow();
    expect(() => nextDailyOccurrenceMs(0, "23:30", "Mars/Olympus")).toThrow();
  });

  it("does not schedule the repeated DST wall-clock minute twice", () => {
    const firstOccurrence = Date.parse("2026-11-01T05:30:00.000Z");
    expect(
      nextDailyOccurrenceMs(
        firstOccurrence + 60_000,
        "01:30",
        "America/New_York",
        "2026-11-01",
      ),
    ).toBe(Date.parse("2026-11-02T06:30:00.000Z"));
  });
});

describe("cleanup object ownership", () => {
  const orderId = "10000000-0000-4000-8000-000000000001";
  const fileId = "20000000-0000-4000-8000-000000000002";

  it("accepts current and legacy database-owned upload key formats only", () => {
    expect(isOwnedUploadKey(`uploads/${orderId}/${fileId}.pdf`, orderId)).toBe(
      true,
    );
    expect(
      isOwnedUploadKey(`uploads/2026/09/${orderId}/${fileId}.pdf`, orderId),
    ).toBe(true);
    expect(
      isOwnedUploadKey(`uploads/${orderId}/my-document.pdf`, orderId),
    ).toBe(true);
    expect(isOwnedUploadKey(`branding/${fileId}.webp`, orderId)).toBe(false);
    expect(
      isOwnedUploadKey(`uploads/2026/09/other/${fileId}.pdf`, orderId),
    ).toBe(false);
    expect(isOwnedUploadKey(`uploads/${orderId}/../secret.pdf`, orderId)).toBe(
      false,
    );
    expect(isOwnedUploadKey(`uploads/${orderId}/file.exe`, orderId)).toBe(
      false,
    );
  });
});

describe("scheduled cleanup cost gates", () => {
  const bucket = { delete: vi.fn() } as unknown as R2Bucket;

  it("does not recount candidates while scheduled runs remain open", async () => {
    const hasOpenRun = vi.fn().mockResolvedValue(true);
    const hasCandidates = vi.fn();
    const preview = vi.fn();
    const repository = {
      hasOpenRun,
      hasCandidates,
      preview,
      dailySettings: vi.fn().mockResolvedValue({
        enabled: false,
        time: "23:30",
        timezone: "Asia/Kolkata",
        nextAtMs: null,
      }),
      nextRunnableRun: vi.fn().mockResolvedValue(null),
    } as unknown as D1CleanupRepository;

    await new CleanupService(repository, bucket, () => 2_000).runScheduled();

    expect(hasOpenRun).toHaveBeenCalledTimes(2);
    expect(hasCandidates).not.toHaveBeenCalled();
    expect(preview).not.toHaveBeenCalled();
  });

  it("uses an existence probe before an empty scheduled preview", async () => {
    const hasCandidates = vi.fn().mockResolvedValue(false);
    const preview = vi.fn();
    const repository = {
      hasOpenRun: vi.fn().mockResolvedValue(false),
      hasCandidates,
      preview,
      dailySettings: vi.fn().mockResolvedValue({
        enabled: false,
        time: "23:30",
        timezone: "Asia/Kolkata",
        nextAtMs: null,
      }),
      nextRunnableRun: vi.fn().mockResolvedValue(null),
    } as unknown as D1CleanupRepository;

    await new CleanupService(repository, bucket, () => 2_000).runScheduled();

    expect(hasCandidates).toHaveBeenCalledTimes(2);
    expect(preview).not.toHaveBeenCalled();
  });

  it("filters out invalid object keys, deletes valid keys, and purges the order without throwing", async () => {
    const orderId = "51000000-0000-4000-8000-000000000001";
    const validFileId = "52000000-0000-4000-8000-000000000001";
    const validKey = `uploads/${orderId}/${validFileId}.pdf`;
    const invalidKey = "uploads/foreign-order/bad-file.pdf";
    const deleteSpy = vi.fn().mockResolvedValue(undefined);
    const mockBucket = { delete: deleteSpy } as unknown as R2Bucket;

    const claimBatch = vi.fn().mockResolvedValue([
      {
        orderId,
        objectKeys: [validKey, invalidKey],
        fileCount: 2,
        bytes: 1000,
      },
    ]);
    const purgeOrder = vi.fn().mockResolvedValue(undefined);
    const finishIfDrained = vi.fn().mockResolvedValue(true);
    const recordFailure = vi.fn();

    const repository = {
      claimBatch,
      purgeOrder,
      finishIfDrained,
      recordFailure,
      getRun: vi.fn().mockResolvedValue({
        runId: "run-1",
        scope: "COMPLETED_DUE",
        status: "COMPLETED",
        orders: 1,
        files: 2,
        bytes: 1000,
        active: 0,
        deletedOrders: 1,
        deletedFiles: 1,
        deletedBytes: 500,
        activeSkipped: 0,
        failures: 0,
        lastError: null,
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      }),
      recordCleanupResult: vi.fn(),
      dailySettings: vi.fn().mockResolvedValue({ enabled: false }),
      nextRunnableRun: vi.fn().mockResolvedValue({
        id: "run-1",
        scope: "COMPLETED_DUE",
        source: "SCHEDULED",
      }),
      hasOpenRun: vi.fn().mockResolvedValue(true),
    } as unknown as D1CleanupRepository;

    const service = new CleanupService(repository, mockBucket, () => 2_000);
    // Process scheduled run which calls processRun
    await service.runScheduled();

    // Verify valid keys were deleted, and deleteSpy was called ONLY with validKey
    expect(deleteSpy).toHaveBeenCalledWith([validKey]);
    // Verify purgeOrder was called
    expect(purgeOrder).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ orderId }),
      2_000,
    );
    // Verify recordFailure was NEVER called
    expect(recordFailure).not.toHaveBeenCalled();
  });

  it("calls purgeExpiredPayments, recoverOrphanedClaims and purgeOldDiagnosticLogs during scheduled runs", async () => {
    const recoverOrphanedClaims = vi.fn().mockResolvedValue(0);
    const purgeExpiredPayments = vi.fn().mockResolvedValue({
      deletedPayments: 2,
      deletedEvents: 3,
      deletedRetainedPayments: 1,
      deletedRetainedEvents: 1,
    });
    const purgeOldDiagnosticLogs = vi.fn().mockResolvedValue({
      deletedAuditLogs: 5,
      deletedCleanupRunItems: 2,
      deletedCleanupRuns: 1,
    });
    const repository = {
      recoverOrphanedClaims,
      purgeExpiredPayments,
      purgeOldDiagnosticLogs,
      hasOpenRun: vi.fn().mockResolvedValue(true),
      dailySettings: vi.fn().mockResolvedValue({ enabled: false }),
      nextRunnableRun: vi.fn().mockResolvedValue(null),
    } as unknown as D1CleanupRepository;

    const service = new CleanupService(repository, bucket, () => 5_000);
    await service.runScheduled();

    expect(recoverOrphanedClaims).toHaveBeenCalledWith(5_000);
    expect(purgeExpiredPayments).toHaveBeenCalledWith(5_000);
    expect(purgeOldDiagnosticLogs).toHaveBeenCalledWith(5_000);
  });
});
