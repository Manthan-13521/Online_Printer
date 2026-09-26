/* eslint-disable @typescript-eslint/unbound-method -- Vitest inspects method mocks without invoking them. */

import { describe, expect, it, vi } from "vitest";

import type { PrintJobStatus, PrinterAdapter } from "./printer-adapter";
import { monitorSpoolJob } from "./spool-monitor";

function createMockAdapter(statusSequence: PrintJobStatus[]): PrinterAdapter {
  let callCount = 0;
  return {
    listPrinters: vi.fn(),
    getCapabilities: vi.fn(),
    getStatus: vi.fn(),
    submitPdfJob: vi.fn(),
    getJobStatus: vi.fn(() => {
      const idx = Math.min(callCount, statusSequence.length - 1);
      callCount += 1;
      return Promise.resolve(statusSequence[idx]!);
    }),
    cancelJob: vi.fn(),
  };
}

describe("monitorSpoolJob", () => {
  it("observes queued -> printing -> completed/removed successfully", async () => {
    const adapter = createMockAdapter([
      { state: "QUEUED", spoolJobId: "job-1" },
      { state: "PRINTING", spoolJobId: "job-1" },
      { state: "COMPLETED_OR_REMOVED", spoolJobId: "job-1" },
    ]);

    const result = await monitorSpoolJob(adapter, "Canon MF4700", "job-1", {
      pollIntervalMs: 1,
      maxWaitMs: 100,
    });

    expect(result.state).toBe("COMPLETED_OR_REMOVED");
    expect(result.spoolJobId).toBe("job-1");
  });

  it("CRITICAL RULE: stops on BLOCKED (paper out) and NEVER resubmits", async () => {
    const adapter = createMockAdapter([
      { state: "QUEUED", spoolJobId: "job-2" },
      {
        state: "BLOCKED",
        spoolJobId: "job-2",
        failureCode: "PAPER_OUT",
        message: "Out of paper",
      },
    ]);

    const result = await monitorSpoolJob(adapter, "Canon MF4700", "job-2", {
      pollIntervalMs: 1,
      maxWaitMs: 100,
    });

    // Must be BLOCKED, not FAILED
    expect(result.state).toBe("BLOCKED");
    expect(result.failureCode).toBe("PAPER_OUT");
    expect(result.message).toBe("Out of paper");
    // Verify submit was never called during monitoring
    expect(adapter.submitPdfJob).not.toHaveBeenCalled();
  });

  it("CRITICAL RULE: stops on BLOCKED (offline) without resubmission", async () => {
    const adapter = createMockAdapter([
      {
        state: "BLOCKED",
        spoolJobId: "job-3",
        failureCode: "OFFLINE",
        message: "Printer offline",
      },
    ]);

    const result = await monitorSpoolJob(adapter, "Canon MF4700", "job-3", {
      pollIntervalMs: 1,
      maxWaitMs: 100,
    });

    expect(result.state).toBe("BLOCKED");
    expect(result.failureCode).toBe("OFFLINE");
    expect(adapter.submitPdfJob).not.toHaveBeenCalled();
  });

  it("stops on fatal FAILED spooler status", async () => {
    const adapter = createMockAdapter([
      {
        state: "FAILED",
        spoolJobId: "job-4",
        failureCode: "PRINTER_ERROR",
        message: "Fatal spooler error",
      },
    ]);

    const result = await monitorSpoolJob(adapter, "Canon MF4700", "job-4", {
      pollIntervalMs: 1,
      maxWaitMs: 100,
    });

    expect(result.state).toBe("FAILED");
    expect(result.failureCode).toBe("PRINTER_ERROR");
  });

  it("handles timeout gracefully without marking job as failed", async () => {
    // Spooler keeps reporting PRINTING until timeout
    const adapter = createMockAdapter([
      { state: "PRINTING", spoolJobId: "job-5" },
    ]);

    const result = await monitorSpoolJob(adapter, "Canon MF4700", "job-5", {
      pollIntervalMs: 5,
      maxWaitMs: 20,
    });

    // Should still report active PRINTING, NOT FAILED
    expect(result.state).toBe("PRINTING");
    expect(result.spoolJobId).toBe("job-5");
  });
});
