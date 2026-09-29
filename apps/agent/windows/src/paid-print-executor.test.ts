/* eslint-disable @typescript-eslint/unbound-method */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentPrintJob } from "@printgo/api-contract";
import type { AgentClient } from "./agent-client.js";
import { PaidPrintExecutor } from "./paid-print-executor.js";
import { generateIdentificationSheetBuffer } from "./printing/identification-sheet.js";
import type { PrinterAdapter } from "./printing/printer-adapter.js";
import { ExecutionJournalStore } from "./storage/execution-journal.js";

const temporary: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    temporary
      .splice(0)
      .map((item) => fs.rm(item, { recursive: true, force: true })),
  );
});

const credentials = {
  agentId: "agent",
  agentSecret: "a".repeat(40),
  serverUrl: "https://print.example",
  displayName: "Agent",
};
function job(
  type: "IDENTIFICATION_SHEET" | "CUSTOMER_DOCUMENT" = "CUSTOMER_DOCUMENT",
  status: AgentPrintJob["currentStep"]["status"] = "PENDING",
): AgentPrintJob {
  const bytes = generateIdentificationSheetBuffer(
    {
      jobCode: "PG-ABC234",
      customerName: "Customer",
      maskedPhone: "******3210",
      paperSize: "A4",
      colorMode: "COLOR",
      sides: "DOUBLE",
      pageRange: "1-2",
      copies: 10,
      amountPaidPaise: 5000,
      currency: "INR",
      instructions: null,
      paidAtMs: 1_000,
    },
    { timeZone: "UTC" },
  );
  return {
    type: "PAID_PRINT_JOB",
    orderId: "order",
    attemptId: "attempt",
    claimId: "claim",
    leaseExpiresAtMs: 999_999,
    jobCode: "PG-ABC234",
    printerId: "printer-id",
    windowsPrinterName: "Exact Printer",
    download: {
      url: "https://signed.invalid/file",
      expiresAtMs: 9_999,
      expectedSizeBytes: bytes.length,
    },
    sourcePageCount: 2,
    settings: {
      pageRange: "1-2",
      copies: 10,
      paperSize: "A4",
      colorMode: "COLOR",
      sides: "DOUBLE",
    },
    identificationSheet: {
      jobCode: "PG-ABC234",
      customerName: "Customer",
      maskedPhone: "******3210",
      paperSize: "A4",
      colorMode: "COLOR",
      sides: "DOUBLE",
      pageRange: "1-2",
      copies: 10,
      amountPaidPaise: 5000,
      currency: "INR",
      instructions: null,
      paidAtMs: 1_000,
    },
    currentStep: {
      stepId: "step",
      sequenceNumber: 1,
      type,
      status,
      spoolerJobId:
        status === "SUBMITTED" || status === "BLOCKED" ? "42" : null,
    },
  };
}
function client() {
  return {
    startPrintStep: vi.fn(() => Promise.resolve({ ok: true })),
    submitPrintStep: vi.fn(() => Promise.resolve({ ok: true })),
    reportPrintStep: vi.fn(() => Promise.resolve({ ok: true })),
  } as unknown as AgentClient;
}
function adapter(): PrinterAdapter {
  return {
    listPrinters: vi.fn(),
    getCapabilities: vi.fn(),
    getStatus: vi.fn(),
    cancelJob: vi.fn(),
    submitPdfJob: vi.fn(() => Promise.resolve({ spoolJobId: "42" })),
    getJobStatus: vi.fn(() =>
      Promise.resolve({
        state: "COMPLETED_OR_REMOVED" as const,
        spoolJobId: "42",
      }),
    ),
  };
}
async function journal() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "printgo-journal-test-"),
  );
  temporary.push(root);
  return new ExecutionJournalStore(path.join(root, "journal.json"));
}

describe("PaidPrintExecutor duplicate prevention", () => {
  it("enforces exact paid document settings and all 10 copies in one submission", async () => {
    const bytes = generateIdentificationSheetBuffer(
      job().identificationSheet!,
      { timeZone: "UTC" },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(bytes, { status: 200 }))),
    );
    const api = client();
    const printer = adapter();
    await new PaidPrintExecutor(api, printer, await journal()).handle(
      credentials,
      job(),
    );
    expect(printer.submitPdfJob).toHaveBeenCalledTimes(1);
    const submission = vi.mocked(printer.submitPdfJob).mock.calls[0]?.[0];
    expect(submission?.printerId).toBe("Exact Printer");
    expect(submission?.copies).toBe(10);
    expect(submission?.settings).toMatchObject({
      printerName: "Exact Printer",
      paperSize: "A4",
      colorMode: "COLOUR",
      sides: "TWO_SIDED_LONG",
      copies: 10,
      pageRange: "1-2",
    });
    expect(api.reportPrintStep).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ status: "SUCCEEDED", spoolerJobId: "42" }),
    );
  });

  it("prints one fixed-settings ID sheet even when customer copies are 10", async () => {
    const api = client();
    const printer = adapter();
    await new PaidPrintExecutor(api, printer, await journal()).handle(
      credentials,
      job("IDENTIFICATION_SHEET"),
    );
    expect(printer.submitPdfJob).toHaveBeenCalledTimes(1);
    const submission = vi.mocked(printer.submitPdfJob).mock.calls[0]?.[0];
    expect(submission?.copies).toBe(1);
    expect(submission?.settings).toMatchObject({
      paperSize: "A4",
      colorMode: "BLACK_AND_WHITE",
      sides: "ONE_SIDED",
      copies: 1,
      pageRange: "1",
    });
  });

  it("fails closed on uncorrelated fast despool and never marks it successful", async () => {
    const api = client();
    const printer = adapter();
    vi.mocked(printer.submitPdfJob).mockResolvedValue({
      spoolJobId: "despooled-123",
      fastDespooled: true,
    });
    await new PaidPrintExecutor(api, printer, await journal()).handle(
      credentials,
      job("IDENTIFICATION_SHEET"),
    );
    expect(api.reportPrintStep).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ status: "UNCERTAIN" }),
    );
    expect(api.submitPrintStep).not.toHaveBeenCalled();
    expect(printer.getJobStatus).not.toHaveBeenCalled();
  });

  it("removes the local sheet before monitoring and immediately signals a successful next step", async () => {
    const api = client();
    const printer = adapter();
    const next = vi.fn();
    let file = "";
    vi.mocked(printer.submitPdfJob).mockImplementation((submission) => {
      file = submission.localPdfPath;
      return Promise.resolve({ spoolJobId: "42" });
    });
    vi.mocked(printer.getJobStatus).mockImplementation(async () => {
      await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
      return { state: "COMPLETED_OR_REMOVED", spoolJobId: "42" };
    });
    await new PaidPrintExecutor(
      api,
      printer,
      await journal(),
      () => undefined,
      next,
    ).handle(credentials, job("IDENTIFICATION_SHEET"));
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("reconciles a persisted spool ID after restart without submitting again", async () => {
    const api = client();
    const printer = adapter();
    const store = await journal();
    await store.save({
      orderId: "order",
      attemptId: "attempt",
      stepId: "step",
      spoolerJobId: "42",
      updatedAtMs: 1,
    });
    await new PaidPrintExecutor(api, printer, store).handle(
      credentials,
      job("CUSTOMER_DOCUMENT", "SUBMISSION_STARTED"),
    );
    expect(printer.submitPdfJob).not.toHaveBeenCalled();
    expect(api.submitPrintStep).toHaveBeenCalledTimes(1);
    expect(api.reportPrintStep).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ status: "SUCCEEDED" }),
    );
  });

  it("marks a restart uncertain when submission started but no spool identity survived", async () => {
    const api = client();
    const printer = adapter();
    await new PaidPrintExecutor(api, printer, await journal()).handle(
      credentials,
      job("CUSTOMER_DOCUMENT", "SUBMISSION_STARTED"),
    );
    expect(printer.submitPdfJob).not.toHaveBeenCalled();
    expect(api.reportPrintStep).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ status: "UNCERTAIN" }),
    );
  });

  it("retains the real spool identity across a network failure and restart", async () => {
    const api = client();
    const printer = adapter();
    const store = await journal();
    vi.mocked(api.submitPrintStep).mockRejectedValueOnce(new Error("offline"));
    vi.mocked(api.reportPrintStep).mockRejectedValueOnce(new Error("offline"));
    await new PaidPrintExecutor(api, printer, store).handle(
      credentials,
      job("IDENTIFICATION_SHEET"),
    );
    expect(await store.load()).toMatchObject({ spoolerJobId: "42" });
    await new PaidPrintExecutor(client(), printer, store).handle(
      credentials,
      job("IDENTIFICATION_SHEET", "SUBMISSION_STARTED"),
    );
    expect(printer.submitPdfJob).toHaveBeenCalledTimes(1);
    expect(await store.load()).toBeNull();
  });

  it("observes the same blocked spool job and never resubmits", async () => {
    const api = client();
    const printer = adapter();
    vi.mocked(printer.getJobStatus).mockResolvedValue({
      state: "BLOCKED",
      spoolJobId: "42",
      failureCode: "PAPER_OUT",
    });
    await new PaidPrintExecutor(api, printer, await journal()).handle(
      credentials,
      job("CUSTOMER_DOCUMENT", "BLOCKED"),
    );
    expect(printer.submitPdfJob).not.toHaveBeenCalled();
    expect(api.reportPrintStep).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ status: "BLOCKED", spoolerJobId: "42" }),
    );
  });
});
