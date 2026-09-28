import { COMPLETED_CUSTOMER_PII_PURGE_MS } from "@printgo/domain";
import type { RetentionRepository, RetentionStats } from "./repository";

export interface CleanupResult {
  dryRun: boolean;
  timestampMs: number;
  stats: RetentionStats;
  processedUploads: number;
  deletedUploads: number;
  failedUploads: number;
  purgedPiiCount: number;
}

export class RetentionService {
  constructor(
    private readonly repository: RetentionRepository,
    private readonly r2Bucket: R2Bucket,
    private readonly now: () => number = Date.now,
  ) {}

  async getStats(): Promise<RetentionStats> {
    return this.repository.getRetentionStats(this.now());
  }

  async runCleanup(options?: {
    batchLimit?: number;
    dryRun?: boolean;
  }): Promise<CleanupResult> {
    const nowMs = this.now();
    const batchLimit = Math.max(1, Math.min(options?.batchLimit ?? 50, 100));
    const dryRun = options?.dryRun ?? false;

    const stats = await this.repository.getRetentionStats(nowMs);
    const expiredUploads = await this.repository.findExpiredUploads(
      nowMs,
      batchLimit,
    );
    const piiCutoffMs = nowMs - COMPLETED_CUSTOMER_PII_PURGE_MS;
    const piiCandidates = await this.repository.findPiiPurgeCandidates(
      piiCutoffMs,
      batchLimit,
    );

    if (dryRun) {
      return {
        dryRun: true,
        timestampMs: nowMs,
        stats,
        processedUploads: expiredUploads.length,
        deletedUploads: 0,
        failedUploads: 0,
        purgedPiiCount: 0,
      };
    }

    let deletedUploads = 0;
    let failedUploads = 0;

    // 1. Process expired PDF deletions in R2
    for (const upload of expiredUploads) {
      const locked = await this.repository.markUploadDeletePending(
        upload.id,
        nowMs,
      );
      if (!locked) {
        // Already picked up or deleted by overlapping execution
        continue;
      }

      try {
        // Direct idempotent R2 deletion (no prior HEAD/LIST)
        await this.r2Bucket.delete(upload.r2ObjectKey);
        await this.repository.recordUploadDeleted(
          upload.id,
          upload.orderId,
          nowMs,
        );
        deletedUploads++;
      } catch (err) {
        failedUploads++;
        const errorMessage =
          err instanceof Error ? err.message : "R2_DELETE_ERROR";
        await this.repository.recordUploadDeleteFailed(
          upload.id,
          errorMessage,
          nowMs,
        );
      }
    }

    // 2. Process customer PII purge for orders completed >= 5 hours ago
    let purgedPiiCount = 0;
    for (const order of piiCandidates) {
      const purged = await this.repository.purgeOrderPii(order.id, nowMs);
      if (purged) {
        purgedPiiCount++;
      }
    }

    return {
      dryRun: false,
      timestampMs: nowMs,
      stats,
      processedUploads: expiredUploads.length,
      deletedUploads,
      failedUploads,
      purgedPiiCount,
    };
  }
}
