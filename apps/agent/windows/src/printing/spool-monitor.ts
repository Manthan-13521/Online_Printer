import type { PrintJobStatus, PrinterAdapter } from "./printer-adapter.js";

export interface SpoolMonitorOptions {
  pollIntervalMs?: number;
  maxWaitMs?: number;
}

/**
 * Monitors a Windows print spool job until it completes, blocks, fails, or times out.
 *
 * CRITICAL RULE: BLOCKED != FAILED.
 * If the spooler reports a recoverable blocked condition (PAPER_OUT, PAPER_JAM, OFFLINE,
 * USER_INTERVENTION), monitoring stops and returns BLOCKED.
 * The job is NOT resubmitted, preventing duplicate printing when paper is reloaded.
 */
export async function monitorSpoolJob(
  adapter: PrinterAdapter,
  printerId: string,
  spoolJobId: string,
  options?: SpoolMonitorOptions,
): Promise<PrintJobStatus> {
  const pollIntervalMs = options?.pollIntervalMs ?? 3000;
  const maxWaitMs = options?.maxWaitMs ?? 4000;
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() <= deadline) {
    const status = await adapter.getJobStatus(printerId, spoolJobId);

    // 1. Spool job completed or handed off to printer
    if (status.state === "COMPLETED_OR_REMOVED") {
      return {
        state: "COMPLETED_OR_REMOVED",
        spoolJobId,
        message:
          status.message ?? "Spool job completed and handed off to printer.",
      };
    }

    // 2. BLOCKED: Spooler requires physical attention (out of paper, jam, door open)
    // DO NOT RESUBMIT. Return BLOCKED so Admin sees real reason.
    if (status.state === "BLOCKED") {
      return {
        state: "BLOCKED",
        spoolJobId,
        failureCode: status.failureCode ?? "UNKNOWN",
        message: status.message ?? "Printer is blocked and requires attention.",
      };
    }

    // 3. FAILED: Fatal spooler error
    if (status.state === "FAILED") {
      return {
        state: "FAILED",
        spoolJobId,
        failureCode: status.failureCode ?? "PRINTER_ERROR",
        message: status.message ?? "Spooler rejected the print job.",
      };
    }

    // Wait before next spool status check
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  // Timeout reached while still in spooler: remains active
  return {
    state: "PRINTING",
    spoolJobId,
    message: "Job was accepted by spooler and is currently processing.",
  };
}
