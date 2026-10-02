export const ORDER_STATUSES = [
  "CREATED",
  "UPLOADING",
  "UPLOADED",
  "PAYMENT_PENDING",
  "PAYMENT_FAILED",
  "PAYMENT_CANCELLED",
  "PAID",
  "QUEUED",
  "CLAIMED",
  "SPOOLING",
  "PRINTING",
  "PRINT_BLOCKED",
  "PRINT_FAILED",
  "RETRY_PENDING",
  "NEEDS_ADMIN",
  "COMPLETION_UNKNOWN",
  "ADMIN_ACTION_REQUIRED",
  "PRINTED",
  "MANUAL_PRINT",
  "AWAITING_FINISHING",
  "COMPLETED",
  "CANCELLED",
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const PAYMENT_STATUSES = [
  "CREATED",
  "PENDING",
  "PAID",
  "FAILED",
  "CANCELLED",
  "REFUNDED",
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const UPLOAD_STORAGE_STATUSES = [
  "PENDING",
  "UPLOADED",
  "EXPIRED",
  "DELETE_PENDING",
  "DELETED",
  "DELETE_FAILED",
] as const;
export type UploadStorageStatus = (typeof UPLOAD_STORAGE_STATUSES)[number];

export const RETENTION_REASONS = [
  "UNPAID",
  "PAYMENT_FAILED_OR_CANCELLED",
  "COMPLETED",
  "UNRESOLVED_PAID_FAILURE",
] as const;
export type RetentionReason = (typeof RETENTION_REASONS)[number];

export const PRINT_ATTEMPT_STATUSES = [
  "CREATED",
  "SUBMITTING",
  "SPOOLING",
  "PRINTING",
  "BLOCKED",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
] as const;
export type PrintAttemptStatus = (typeof PRINT_ATTEMPT_STATUSES)[number];

export const PRINTER_FAILURE_CODES = [
  "PAPER_OUT",
  "PAPER_JAM",
  "OFFLINE",
  "NO_TONER",
  "TONER_LOW",
  "DOOR_OPEN",
  "USER_INTERVENTION",
  "PRINTER_ERROR",
  "UNKNOWN",
] as const;
export type PrinterFailureCode = (typeof PRINTER_FAILURE_CODES)[number];

export const NORMALIZED_PRINTER_FAILURES = [
  "PRINTER_OFFLINE",
  "PAPER_OUT",
  "PAPER_JAM",
  "CONNECTION_LOST",
  "SPOOLER_ERROR",
  "PRINTER_ERROR",
  "UNKNOWN",
] as const;
export type NormalizedPrinterFailure =
  (typeof NORMALIZED_PRINTER_FAILURES)[number];

export function normalizePrinterFailure(
  rawCodeOrDetail: string | null | undefined,
): NormalizedPrinterFailure {
  if (!rawCodeOrDetail) return "UNKNOWN";
  const upper = rawCodeOrDetail.toUpperCase().trim();
  if (
    upper === "OFFLINE" ||
    upper === "PRINTER_OFFLINE" ||
    upper.includes("OFFLINE") ||
    upper.includes("NOT_AVAILABLE")
  ) {
    return "PRINTER_OFFLINE";
  }
  if (
    upper === "PAPER_OUT" ||
    upper === "OUT_OF_PAPER" ||
    upper.includes("PAPER_OUT") ||
    upper.includes("OUT_OF_PAPER") ||
    upper.includes("NO_PAPER")
  ) {
    return "PAPER_OUT";
  }
  if (
    upper === "PAPER_JAM" ||
    upper.includes("PAPER_JAM") ||
    upper.includes("JAM")
  ) {
    return "PAPER_JAM";
  }
  if (
    upper === "CONNECTION_LOST" ||
    upper.includes("CONNECTION_LOST") ||
    upper.includes("COMM_ERROR") ||
    upper.includes("COMMUNICATION") ||
    upper.includes("NETWORK_ERROR")
  ) {
    return "CONNECTION_LOST";
  }
  if (
    upper === "SPOOLER_ERROR" ||
    upper.includes("SPOOLER") ||
    upper.includes("RPC") ||
    upper.includes("PRINT_SPOOLER")
  ) {
    return "SPOOLER_ERROR";
  }
  if (
    upper === "PRINTER_ERROR" ||
    upper.includes("PRINTER_ERROR") ||
    upper.includes("DOOR_OPEN") ||
    upper.includes("NO_TONER") ||
    upper.includes("TONER_LOW") ||
    upper.includes("USER_INTERVENTION") ||
    upper === "ERROR"
  ) {
    return "PRINTER_ERROR";
  }
  return "UNKNOWN";
}

export function isPrinterWideFailure(
  failure: NormalizedPrinterFailure,
): boolean {
  return failure !== "UNKNOWN";
}

export const PRINTER_STATUSES = [
  "UNKNOWN",
  "ONLINE",
  "OFFLINE",
  "BLOCKED",
  "ERROR",
] as const;
export type PrinterStatus = (typeof PRINTER_STATUSES)[number];

export const COLOR_MODES = ["BW", "COLOR"] as const;
export type ColorMode = (typeof COLOR_MODES)[number];

export const PAPER_SIZES = ["A4", "A3"] as const;
export type PaperSize = (typeof PAPER_SIZES)[number];

export const SIDES_MODES = ["SINGLE", "DOUBLE"] as const;
export type SidesMode = (typeof SIDES_MODES)[number];

export const IDENTIFICATION_SHEET_PLACEMENTS = ["FIRST", "LAST"] as const;
export type IdentificationSheetPlacement =
  (typeof IDENTIFICATION_SHEET_PLACEMENTS)[number];

export const ACTOR_TYPES = [
  "SYSTEM",
  "CUSTOMER",
  "ADMIN",
  "AGENT",
  "PAYMENT_PROVIDER",
] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const PAYMENT_PROVIDERS = ["RAZORPAY"] as const;
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];

export const PAYMENT_EVENT_PROCESSING_STATUSES = [
  "RECEIVED",
  "PROCESSING",
  "PROCESSED",
  "FAILED",
  "IGNORED",
] as const;
export type PaymentEventProcessingStatus =
  (typeof PAYMENT_EVENT_PROCESSING_STATUSES)[number];

export const TEST_PRINT_COMMAND_STATUSES = [
  "PENDING",
  "CLAIMED",
  "SUBMITTED",
  "BLOCKED",
  "SUCCEEDED",
  "FAILED",
  "EXPIRED",
] as const;
export type TestPrintCommandStatus =
  (typeof TEST_PRINT_COMMAND_STATUSES)[number];
