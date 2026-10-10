import type {
  PrinterCapabilityFeatures,
  PrinterFailureCode,
} from "@printgo/domain";

export type PrinterAvailability =
  "ONLINE" | "AVAILABLE" | "OFFLINE" | "BLOCKED" | "ERROR" | "UNKNOWN";

export interface PrinterSummary {
  id: string;
  displayName: string;
  isDefault: boolean;
  portName?: string | null;
  driverName?: string | null;
  isVirtual?: boolean;
  isEligibleForProductionPrint?: boolean;
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

export type PrintPaperSize = "A4" | "A3";
export type PrintColorMode = "COLOUR" | "BLACK_AND_WHITE";
export type PrintSides = "ONE_SIDED" | "TWO_SIDED_LONG" | "TWO_SIDED_SHORT";

export type PrintOrientation = "portrait" | "landscape";

export interface PrintSettings {
  printerName?: string | undefined;
  paperSize: PrintPaperSize;
  colorMode: PrintColorMode;
  sides: PrintSides;
  copies: number;
  pageRange?: string | undefined;
  orientation?: PrintOrientation | undefined;
}

export interface PrintSubmission {
  printerId: string;
  localPdfPath: string;
  copies?: number | undefined;
  documentTitle?: string | undefined;
  settings?: Partial<PrintSettings> | undefined;
  verifiedCapabilities?: PrinterCapabilityFeatures | null | undefined;
  isDiagnosticTestPrint?: boolean | undefined;
}

export interface SubmittedPrintJob {
  timings?: {
    processStartedAtMs: number;
    spoolCapturedAtMs: number | null;
    acceptedAtMs: number;
  };
  spoolJobId: string;
  engineUsed?: string | undefined;
  fastDespooled?: boolean | undefined;
}

export class UnsupportedPrintSettingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedPrintSettingError";
  }
}

export class InvalidPrintSettingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPrintSettingError";
  }
}

export class PrinterNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrinterNotFoundError";
  }
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
  listPrinters(forceRefresh?: boolean): Promise<readonly PrinterSummary[]>;
  getCapabilities(printerId: string): Promise<PrinterCapabilities>;
  getStatus(printerId: string): Promise<PrinterStatus>;
  submitPdfJob(submission: PrintSubmission): Promise<SubmittedPrintJob>;
  getJobStatus(printerId: string, spoolJobId: string): Promise<PrintJobStatus>;
  cancelJob(printerId: string, spoolJobId: string): Promise<void>;
}
