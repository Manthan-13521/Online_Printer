import {
  COLOR_MODES,
  FILE_SIZE_25_MIB,
  FILE_SIZE_SERVICE_CHARGE_BANDS,
  PAPER_SIZES,
  SIDES_MODES,
  type ColorMode,
  type PaperSize,
  type SidesMode,
} from "@printgo/domain";

export interface PrintRateConfiguration {
  paperSize: PaperSize;
  colorMode: ColorMode;
  sides: SidesMode;
  pricePerPagePaise: number;
  enabled: boolean;
}

export interface FileSizeChargeConfiguration {
  minBytesExclusive: number;
  maxBytesInclusive: number;
  chargePaise: number;
  enabled: boolean;
}

export interface PricingConfiguration {
  maxPdfSizeBytes: number;
  printRates: readonly PrintRateConfiguration[];
  fileSizeServiceCharges: readonly FileSizeChargeConfiguration[];
}

export interface PriceCalculationInput {
  pageCount: number;
  copies: number;
  fileSizeBytes: number;
  paperSize: PaperSize;
  colorMode: ColorMode;
  sides: SidesMode;
}

export interface PriceCalculationResult {
  printingAmountPaise: number;
  serviceChargePaise: number;
  totalAmountPaise: number;
  currency: "INR";
  appliedRate: PrintRateConfiguration;
  appliedFileSizeBand: FileSizeChargeConfiguration;
}

export type PricingErrorCode =
  | "INVALID_PAGE_COUNT"
  | "INVALID_COPY_COUNT"
  | "INVALID_FILE_SIZE"
  | "PDF_TOO_LARGE"
  | "INVALID_PAPER_SIZE"
  | "INVALID_COLOR_MODE"
  | "INVALID_SIDES_MODE"
  | "PRINT_RATE_UNAVAILABLE"
  | "FILE_SIZE_BAND_MISSING"
  | "INVALID_PRICING_CONFIGURATION"
  | "PRICE_OVERFLOW";

export class PricingError extends Error {
  constructor(readonly code: PricingErrorCode) {
    super(code);
    this.name = "PricingError";
  }
}

function isOneOf<T extends string>(
  value: unknown,
  values: readonly T[],
): value is T {
  return typeof value === "string" && values.some((item) => item === value);
}

function rateKey(
  rate: Pick<PrintRateConfiguration, "paperSize" | "colorMode" | "sides">,
): string {
  return `${rate.paperSize}:${rate.colorMode}:${rate.sides}`;
}

export function validatePricingConfiguration(
  configuration: PricingConfiguration,
): void {
  if (
    !Number.isSafeInteger(configuration.maxPdfSizeBytes) ||
    configuration.maxPdfSizeBytes <= 0 ||
    configuration.maxPdfSizeBytes > FILE_SIZE_25_MIB
  ) {
    throw new PricingError("INVALID_PRICING_CONFIGURATION");
  }

  const rateKeys = new Set<string>();
  for (const rate of configuration.printRates) {
    if (
      !isOneOf(rate.paperSize, PAPER_SIZES) ||
      !isOneOf(rate.colorMode, COLOR_MODES) ||
      !isOneOf(rate.sides, SIDES_MODES) ||
      typeof rate.enabled !== "boolean" ||
      !Number.isSafeInteger(rate.pricePerPagePaise) ||
      rate.pricePerPagePaise < 0 ||
      rateKeys.has(rateKey(rate))
    ) {
      throw new PricingError("INVALID_PRICING_CONFIGURATION");
    }
    rateKeys.add(rateKey(rate));
  }

  if (
    rateKeys.size !==
    PAPER_SIZES.length * COLOR_MODES.length * SIDES_MODES.length
  ) {
    throw new PricingError("INVALID_PRICING_CONFIGURATION");
  }

  if (
    configuration.fileSizeServiceCharges.length !==
    FILE_SIZE_SERVICE_CHARGE_BANDS.length
  ) {
    throw new PricingError("INVALID_PRICING_CONFIGURATION");
  }
  for (const [index, expected] of FILE_SIZE_SERVICE_CHARGE_BANDS.entries()) {
    const actual = configuration.fileSizeServiceCharges[index];
    if (
      !actual ||
      actual.minBytesExclusive !== expected.minBytesExclusive ||
      actual.maxBytesInclusive !== expected.maxBytesInclusive ||
      typeof actual.enabled !== "boolean" ||
      !Number.isSafeInteger(actual.chargePaise) ||
      actual.chargePaise < 0
    ) {
      throw new PricingError("INVALID_PRICING_CONFIGURATION");
    }
  }
}

export function classifyFileSizeBand(
  fileSizeBytes: number,
  bands: readonly FileSizeChargeConfiguration[],
): FileSizeChargeConfiguration {
  const band = bands.find(
    (candidate) =>
      candidate.enabled &&
      fileSizeBytes > candidate.minBytesExclusive &&
      fileSizeBytes <= candidate.maxBytesInclusive,
  );
  if (!band) throw new PricingError("FILE_SIZE_BAND_MISSING");
  return band;
}

function safeMultiply(left: number, right: number): number {
  const result = left * right;
  if (!Number.isSafeInteger(result)) throw new PricingError("PRICE_OVERFLOW");
  return result;
}

export function calculatePrintPrice(
  input: PriceCalculationInput,
  configuration: PricingConfiguration,
): PriceCalculationResult {
  validatePricingConfiguration(configuration);

  if (!Number.isSafeInteger(input.pageCount) || input.pageCount <= 0) {
    throw new PricingError("INVALID_PAGE_COUNT");
  }
  if (!Number.isSafeInteger(input.copies) || input.copies <= 0) {
    throw new PricingError("INVALID_COPY_COUNT");
  }
  if (!Number.isSafeInteger(input.fileSizeBytes) || input.fileSizeBytes <= 0) {
    throw new PricingError("INVALID_FILE_SIZE");
  }
  if (input.fileSizeBytes > configuration.maxPdfSizeBytes) {
    throw new PricingError("PDF_TOO_LARGE");
  }
  if (!isOneOf(input.paperSize, PAPER_SIZES)) {
    throw new PricingError("INVALID_PAPER_SIZE");
  }
  if (!isOneOf(input.colorMode, COLOR_MODES)) {
    throw new PricingError("INVALID_COLOR_MODE");
  }
  if (!isOneOf(input.sides, SIDES_MODES)) {
    throw new PricingError("INVALID_SIDES_MODE");
  }

  const rate = configuration.printRates.find(
    (candidate) => candidate.enabled && rateKey(candidate) === rateKey(input),
  );
  if (!rate) throw new PricingError("PRINT_RATE_UNAVAILABLE");

  const band = classifyFileSizeBand(
    input.fileSizeBytes,
    configuration.fileSizeServiceCharges,
  );
  const printedPages = safeMultiply(input.pageCount, input.copies);
  const printingAmountPaise = safeMultiply(
    printedPages,
    rate.pricePerPagePaise,
  );
  const totalAmountPaise = printingAmountPaise + band.chargePaise;
  if (!Number.isSafeInteger(totalAmountPaise)) {
    throw new PricingError("PRICE_OVERFLOW");
  }

  return {
    printingAmountPaise,
    serviceChargePaise: band.chargePaise,
    totalAmountPaise,
    currency: "INR",
    appliedRate: { ...rate },
    appliedFileSizeBand: { ...band },
  };
}
