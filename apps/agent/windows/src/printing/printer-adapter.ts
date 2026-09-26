import type { PrinterFailureCode } from "@printgo/domain";

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

export interface PrintSettings {
  copies: number;
  paperSize?: string;
  colorMode?: "COLOUR" | "BLACK_AND_WHITE";
  sides?: "ONE_SIDED" | "TWO_SIDED_LONG" | "TWO_SIDED_SHORT";
  pageRange?: string;
}

export interface PrintSubmission {
  printerId: string;
  localPdfPath: string;
  copies?: number;
  settings?: PrintSettings;
}

export interface SubmittedPrintJob {
  spoolJobId: string;
}

export type SpoolJobState =
  | "QUEUED"
  | "SPOOLING"
  | "PRINTING"
  | "BLOCKED"
  | "COMPLETED_OR_REMOVED"
  | "FAILED"
  | "UNKNOWN";

export interface PrintJobStatus {
  state: SpoolJobState;
  spoolJobId?: string;
  failureCode?: PrinterFailureCode;
  message?: string;
}

/**
 * Boundary for Windows printer integrations.
 *
 * Business orchestration must depend on this contract rather than a particular
 * PDF library, shell command, or Windows driver implementation.
 */
export interface PrinterAdapter {
  listPrinters(): Promise<readonly PrinterSummary[]>;
  getCapabilities(printerId: string): Promise<PrinterCapabilities>;
  getStatus(printerId: string): Promise<PrinterStatus>;
  submitPdfJob(submission: PrintSubmission): Promise<SubmittedPrintJob>;
  getJobStatus(printerId: string, spoolJobId: string): Promise<PrintJobStatus>;
  cancelJob(printerId: string, spoolJobId: string): Promise<void>;
}
