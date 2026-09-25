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

export const LOGIN_IDENTIFIER_MAX_LENGTH = 100;
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export function normalizeLoginIdentifier(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

export function validateLoginIdentifier(
  value: unknown,
): ValidationResult<string> {
  if (typeof value !== "string") {
    return {
      ok: false,
      issues: [
        {
          path: ["loginIdentifier"],
          code: "INVALID_TYPE",
          message: "Enter your login.",
        },
      ],
    };
  }
  const normalized = normalizeLoginIdentifier(value);
  if (
    normalized.length === 0 ||
    normalized.length > LOGIN_IDENTIFIER_MAX_LENGTH
  ) {
    return {
      ok: false,
      issues: [
        {
          path: ["loginIdentifier"],
          code: "INVALID_LENGTH",
          message: "Enter a valid login.",
        },
      ],
    };
  }
  return { ok: true, value: normalized };
}

export function validatePassword(value: unknown): ValidationResult<string> {
  if (
    typeof value !== "string" ||
    value.length < PASSWORD_MIN_LENGTH ||
    value.length > PASSWORD_MAX_LENGTH
  ) {
    return {
      ok: false,
      issues: [
        {
          path: ["password"],
          code: "INVALID_LENGTH",
          message: `Use ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters.`,
        },
      ],
    };
  }
  return { ok: true, value };
}

export interface ValidatedLoginInput {
  loginIdentifier: string;
  password: string;
}

export function validateAdminLoginInput(
  value: unknown,
): ValidationResult<ValidatedLoginInput> {
  if (typeof value !== "object" || value === null) {
    return {
      ok: false,
      issues: [
        {
          path: [],
          code: "INVALID_BODY",
          message: "Enter your login and password.",
        },
      ],
    };
  }
  const record = value as Record<string, unknown>;
  const identifier = validateLoginIdentifier(record.loginIdentifier);
  const password = validatePassword(record.password);
  const issues = [
    ...(identifier.ok ? [] : identifier.issues),
    ...(password.ok ? [] : password.issues),
  ];
  return issues.length > 0
    ? { ok: false, issues }
    : {
        ok: true,
        value: {
          loginIdentifier: identifier.ok ? identifier.value : "",
          password: password.ok ? password.value : "",
        },
      };
}

export interface ValidatedPasswordChangeInput {
  currentPassword: string;
  newPassword: string;
}

export function validateAdminPasswordChangeInput(
  value: unknown,
): ValidationResult<ValidatedPasswordChangeInput> {
  if (typeof value !== "object" || value === null) {
    return {
      ok: false,
      issues: [
        {
          path: [],
          code: "INVALID_BODY",
          message: "Enter your current and new password.",
        },
      ],
    };
  }
  const record = value as Record<string, unknown>;
  const current = validatePassword(record.currentPassword);
  const next = validatePassword(record.newPassword);
  const issues: ValidationIssue[] = [];
  if (!current.ok) {
    issues.push(
      ...current.issues.map((issue) => ({
        ...issue,
        path: ["currentPassword"],
      })),
    );
  }
  if (!next.ok) {
    issues.push(
      ...next.issues.map((issue) => ({ ...issue, path: ["newPassword"] })),
    );
  }
  if (record.newPassword !== record.confirmNewPassword) {
    issues.push({
      path: ["confirmNewPassword"],
      code: "PASSWORD_MISMATCH",
      message: "New passwords do not match.",
    });
  }
  return issues.length > 0
    ? { ok: false, issues }
    : {
        ok: true,
        value: {
          currentPassword: current.ok ? current.value : "",
          newPassword: next.ok ? next.value : "",
        },
      };
}
