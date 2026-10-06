import {
  COLOR_MODES,
  FILE_SIZE_25_MIB,
  FILE_SIZE_SERVICE_CHARGE_BANDS,
  IDENTIFICATION_SHEET_PLACEMENTS,
  ORDER_STATUSES,
  PAPER_SIZES,
  SIDES_MODES,
  MIN_PRINT_COPIES,
  MAX_PRINT_COPIES,
  ORDER_RETENTION_HOURS_OPTIONS,
  classifyPrinter,
  type ColorMode,
  type IdentificationSheetPlacement,
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
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= MIN_PRINT_COPIES &&
    (value as number) <= MAX_PRINT_COPIES
  );
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

export function isIdentificationSheetPlacement(
  value: unknown,
): value is IdentificationSheetPlacement {
  return (
    typeof value === "string" &&
    IDENTIFICATION_SHEET_PLACEMENTS.some((item) => item === value)
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

export const SHOP_NAME_MAX_LENGTH = 100;
export const APP_NAME_MAX_LENGTH = 50;
export const CONTACT_PHONE_MAX_LENGTH = 30;
export const ADDRESS_MAX_LENGTH = 500;
export const CUSTOMER_NOTICE_MAX_LENGTH = 300;

export interface ValidatedShopSettings {
  appName?: string;
  shopName: string;
  contactPhone: string | null;
  address: string | null;
  customerNotice: string | null;
  onlinePrintingEnabled: boolean;
  maxPdfSizeBytes: number;
  maxOrderUploadBytes?: number;
  identificationSheetEnabled: boolean;
  identificationSheetPlacement: IdentificationSheetPlacement;
  automaticDailyCleanupEnabled?: boolean;
  dailyCleanupTime?: string;
  timezone?: string;
  lastCleanupAt?: string | null;
  nextCleanupAt?: string | null;
  lastCleanupResult?: string | null;
  orderRetentionHours?: number;
}

function optionalPlainText(
  value: unknown,
  path: string,
  maximumLength: number,
  issues: ValidationIssue[],
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    issues.push({
      path: [path],
      code: "INVALID_TYPE",
      message: "Enter plain text.",
    });
    return null;
  }
  const normalized = value.trim();
  if (normalized.length > maximumLength) {
    issues.push({
      path: [path],
      code: "TOO_LONG",
      message: `Use no more than ${maximumLength} characters.`,
    });
  }
  return normalized || null;
}

export function validateShopSettingsInput(
  value: unknown,
): ValidationResult<ValidatedShopSettings> {
  if (typeof value !== "object" || value === null) {
    return {
      ok: false,
      issues: [
        { path: [], code: "INVALID_BODY", message: "Check the shop settings." },
      ],
    };
  }
  const record = value as Record<string, unknown>;
  const issues: ValidationIssue[] = [];
  const hasExtendedSettings = "appName" in record;
  const appName =
    typeof record.appName === "string" ? record.appName.trim() : "";
  if (
    hasExtendedSettings &&
    (!appName || appName.length > APP_NAME_MAX_LENGTH)
  ) {
    issues.push({
      path: ["appName"],
      code: "INVALID_APP_NAME",
      message: `App name must contain 1 to ${APP_NAME_MAX_LENGTH} characters.`,
    });
  }
  const shopName =
    typeof record.shopName === "string" ? record.shopName.trim() : "";
  if (!shopName || shopName.length > SHOP_NAME_MAX_LENGTH) {
    issues.push({
      path: ["shopName"],
      code: "INVALID_SHOP_NAME",
      message: `Shop name must contain 1 to ${SHOP_NAME_MAX_LENGTH} characters.`,
    });
  }
  const contactPhone = optionalPlainText(
    record.contactPhone,
    "contactPhone",
    CONTACT_PHONE_MAX_LENGTH,
    issues,
  );
  if (contactPhone && !/^[0-9+()\-\s]{5,30}$/u.test(contactPhone)) {
    issues.push({
      path: ["contactPhone"],
      code: "INVALID_PHONE",
      message: "Enter a practical contact phone number.",
    });
  }
  const address = optionalPlainText(
    record.address,
    "address",
    ADDRESS_MAX_LENGTH,
    issues,
  );
  const customerNotice = optionalPlainText(
    record.customerNotice,
    "customerNotice",
    CUSTOMER_NOTICE_MAX_LENGTH,
    issues,
  );
  if (typeof record.onlinePrintingEnabled !== "boolean") {
    issues.push({
      path: ["onlinePrintingEnabled"],
      code: "INVALID_BOOLEAN",
      message: "Choose whether online printing is on or off.",
    });
  }
  if (!isValidPdfSizeBytes(record.maxPdfSizeBytes)) {
    issues.push({
      path: ["maxPdfSizeBytes"],
      code: "INVALID_PDF_LIMIT",
      message: "Choose a PDF limit up to 25 MB.",
    });
  }
  if (
    (hasExtendedSettings &&
      !Number.isSafeInteger(record.maxOrderUploadBytes)) ||
    (hasExtendedSettings &&
      ((record.maxOrderUploadBytes as number) <
        (record.maxPdfSizeBytes as number) ||
        (record.maxOrderUploadBytes as number) > 100 * 1024 * 1024))
  ) {
    issues.push({
      path: ["maxOrderUploadBytes"],
      code: "INVALID_ORDER_UPLOAD_LIMIT",
      message:
        "Choose an order upload limit between the per-PDF limit and 100 MB.",
    });
  }
  if (typeof record.identificationSheetEnabled !== "boolean") {
    issues.push({
      path: ["identificationSheetEnabled"],
      code: "INVALID_BOOLEAN",
      message: "Choose whether identification sheets are on or off.",
    });
  }
  if (!isIdentificationSheetPlacement(record.identificationSheetPlacement)) {
    issues.push({
      path: ["identificationSheetPlacement"],
      code: "INVALID_PLACEMENT",
      message: "Choose before or after the document.",
    });
  }
  if (
    hasExtendedSettings &&
    typeof record.automaticDailyCleanupEnabled !== "boolean"
  ) {
    issues.push({
      path: ["automaticDailyCleanupEnabled"],
      code: "INVALID_BOOLEAN",
      message: "Choose whether automatic daily cleanup is on or off.",
    });
  }
  const dailyCleanupTime =
    typeof record.dailyCleanupTime === "string" ? record.dailyCleanupTime : "";
  if (
    hasExtendedSettings &&
    !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(dailyCleanupTime)
  ) {
    issues.push({
      path: ["dailyCleanupTime"],
      code: "INVALID_CLEANUP_TIME",
      message: "Choose a valid 24-hour cleanup time.",
    });
  }
  const timezone =
    typeof record.timezone === "string" ? record.timezone.trim() : "";
  if (hasExtendedSettings) {
    try {
      if (!timezone || timezone.length > 100)
        throw new RangeError("Invalid timezone");
      new Intl.DateTimeFormat("en", { timeZone: timezone }).format(0);
    } catch {
      issues.push({
        path: ["timezone"],
        code: "INVALID_TIMEZONE",
        message: "Choose a valid IANA timezone.",
      });
    }
  }
  if (record.orderRetentionHours !== undefined) {
    if (
      typeof record.orderRetentionHours !== "number" ||
      !ORDER_RETENTION_HOURS_OPTIONS.includes(
        record.orderRetentionHours as (typeof ORDER_RETENTION_HOURS_OPTIONS)[number],
      )
    ) {
      issues.push({
        path: ["orderRetentionHours"],
        code: "INVALID_RETENTION_HOURS",
        message: "Order retention hours must be 1, 2, 3, 6, or 12.",
      });
    }
  }
  return issues.length > 0
    ? { ok: false, issues }
    : {
        ok: true,
        value: {
          ...(hasExtendedSettings
            ? {
                appName,
                maxOrderUploadBytes: record.maxOrderUploadBytes as number,
                automaticDailyCleanupEnabled:
                  record.automaticDailyCleanupEnabled as boolean,
                dailyCleanupTime,
                timezone,
                lastCleanupAt: null,
                nextCleanupAt: null,
                lastCleanupResult: null,
              }
            : {}),
          ...(typeof record.orderRetentionHours === "number" &&
          ORDER_RETENTION_HOURS_OPTIONS.includes(
            record.orderRetentionHours as (typeof ORDER_RETENTION_HOURS_OPTIONS)[number],
          )
            ? { orderRetentionHours: record.orderRetentionHours }
            : {}),
          ...(typeof record.priorityPrintingEnabled === "boolean"
            ? { priorityPrintingEnabled: record.priorityPrintingEnabled }
            : {}),
          ...(isIntegerPaise(record.priorityFeePaise)
            ? { priorityFeePaise: record.priorityFeePaise }
            : {}),
          ...(typeof record.idRequirementMode === "string" &&
          ["OFF", "ALWAYS", "ABOVE_THRESHOLD"].includes(
            record.idRequirementMode,
          )
            ? {
                idRequirementMode: record.idRequirementMode as
                  "OFF" | "ALWAYS" | "ABOVE_THRESHOLD",
              }
            : {}),
          ...(isIntegerPaise(record.idThresholdPaise)
            ? { idThresholdPaise: record.idThresholdPaise }
            : {}),
          shopName,
          contactPhone,
          address,
          customerNotice,
          onlinePrintingEnabled: record.onlinePrintingEnabled as boolean,
          maxPdfSizeBytes: record.maxPdfSizeBytes as number,
          identificationSheetEnabled:
            record.identificationSheetEnabled as boolean,
          identificationSheetPlacement:
            record.identificationSheetPlacement as IdentificationSheetPlacement,
        },
      };
}

export function validateDiscountRuleRequest(value: unknown): ValidationResult<{
  minSubtotalPaise: number;
  discountPercent: number;
  enabled: boolean;
}> {
  if (typeof value !== "object" || value === null) {
    return {
      ok: false,
      issues: [
        { path: [], code: "INVALID_BODY", message: "Invalid request body." },
      ],
    };
  }
  const record = value as Record<string, unknown>;
  const issues: ValidationIssue[] = [];
  if (
    !isIntegerPaise(record.minSubtotalPaise) ||
    record.minSubtotalPaise <= 0
  ) {
    issues.push({
      path: ["minSubtotalPaise"],
      code: "INVALID_THRESHOLD",
      message: "Threshold must be greater than ₹0.",
    });
  }
  if (
    !Number.isSafeInteger(record.discountPercent) ||
    (record.discountPercent as number) < 1 ||
    (record.discountPercent as number) > 100
  ) {
    issues.push({
      path: ["discountPercent"],
      code: "INVALID_PERCENT",
      message: "Discount percent must be between 1% and 100%.",
    });
  }
  if (typeof record.enabled !== "boolean") {
    issues.push({
      path: ["enabled"],
      code: "INVALID_BOOLEAN",
      message: "Enabled must be true or false.",
    });
  }
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      minSubtotalPaise: record.minSubtotalPaise as number,
      discountPercent: record.discountPercent as number,
      enabled: record.enabled as boolean,
    },
  };
}

export interface ValidatedPrintRate {
  paperSize: PaperSize;
  colorMode: ColorMode;
  sides: SidesMode;
  pricePerPagePaise: number;
  enabled: boolean;
}

export interface ValidatedFileSizeServiceCharge {
  minBytesExclusive: number;
  maxBytesInclusive: number;
  chargePaise: number;
}

export interface ValidatedPricingUpdate {
  printRates: ValidatedPrintRate[];
  fileSizeServiceCharges: ValidatedFileSizeServiceCharge[];
  priorityPrinting?: {
    enabled: boolean;
    feePaise: number;
  };
}

export function validatePricingUpdateInput(
  value: unknown,
): ValidationResult<ValidatedPricingUpdate> {
  if (typeof value !== "object" || value === null) {
    return {
      ok: false,
      issues: [
        {
          path: [],
          code: "INVALID_BODY",
          message: "Check the pricing configuration.",
        },
      ],
    };
  }
  const record = value as Record<string, unknown>;
  const issues: ValidationIssue[] = [];
  const printRates: ValidatedPrintRate[] = [];
  const seenRates = new Set<string>();
  if (!Array.isArray(record.printRates) || record.printRates.length !== 8) {
    issues.push({
      path: ["printRates"],
      code: "INCOMPLETE_RATES",
      message: "All printing options must be included.",
    });
  } else {
    for (const [index, entry] of record.printRates.entries()) {
      if (typeof entry !== "object" || entry === null) {
        issues.push({
          path: ["printRates", String(index)],
          code: "INVALID_RATE",
          message: "Check this printing rate.",
        });
        continue;
      }
      const rate = entry as Record<string, unknown>;
      if (
        !isPaperSize(rate.paperSize) ||
        !isColorMode(rate.colorMode) ||
        !isSidesMode(rate.sides) ||
        !isIntegerPaise(rate.pricePerPagePaise) ||
        typeof rate.enabled !== "boolean"
      ) {
        issues.push({
          path: ["printRates", String(index)],
          code: "INVALID_RATE",
          message: "Use a valid non-negative price and printing option.",
        });
        continue;
      }
      const key = `${rate.paperSize}:${rate.colorMode}:${rate.sides}`;
      if (seenRates.has(key)) {
        issues.push({
          path: ["printRates", String(index)],
          code: "DUPLICATE_RATE",
          message: "Each printing option must appear once.",
        });
        continue;
      }
      seenRates.add(key);
      printRates.push({
        paperSize: rate.paperSize,
        colorMode: rate.colorMode,
        sides: rate.sides,
        pricePerPagePaise: rate.pricePerPagePaise,
        enabled: rate.enabled,
      });
    }
    if (seenRates.size !== 8) {
      issues.push({
        path: ["printRates"],
        code: "INCOMPLETE_RATES",
        message: "Every A4 and A3 printing option must appear once.",
      });
    }
  }

  const fileSizeServiceCharges: ValidatedFileSizeServiceCharge[] = [];
  const rawServiceCharges: unknown = record.fileSizeServiceCharges;
  if (
    !Array.isArray(rawServiceCharges) ||
    rawServiceCharges.length !== FILE_SIZE_SERVICE_CHARGE_BANDS.length
  ) {
    issues.push({
      path: ["fileSizeServiceCharges"],
      code: "INCOMPLETE_BANDS",
      message: "All four PDF size charges must be included.",
    });
  } else {
    const serviceCharges = rawServiceCharges as unknown[];
    for (const [index, expected] of FILE_SIZE_SERVICE_CHARGE_BANDS.entries()) {
      const entry = serviceCharges[index];
      if (typeof entry !== "object" || entry === null) {
        issues.push({
          path: ["fileSizeServiceCharges", String(index)],
          code: "INVALID_BAND",
          message: "Check this PDF size charge.",
        });
        continue;
      }
      const band = entry as Record<string, unknown>;
      if (
        band.minBytesExclusive !== expected.minBytesExclusive ||
        band.maxBytesInclusive !== expected.maxBytesInclusive ||
        !isIntegerPaise(band.chargePaise)
      ) {
        issues.push({
          path: ["fileSizeServiceCharges", String(index)],
          code: "INVALID_BAND",
          message:
            "PDF size ranges are fixed; enter a valid non-negative charge.",
        });
        continue;
      }
      fileSizeServiceCharges.push({
        minBytesExclusive: expected.minBytesExclusive,
        maxBytesInclusive: expected.maxBytesInclusive,
        chargePaise: band.chargePaise,
      });
    }
  }

  let priorityPrinting: { enabled: boolean; feePaise: number } | undefined;
  if (record.priorityPrinting !== undefined) {
    if (
      typeof record.priorityPrinting !== "object" ||
      record.priorityPrinting === null
    ) {
      issues.push({
        path: ["priorityPrinting"],
        code: "INVALID_PRIORITY_PRINTING",
        message: "Check priority printing configuration.",
      });
    } else {
      const pp = record.priorityPrinting as Record<string, unknown>;
      if (typeof pp.enabled !== "boolean" || !isIntegerPaise(pp.feePaise)) {
        issues.push({
          path: ["priorityPrinting"],
          code: "INVALID_PRIORITY_PRINTING",
          message:
            "Priority printing requires a valid enabled flag and non-negative fee.",
        });
      } else {
        priorityPrinting = {
          enabled: pp.enabled,
          feePaise: pp.feePaise,
        };
      }
    }
  }

  return issues.length > 0
    ? { ok: false, issues }
    : {
        ok: true,
        value: {
          printRates,
          fileSizeServiceCharges,
          ...(priorityPrinting !== undefined ? { priorityPrinting } : {}),
        },
      };
}

export function validateAgentPairInput(
  value: unknown,
): ValidationResult<{ pairCode: string; displayName: string }> {
  if (typeof value !== "object" || value === null) {
    return {
      ok: false,
      issues: [
        { path: [], code: "INVALID_BODY", message: "Invalid request body." },
      ],
    };
  }
  const record = value as Record<string, unknown>;
  const issues: ValidationIssue[] = [];
  const pairCode =
    typeof record.pairCode === "string" ? record.pairCode.trim() : "";
  if (!pairCode || pairCode.length > 50) {
    issues.push({
      path: ["pairCode"],
      code: "INVALID_PAIR_CODE",
      message: "Enter a valid pairing code.",
    });
  }
  const displayName =
    typeof record.displayName === "string" ? record.displayName.trim() : "";
  if (!displayName || displayName.length > 100) {
    issues.push({
      path: ["displayName"],
      code: "INVALID_DISPLAY_NAME",
      message: "Enter an agent display name up to 100 characters.",
    });
  }
  return issues.length > 0
    ? { ok: false, issues }
    : { ok: true, value: { pairCode, displayName } };
}

export function validateTogglePrinterInput(
  value: unknown,
): ValidationResult<{ enabled: boolean }> {
  if (typeof value !== "object" || value === null) {
    return {
      ok: false,
      issues: [
        { path: [], code: "INVALID_BODY", message: "Invalid request body." },
      ],
    };
  }
  const record = value as Record<string, unknown>;
  if (typeof record.enabled !== "boolean") {
    return {
      ok: false,
      issues: [
        {
          path: ["enabled"],
          code: "INVALID_ENABLED",
          message: "Enabled must be a boolean.",
        },
      ],
    };
  }
  return { ok: true, value: { enabled: record.enabled } };
}

export interface ValidatedPrinterReport {
  windowsPrinterName: string;
  displayName: string;
  isDefault: boolean;
  status: "ONLINE" | "OFFLINE" | "BLOCKED" | "ERROR" | "UNKNOWN";
  statusReason: string | null;
  capabilities: {
    colour: boolean | "UNKNOWN";
    duplex: boolean | "UNKNOWN";
    paperSizes: readonly string[];
  } | null;
  isProductionEligible: boolean;
  isVirtual: boolean;
  portName: string | null;
  driverName: string | null;
}

export interface ValidatedAgentHeartbeatInput {
  agentVersion: string;
  operationalState: "ONLINE" | "PAUSED" | "ERROR";
  printers: readonly ValidatedPrinterReport[];
}

export function validateAgentHeartbeatInput(
  value: unknown,
): ValidationResult<ValidatedAgentHeartbeatInput> {
  if (typeof value !== "object" || value === null) {
    return {
      ok: false,
      issues: [
        { path: [], code: "INVALID_BODY", message: "Invalid request body." },
      ],
    };
  }
  const record = value as Record<string, unknown>;
  const issues: ValidationIssue[] = [];
  const agentVersion =
    typeof record.agentVersion === "string" ? record.agentVersion.trim() : "";
  if (!agentVersion || agentVersion.length > 50) {
    issues.push({
      path: ["agentVersion"],
      code: "INVALID_AGENT_VERSION",
      message: "Agent version is required.",
    });
  }
  const operationalState = record.operationalState;
  if (
    operationalState !== "ONLINE" &&
    operationalState !== "PAUSED" &&
    operationalState !== "ERROR"
  ) {
    issues.push({
      path: ["operationalState"],
      code: "INVALID_OPERATIONAL_STATE",
      message: "Operational state must be ONLINE, PAUSED, or ERROR.",
    });
  }
  const rawPrinters = record.printers;
  if (!Array.isArray(rawPrinters)) {
    issues.push({
      path: ["printers"],
      code: "INVALID_PRINTERS",
      message: "Printers must be an array.",
    });
  }
  if (issues.length > 0) return { ok: false, issues };

  const printers: ValidatedPrinterReport[] = [];
  for (const [index, item] of (rawPrinters as unknown[]).entries()) {
    if (typeof item !== "object" || item === null) {
      issues.push({
        path: ["printers", String(index)],
        code: "INVALID_PRINTER",
        message: "Invalid printer report.",
      });
      continue;
    }
    const p = item as Record<string, unknown>;
    const windowsPrinterName =
      typeof p.windowsPrinterName === "string"
        ? p.windowsPrinterName.trim()
        : "";
    const displayName =
      typeof p.displayName === "string"
        ? p.displayName.trim()
        : windowsPrinterName;
    if (!windowsPrinterName) {
      issues.push({
        path: ["printers", String(index), "windowsPrinterName"],
        code: "INVALID_PRINTER_NAME",
        message: "Windows printer name is required.",
      });
      continue;
    }
    const status = p.status;
    const validStatus =
      status === "ONLINE" ||
      status === "OFFLINE" ||
      status === "BLOCKED" ||
      status === "ERROR" ||
      status === "UNKNOWN"
        ? status
        : "UNKNOWN";
    const statusReason =
      typeof p.statusReason === "string"
        ? p.statusReason.trim().slice(0, 200)
        : null;
    let capabilities: ValidatedPrinterReport["capabilities"] = null;
    if (typeof p.capabilities === "object" && p.capabilities !== null) {
      const caps = p.capabilities as Record<string, unknown>;
      capabilities = {
        colour:
          caps.colour === true
            ? true
            : caps.colour === false
              ? false
              : "UNKNOWN",
        duplex:
          caps.duplex === true
            ? true
            : caps.duplex === false
              ? false
              : "UNKNOWN",
        paperSizes: Array.isArray(caps.paperSizes)
          ? caps.paperSizes.filter(
              (s): s is string => typeof s === "string" && s.trim().length > 0,
            )
          : [],
      };
    }
    const portName =
      typeof p.portName === "string" ? p.portName.trim().slice(0, 100) : null;
    const driverName =
      typeof p.driverName === "string"
        ? p.driverName.trim().slice(0, 200)
        : null;

    // Server-authoritative classification
    const classification = classifyPrinter({
      name: windowsPrinterName,
      portName,
      driverName,
    });
    const isVirtual = classification.isVirtual || Boolean(p.isVirtual);
    const isProductionEligible =
      !isVirtual && classification.isEligibleForProductionPrint;

    printers.push({
      windowsPrinterName,
      displayName: displayName || windowsPrinterName,
      isDefault: Boolean(p.isDefault),
      status: validStatus,
      statusReason,
      capabilities,
      isProductionEligible,
      isVirtual,
      portName,
      driverName,
    });
  }

  return issues.length > 0
    ? { ok: false, issues }
    : {
        ok: true,
        value: {
          agentVersion,
          operationalState: operationalState as "ONLINE" | "PAUSED" | "ERROR",
          printers,
        },
      };
}

export interface ValidatedReportCommandInput {
  status: "SUBMITTED" | "BLOCKED" | "SUCCEEDED" | "FAILED" | "UNCERTAIN";
  spoolerJobId: string | null;
  failureCode: string | null;
  failureDetail: string | null;
}

export function validateReportCommandInput(
  value: unknown,
): ValidationResult<ValidatedReportCommandInput> {
  if (typeof value !== "object" || value === null) {
    return {
      ok: false,
      issues: [
        {
          path: [],
          code: "INVALID_REQUEST",
          message: "Request body must be a JSON object.",
        },
      ],
    };
  }

  const record = value as Record<string, unknown>;
  const status = record.status;
  if (
    status !== "SUBMITTED" &&
    status !== "BLOCKED" &&
    status !== "SUCCEEDED" &&
    status !== "FAILED" && status !== "UNCERTAIN"
  ) {
    return {
      ok: false,
      issues: [
        {
          path: ["status"],
          code: "INVALID_STATUS",
          message:
            "Command report status must be SUBMITTED, BLOCKED, SUCCEEDED, FAILED, or UNCERTAIN.",
        },
      ],
    };
  }

  const spoolerJobId =
    typeof record.spoolerJobId === "string" &&
    record.spoolerJobId.trim().length > 0
      ? record.spoolerJobId.trim().slice(0, 100)
      : null;

  const failureCode =
    typeof record.failureCode === "string" &&
    record.failureCode.trim().length > 0
      ? record.failureCode.trim().slice(0, 50)
      : null;

  const failureDetail =
    typeof record.failureDetail === "string" &&
    record.failureDetail.trim().length > 0
      ? record.failureDetail.trim().slice(0, 500)
      : null;

  return {
    ok: true,
    value: {
      status,
      spoolerJobId,
      failureCode,
      failureDetail,
    },
  };
}
