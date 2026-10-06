/* eslint-disable */
import type { D1PrintingRepository } from "./repository";

export class QueueController {
  constructor(private readonly printingRepo: D1PrintingRepository) {}

  async clearWaitingQueue(nowMs: number): Promise<{ clearedCount: number; skippedCount: number; message: string }> {
    const db = (this.printingRepo as unknown as { db: any }).db;
    
    // Batch to get counts and perform update in one roundtrip
    const batchResult = await db.batch([
      db.prepare(
        `UPDATE orders SET status = 'CANCELLED', updated_at_ms = ? 
         WHERE status = 'QUEUED' AND cleanup_state = 'ACTIVE'`
      ).bind(nowMs),
      db.prepare(
        `SELECT COUNT(*) as count FROM orders 
         WHERE status IN ('CLAIMED', 'SPOOLING', 'PRINTING', 'PRINT_BLOCKED', 'COMPLETION_UNKNOWN') 
         AND cleanup_state = 'ACTIVE'`
      )
    ]);

    const clearedCount = batchResult[0].meta.changes;
    const skippedCount = batchResult[1].results[0].count;

    return {
      clearedCount,
      skippedCount,
      message: `Cleared ${clearedCount} waiting orders. ${skippedCount} active/uncertain orders skipped.`
    };
  }

  async removeFromQueue(orderId: string, nowMs: number): Promise<{ message: string }> {
    const db = (this.printingRepo as unknown as { db: any }).db;

    const result = await db.prepare(
      `UPDATE orders SET status = 'CANCELLED', updated_at_ms = ? 
       WHERE id = ? AND status = 'QUEUED' AND cleanup_state = 'ACTIVE'`
    ).bind(nowMs, orderId).run();

    if (result.meta.changes !== 1) {
      throw new Error("ORDER_CANNOT_BE_REMOVED");
    }

    return { message: "Order safely removed from queue." };
  }
}
