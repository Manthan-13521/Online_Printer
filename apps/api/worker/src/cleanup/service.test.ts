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
    expect(isOwnedUploadKey(`branding/${fileId}.webp`, orderId)).toBe(false);
    expect(
      isOwnedUploadKey(`uploads/2026/09/other/${fileId}.pdf`, orderId),
    ).toBe(false);
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
});
