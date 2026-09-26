export type PrinterAvailability =
  "ONLINE" | "AVAILABLE" | "OFFLINE" | "BLOCKED" | "ERROR" | "UNKNOWN";

export interface PrinterSummary {
  id: string;
  displayName: string;
  isDefault: boolean;
}

export interface PrinterCapabilities {
  colour: boolean | "UNKNOWN";
  duplex: boolean | "UNKNOWN";
  paperSizes: readonly string[];
}

export interface PrinterStatus {
  availability: PrinterAvailability;
  message?: string;
}

export interface PrintSubmission {
  printerId: string;
  localPdfPath: string;
  copies: number;
}

export interface SubmittedPrintJob {
  spoolJobId: string;
}

export interface PrintJobStatus {
  state: "QUEUED" | "PRINTING" | "BLOCKED" | "FAILED" | "COMPLETED";
  message?: string;
}

/**
 * Boundary for future Windows printer integrations.
 *
 * Business orchestration must depend on this contract rather than a particular
 * PDF library, shell command, or Windows driver implementation.
 */
export interface PrinterAdapter {
  listPrinters(): Promise<readonly PrinterSummary[]>;
  getCapabilities(printerId: string): Promise<PrinterCapabilities>;
  getStatus(printerId: string): Promise<PrinterStatus>;
  submitPdfJob(submission: PrintSubmission): Promise<SubmittedPrintJob>;
  getJobStatus(spoolJobId: string): Promise<PrintJobStatus>;
  cancelJob(spoolJobId: string): Promise<void>;
}
