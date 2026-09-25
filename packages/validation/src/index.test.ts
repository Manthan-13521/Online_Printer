import { describe, expect, it } from "vitest";

import { FILE_SIZE_25_MIB } from "@printgo/domain";

import {
  isColorMode,
  isIntegerPaise,
  isOrderStatus,
  isPaperSize,
  isSidesMode,
  isValidCopies,
  isValidPdfSizeBytes,
} from "./index";

describe("foundational domain validation", () => {
  it("validates integer paise, copies, and PDF byte limits", () => {
    expect(isIntegerPaise(0)).toBe(true);
    expect(isIntegerPaise(1.5)).toBe(false);
    expect(isValidCopies(1)).toBe(true);
    expect(isValidCopies(0)).toBe(false);
    expect(isValidPdfSizeBytes(FILE_SIZE_25_MIB)).toBe(true);
    expect(isValidPdfSizeBytes(FILE_SIZE_25_MIB + 1)).toBe(false);
  });

  it("uses centralized vocabularies", () => {
    expect(isPaperSize("A4")).toBe(true);
    expect(isPaperSize("LETTER")).toBe(false);
    expect(isColorMode("COLOR")).toBe(true);
    expect(isColorMode("COLOUR")).toBe(false);
    expect(isSidesMode("DOUBLE")).toBe(true);
    expect(isOrderStatus("COMPLETED")).toBe(true);
    expect(isOrderStatus("FILE_EXPIRED")).toBe(false);
  });
});
