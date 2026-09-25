import {
  COLOR_MODES,
  FILE_SIZE_25_MIB,
  ORDER_STATUSES,
  PAPER_SIZES,
  SIDES_MODES,
  type ColorMode,
  type OrderStatus,
  type PaperSize,
  type SidesMode,
} from "@printgo/domain";

export interface ValidationIssue {
  path: readonly string[];
  code: string;
  message: string;
}

export type ValidationResult<T> =
  { ok: true; value: T } | { ok: false; issues: readonly ValidationIssue[] };

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isIntegerPaise(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function isValidPdfSizeBytes(
  value: unknown,
  maximumBytes = FILE_SIZE_25_MIB,
): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) > 0 &&
    (value as number) <= maximumBytes &&
    maximumBytes <= FILE_SIZE_25_MIB
  );
}

export function isValidCopies(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

export function isPaperSize(value: unknown): value is PaperSize {
  return (
    typeof value === "string" && PAPER_SIZES.some((item) => item === value)
  );
}

export function isColorMode(value: unknown): value is ColorMode {
  return (
    typeof value === "string" && COLOR_MODES.some((item) => item === value)
  );
}

export function isSidesMode(value: unknown): value is SidesMode {
  return (
    typeof value === "string" && SIDES_MODES.some((item) => item === value)
  );
}

export function isOrderStatus(value: unknown): value is OrderStatus {
  return (
    typeof value === "string" && ORDER_STATUSES.some((item) => item === value)
  );
}
