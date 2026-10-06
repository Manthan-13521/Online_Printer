import type {
  AdminCleanupPreviewData,
  AdminCleanupRunData,
  CleanupScope,
} from "@printgo/api-contract";

import type { D1CleanupRepository } from "./repository";

const BATCH_LIMIT = 5;
const MINUTE_MS = 60_000;
const SEARCH_WINDOW_MINUTES = 8 * 24 * 60;

export function isOwnedUploadKey(key: string, orderId: string): boolean {
  const parts = key.split("/");
  const file = parts.at(-1) ?? "";
  if (!/^[0-9a-f-]{36}\.pdf$/iu.test(file)) return false;
  if (parts.length === 3) return parts[0] === "uploads" && parts[1] === orderId;
  return (
    parts.length === 5 &&
    parts[0] === "uploads" &&
    /^\d{4}$/u.test(parts[1] ?? "") &&
    /^(?:0[1-9]|1[0-2])$/u.test(parts[2] ?? "") &&
    parts[3] === orderId
  );
}

export class CleanupRequestError extends Error {
  constructor(
    readonly code:
      | "INVALID_CLEANUP_SCOPE"
      | "INVALID_CLEANUP_CONFIRMATION"
      | "CLEANUP_RUN_NOT_FOUND",
  ) {
    super(code);
    this.name = "CleanupRequestError";
  }
}

function zonedHourMinute(epochMs: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(epochMs));
  const hour = parts.find((part) => part.type === "hour")?.value;
  const minute = parts.find((part) => part.type === "minute")?.value;
  if (!hour || !minute) throw new RangeError("Invalid timezone result");
  return `${hour}:${minute}`;
}

function zonedDate(epochMs: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(epochMs));
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) throw new RangeError("Invalid timezone result");
  return `${year}-${month}-${day}`;
}

export function nextDailyOccurrenceMs(
  nowMs: number,
  localTime: string,
  timezone: string,
  excludedLocalDate?: string,
): number {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(localTime)) {
    throw new RangeError("Invalid daily cleanup time");
  }
  // Intl validates the IANA zone. Scanning real UTC minutes handles offset
  // changes and skipped/repeated local times without maintaining timezone data.
  zonedHourMinute(nowMs, timezone);
  const firstMinute = Math.floor(nowMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  for (let offset = 0; offset < SEARCH_WINDOW_MINUTES; offset++) {
    const candidate = firstMinute + offset * MINUTE_MS;
    if (
      zonedHourMinute(candidate, timezone) === localTime &&
      (!excludedLocalDate ||
        zonedDate(candidate, timezone) !== excludedLocalDate)
    )
      return candidate;
  }
  throw new RangeError("Could not resolve the next daily cleanup time");
}

export class CleanupService {
  constructor(
    private readonly repository: D1CleanupRepository,
    private readonly bucket: R2Bucket,
    private readonly now: () => number = Date.now,
  ) {}

  preview(scope: CleanupScope): Promise<AdminCleanupPreviewData> {
    return this.repository.preview(scope, this.now());
  }

  async requestAdminRun(
    scope: CleanupScope,
    adminId: string,
    confirmation: string,
  ): Promise<AdminCleanupRunData> {
    if (scope !== "ALL_COMPLETED" && scope !== "ALL_PRINT_DATA") {
      throw new CleanupRequestError("INVALID_CLEANUP_SCOPE");
    }
    const required = scope === "ALL_COMPLETED" ? "FREE PRINTED" : "FREE ALL";
    if (confirmation !== required) {
      throw new CleanupRequestError("INVALID_CLEANUP_CONFIRMATION");
    }
    const nowMs = this.now();
    const preview = await this.repository.preview(scope, nowMs);
    const runId = crypto.randomUUID();
    await this.repository.createRun({
      id: runId,
      scope,
      source: "ADMIN",
      adminId,
      preview,
      nowMs,
    });
    // Also clear any legacy retained_order_history rows from previous cleanup runs.
    await this.repository.purgeAllHistory();
    await this.processRun(runId, scope, 10);
    const run = await this.repository.getRun(runId);
    if (!run) throw new CleanupRequestError("CLEANUP_RUN_NOT_FOUND");
    await this.repository.recordCleanupResult(run, this.now());
    return run;
  }

  async getRun(runId: string): Promise<AdminCleanupRunData> {
    const run = await this.repository.getRun(runId);
    if (!run) throw new CleanupRequestError("CLEANUP_RUN_NOT_FOUND");
    return run;
  }

  private async processRun(
    runId: string,
    scope: CleanupScope,
    maxBatches = 1,
  ): Promise<void> {
    for (let batchIdx = 0; batchIdx < maxBatches; batchIdx++) {
      const nowMs = this.now();
      const batch = await this.repository.claimBatch(
        runId,
        scope,
        nowMs,
        BATCH_LIMIT,
      );
      if (batch.length === 0) break;
      for (const candidate of batch) {
        try {
          if (
            candidate.objectKeys.some(
              (key) => !isOwnedUploadKey(key, candidate.orderId),
            )
          ) {
            throw new Error("Cleanup candidate contains an invalid object key");
          }
          if (candidate.objectKeys.length > 0) {
            await this.bucket.delete(candidate.objectKeys);
          }
          await this.repository.purgeOrder(runId, candidate, this.now());
        } catch (caught) {
          await this.repository.recordFailure(
            runId,
            candidate.orderId,
            caught instanceof Error ? caught.message : "Cleanup failed",
            this.now(),
          );
        }
      }
    }
    await this.repository.finishIfDrained(runId, scope, this.now());
  }

  private async createScheduledRun(
    scope: Extract<CleanupScope, "EXPIRED_UNPAID" | "COMPLETED_DUE">,
  ): Promise<void> {
    const nowMs = this.now();
    // Do not repeatedly rescan and recount the same due rows while an existing
    // run is pending, active, or backing off after an external R2 failure.
    if (await this.repository.hasOpenRun(scope, "SCHEDULED")) return;
    // The full preview is needed only when a run will actually be created.
    // This indexed existence probe keeps the normal empty cron path bounded.
    if (!(await this.repository.hasCandidates(scope, nowMs))) return;
    const preview = await this.repository.preview(scope, nowMs);
    if (preview.orders === 0) return;
    await this.repository.createRun({
      id: crypto.randomUUID(),
      scope,
      source: "SCHEDULED",
      preview,
      nowMs,
      deduplicate: true,
    });
  }

  private async scheduleDailyRun(): Promise<void> {
    const settings = await this.repository.dailySettings();
    if (!settings.enabled) return;
    const nowMs = this.now();
    if (settings.nextAtMs === null) {
      await this.repository.advanceDailySchedule(
        null,
        nextDailyOccurrenceMs(nowMs, settings.time, settings.timezone),
        nowMs,
      );
      return;
    }
    if (settings.nextAtMs > nowMs) return;
    const next = nextDailyOccurrenceMs(
      nowMs,
      settings.time,
      settings.timezone,
      zonedDate(settings.nextAtMs, settings.timezone),
    );
    if (
      !(await this.repository.advanceDailySchedule(
        settings.nextAtMs,
        next,
        nowMs,
      ))
    )
      return;
    const preview = await this.repository.preview("ALL_PRINT_DATA", nowMs);
    await this.repository.createRun({
      id: crypto.randomUUID(),
      scope: "ALL_PRINT_DATA",
      source: "DAILY",
      preview,
      nowMs,
      deduplicate: true,
    });
  }

  async runScheduled(): Promise<AdminCleanupRunData | null> {
    await this.repository.purgeStaleRetainedRecords(this.now());
    await this.createScheduledRun("EXPIRED_UNPAID");
    await this.createScheduledRun("COMPLETED_DUE");
    await this.scheduleDailyRun();
    const next = await this.repository.nextRunnableRun(this.now());
    if (!next) return null;
    await this.processRun(next.id, next.scope);
    const run = await this.repository.getRun(next.id);
    if (
      run &&
      (run.deletedOrders > 0 ||
        next.source === "DAILY" ||
        run.status === "COMPLETED")
    ) {
      await this.repository.recordCleanupResult(run, this.now());
    }
    return run;
  }
}
