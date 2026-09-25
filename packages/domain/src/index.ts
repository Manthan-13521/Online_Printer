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
  "ADMIN_ACTION_REQUIRED",
  "PRINTED",
  "COMPLETED",
  "FILE_EXPIRED",
  "CANCELLED",
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const PAYMENT_STATUSES = [
  "PENDING",
  "VERIFIED",
  "FAILED",
  "CANCELLED",
] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const PRINTER_STATES = [
  "UNKNOWN",
  "ONLINE",
  "OFFLINE",
  "BLOCKED",
  "ERROR",
] as const;

export type PrinterState = (typeof PRINTER_STATES)[number];
