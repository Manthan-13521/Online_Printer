import { parsePageRange } from "@printgo/domain";
import type {
  PrinterCapabilities,
  PrintSettings,
  PrintSubmission,
} from "./printer-adapter.js";
import {
  InvalidPrintSettingError,
  UnsupportedPrintSettingError,
} from "./printer-adapter.js";

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
  const copies = raw.copies ?? submission.copies ?? 1;
  if (!Number.isInteger(copies) || copies < 1) {
    throw new InvalidPrintSettingError(
      `Copies must be a positive integer, received: ${String(copies)}`,
    );
  }
  if (copies > 100) {
    throw new InvalidPrintSettingError(
      `Copies exceeds maximum allowed limit (100), received: ${copies}`,
    );
  }

  // 2. Paper size validation (Fail closed on silent downgrade)
  const paperSize = raw.paperSize ?? "A4";
  if (paperSize !== "A4" && paperSize !== "A3") {
    throw new InvalidPrintSettingError(
      `Unsupported paper size '${String(paperSize)}'. Supported sizes are A4 and A3.`,
    );
  }
  if (
    capabilities &&
    capabilities.paperSizes &&
    capabilities.paperSizes.length > 0
  ) {
    const supportedUpper = capabilities.paperSizes.map((s) => s.toUpperCase());
    if (!supportedUpper.includes(paperSize)) {
      throw new UnsupportedPrintSettingError(
        `Printer '${printerName}' does not support paper size '${paperSize}'. Silent downgrade is prohibited.`,
      );
    }
  }

  // 3. Colour mode validation (Fail closed on silent downgrade)
  const colorMode = raw.colorMode ?? "BLACK_AND_WHITE";
  if (colorMode !== "COLOUR" && colorMode !== "BLACK_AND_WHITE") {
    throw new InvalidPrintSettingError(
      `Unsupported color mode '${String(colorMode)}'. Supported modes are COLOUR and BLACK_AND_WHITE.`,
    );
  }
  if (colorMode === "COLOUR" && capabilities && capabilities.colour === false) {
    throw new UnsupportedPrintSettingError(
      `Printer '${printerName}' does not support colour printing. Silent downgrade to black and white is prohibited.`,
    );
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
  if (sides !== "ONE_SIDED" && capabilities && capabilities.duplex === false) {
    throw new UnsupportedPrintSettingError(
      `Printer '${printerName}' does not support double-sided (duplex) printing. Silent downgrade to single-sided is prohibited.`,
    );
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

  return {
    printerName,
    paperSize,
    colorMode,
    sides,
    copies,
    pageRange,
  };
}
