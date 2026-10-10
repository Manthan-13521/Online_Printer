import {
  MAX_PRINT_COPIES,
  MIN_PRINT_COPIES,
  parsePageRange,
} from "@printgo/domain";
import type {
  PrinterCapabilities,
  PrintSettings,
  PrintSubmission,
} from "./printer-adapter.js";
import {
  InvalidPrintSettingError,
  UnsupportedPrintSettingError,
} from "./printer-adapter.js";
export { InvalidPrintSettingError, UnsupportedPrintSettingError };

export interface NormalizedPrintSettings extends PrintSettings {
  printerName: string;
}

/**
 * Validates print submission parameters and enforces capability constraints.
 *
 * CRITICAL RULE: Fails closed against silent downgrades:
 * - A3 -> A4 downgrade is prohibited.
 * - COLOUR -> B&W downgrade is prohibited.
 * - DUPLEX -> SINGLE downgrade is prohibited.
 * - Malformed page ranges and invalid copy counts are strictly rejected.
 */
export function validateAndNormalizePrintSettings(
  submission: PrintSubmission,
  capabilities?: PrinterCapabilities,
): NormalizedPrintSettings {
  const printerName = (
    submission.settings?.printerName ?? submission.printerId
  ).trim();
  if (!printerName) {
    throw new InvalidPrintSettingError("Target printer name is required.");
  }
  if (printerName !== submission.printerId.trim()) {
    throw new InvalidPrintSettingError(
      "Printer setting must match the exact submitted printer ID.",
    );
  }
  if (/\p{Cc}|"/u.test(printerName)) {
    throw new InvalidPrintSettingError(
      "Printer name contains unsupported control or quote characters.",
    );
  }
  if (/\p{Cc}|"/u.test(submission.localPdfPath)) {
    throw new InvalidPrintSettingError(
      "PDF path contains unsupported control or quote characters.",
    );
  }

  const raw = submission.settings ?? {};

  // 1. Copies validation
  const copies = raw.copies ?? submission.copies ?? MIN_PRINT_COPIES;
  if (!Number.isInteger(copies) || copies < MIN_PRINT_COPIES) {
    throw new InvalidPrintSettingError(
      `Copies must be a positive integer, received: ${String(copies)}`,
    );
  }
  if (copies > MAX_PRINT_COPIES) {
    throw new InvalidPrintSettingError(
      `Copies exceeds maximum allowed limit (${MAX_PRINT_COPIES}), received: ${copies}`,
    );
  }

  // 2. Paper size validation (Fail closed on silent downgrade)
  const paperSize = raw.paperSize ?? "A4";
  if (paperSize !== "A4" && paperSize !== "A3") {
    throw new InvalidPrintSettingError(
      `Unsupported paper size '${String(paperSize)}'. Supported sizes are A4 and A3.`,
    );
  }
  if (!submission.isDiagnosticTestPrint) {
    if (submission.verifiedCapabilities) {
      if (paperSize === "A3" && submission.verifiedCapabilities.a3 !== true) {
        throw new UnsupportedPrintSettingError(
          `Printer '${printerName}' does not support paper size '${paperSize}'. Silent downgrade is prohibited.`,
        );
      }
      if (paperSize === "A4" && submission.verifiedCapabilities.a4 !== true) {
        throw new UnsupportedPrintSettingError(
          `Printer '${printerName}' does not support paper size '${paperSize}'. Silent downgrade is prohibited.`,
        );
      }
    } else if (
      capabilities &&
      capabilities.paperSizes &&
      capabilities.paperSizes.length > 0
    ) {
      const supportedUpper = capabilities.paperSizes.map((s) =>
        s.toUpperCase(),
      );
      if (!supportedUpper.includes(paperSize)) {
        throw new UnsupportedPrintSettingError(
          `Printer '${printerName}' does not support paper size '${paperSize}'. Silent downgrade is prohibited.`,
        );
      }
    }
  }

  // 3. Colour mode validation (Fail closed on silent downgrade)
  const colorMode = raw.colorMode ?? "BLACK_AND_WHITE";
  if (colorMode !== "COLOUR" && colorMode !== "BLACK_AND_WHITE") {
    throw new InvalidPrintSettingError(
      `Unsupported color mode '${String(colorMode)}'. Supported modes are COLOUR and BLACK_AND_WHITE.`,
    );
  }
  if (colorMode === "COLOUR" && !submission.isDiagnosticTestPrint) {
    if (submission.verifiedCapabilities) {
      if (submission.verifiedCapabilities.color !== true) {
        throw new UnsupportedPrintSettingError(
          `Printer '${printerName}' does not support colour printing. Silent downgrade to black and white is prohibited.`,
        );
      }
    } else if (!capabilities || capabilities.colour !== true) {
      throw new UnsupportedPrintSettingError(
        `Printer '${printerName}' does not support colour printing. Silent downgrade to black and white is prohibited.`,
      );
    }
  }

  // 4. Sides (duplex) validation (Fail closed on silent downgrade)
  const sides = raw.sides ?? "ONE_SIDED";
  if (
    sides !== "ONE_SIDED" &&
    sides !== "TWO_SIDED_LONG" &&
    sides !== "TWO_SIDED_SHORT"
  ) {
    throw new InvalidPrintSettingError(
      `Unsupported sides option '${String(sides)}'. Supported options are ONE_SIDED, TWO_SIDED_LONG, TWO_SIDED_SHORT.`,
    );
  }
  if (sides !== "ONE_SIDED" && !submission.isDiagnosticTestPrint) {
    if (submission.verifiedCapabilities) {
      if (submission.verifiedCapabilities.duplex !== true) {
        throw new UnsupportedPrintSettingError(
          `Printer '${printerName}' does not support double-sided (duplex) printing. Silent downgrade to single-sided is prohibited.`,
        );
      }
    } else if (!capabilities || capabilities.duplex !== true) {
      throw new UnsupportedPrintSettingError(
        `Printer '${printerName}' does not support double-sided (duplex) printing. Silent downgrade to single-sided is prohibited.`,
      );
    }
  }

  // 5. Page range validation
  let pageRange: string | undefined = undefined;
  if (raw.pageRange && raw.pageRange.trim().length > 0) {
    const trimmed = raw.pageRange.trim();
    if (trimmed.toLowerCase() !== "all") {
      try {
        const parsed = parsePageRange(trimmed);
        pageRange = parsed.normalized;
      } catch (err: unknown) {
        throw new InvalidPrintSettingError(
          `Invalid page range '${trimmed}': ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // 6. Orientation validation
  let orientation: "portrait" | "landscape" | undefined = undefined;
  if (raw.orientation) {
    if (raw.orientation !== "portrait" && raw.orientation !== "landscape") {
      throw new InvalidPrintSettingError(
        `Unsupported orientation '${String(raw.orientation)}'. Supported options are portrait and landscape.`,
      );
    }
    orientation = raw.orientation;
  }

  return {
    printerName,
    paperSize,
    colorMode,
    sides,
    copies,
    pageRange,
    ...(orientation ? { orientation } : {}),
  };
}
