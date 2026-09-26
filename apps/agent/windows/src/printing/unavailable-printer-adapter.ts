import type {
  PrintJobStatus,
  PrinterAdapter,
  PrinterCapabilities,
  PrinterStatus,
  PrinterSummary,
  PrintSubmission,
  SubmittedPrintJob,
} from "./printer-adapter.js";

const NOT_IMPLEMENTED =
  "Windows printing is unavailable on this host or configuration.";

/** Safe placeholder that cannot accidentally submit a print job. */
export class UnavailablePrinterAdapter implements PrinterAdapter {
  listPrinters(): Promise<readonly PrinterSummary[]> {
    return Promise.resolve([]);
  }

  getCapabilities(printerId: string): Promise<PrinterCapabilities> {
    void printerId;
    return Promise.reject(new Error(NOT_IMPLEMENTED));
  }

  getStatus(printerId: string): Promise<PrinterStatus> {
    void printerId;
    return Promise.resolve({
      availability: "UNKNOWN",
      message: NOT_IMPLEMENTED,
    });
  }

  submitPdfJob(submission: PrintSubmission): Promise<SubmittedPrintJob> {
    void submission;
    return Promise.reject(new Error(NOT_IMPLEMENTED));
  }

  getJobStatus(printerId: string, spoolJobId: string): Promise<PrintJobStatus> {
    void printerId;
    void spoolJobId;
    return Promise.reject(new Error(NOT_IMPLEMENTED));
  }

  cancelJob(printerId: string, spoolJobId: string): Promise<void> {
    void printerId;
    void spoolJobId;
    return Promise.reject(new Error(NOT_IMPLEMENTED));
  }
}
