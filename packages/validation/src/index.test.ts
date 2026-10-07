import { describe, expect, it } from "vitest";

import {
  FILE_SIZE_25_MIB,
  FILE_SIZE_SERVICE_CHARGE_BANDS,
} from "@printgo/domain";

import {
  isColorMode,
  isIntegerPaise,
  isOrderStatus,
  isPaperSize,
  isSidesMode,
  isValidCopies,
  isValidPdfSizeBytes,
  normalizeLoginIdentifier,
  validateAdminLoginInput,
  validateAdminPasswordChangeInput,
  validatePassword,
  validatePricingUpdateInput,
  validateShopSettingsInput,
} from "./index";

const validSettings = {
  shopName: "ABC Xerox",
  contactPhone: "+91 98765 43210",
  address: "Main Road",
  customerNotice: "Collect before 8 PM.",
  onlinePrintingEnabled: true,
  maxPdfSizeBytes: 10 * 1024 * 1024,
};

const validRates = (["A4", "A3"] as const).flatMap((paperSize) =>
  (["BW", "COLOR"] as const).flatMap((colorMode) =>
    (["SINGLE", "DOUBLE"] as const).map((sides) => ({
      paperSize,
      colorMode,
      sides,
      pricePerPagePaise: 200,
      enabled: true,
    })),
  ),
);

const validCharges = FILE_SIZE_SERVICE_CHARGE_BANDS.map((band) => ({
  ...band,
  chargePaise: 100,
}));

describe("foundational domain validation", () => {
  it("validates integer paise, copies, and PDF byte limits", () => {
    expect(isIntegerPaise(0)).toBe(true);
    expect(isIntegerPaise(1.5)).toBe(false);
    expect(isValidCopies(1)).toBe(true);
    expect(isValidCopies(100)).toBe(true);
    expect(isValidCopies(0)).toBe(false);
    expect(isValidCopies(-1)).toBe(false);
    expect(isValidCopies(101)).toBe(false);
    expect(isValidCopies(1_000_000)).toBe(false);
    expect(isValidCopies(1.5)).toBe(false);
    expect(isValidCopies("1")).toBe(false);
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

describe("admin authentication validation", () => {
  it("normalizes login identifiers but never changes passwords", () => {
    expect(normalizeLoginIdentifier("  Shop-ADMIN  ")).toBe("shop-admin");
    const result = validateAdminLoginInput({
      loginIdentifier: " ADMIN ",
      password: "  spaced passphrase  ",
    });
    expect(result).toEqual({
      ok: true,
      value: {
        loginIdentifier: "admin",
        password: "  spaced passphrase  ",
      },
    });
  });

  it("enforces password length without arbitrary complexity rules", () => {
    expect(validatePassword("").ok).toBe(false);
    expect(validatePassword("all words are fine").ok).toBe(true);
    expect(validatePassword("x".repeat(129)).ok).toBe(false);
  });

  it("rejects mismatched password confirmation", () => {
    expect(
      validateAdminPasswordChangeInput({
        currentPassword: "current password",
        newPassword: "new long password",
        confirmNewPassword: "different pass",
      }).ok,
    ).toBe(false);
  });
});

describe("shop settings validation", () => {
  it("accepts and trims a complete single-shop configuration", () => {
    const result = validateShopSettingsInput({
      ...validSettings,
      shopName: "  ABC Xerox  ",
      address: "  Main Road  ",
    });
    expect(result).toEqual({
      ok: true,
      value: { ...validSettings, shopName: "ABC Xerox" },
    });
  });

  it.each([
    [{ ...validSettings, shopName: "" }, "shopName"],
    [{ ...validSettings, shopName: "x".repeat(101) }, "shopName"],
    [
      { ...validSettings, maxPdfSizeBytes: FILE_SIZE_25_MIB + 1 },
      "maxPdfSizeBytes",
    ],
    [{ ...validSettings, maxPdfSizeBytes: 0 }, "maxPdfSizeBytes"],
    [
      { ...validSettings, onlinePrintingEnabled: "yes" },
      "onlinePrintingEnabled",
    ],
    [{ ...validSettings, customerNotice: "x".repeat(301) }, "customerNotice"],
  ])("rejects invalid settings at %s", (input, expectedPath) => {
    const result = validateShopSettingsInput(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some((issue) => issue.path[0] === expectedPath),
      ).toBe(true);
    }
  });

  it("treats customer notices as inert plain text data", () => {
    const notice = '<img src=x onerror="alert(1)">';
    const result = validateShopSettingsInput({
      ...validSettings,
      customerNotice: notice,
    });
    expect(result).toEqual({
      ok: true,
      value: { ...validSettings, customerNotice: notice },
    });
  });
});

describe("pricing configuration validation", () => {
  it("accepts all eight unique rates and the four fixed service bands", () => {
    expect(
      validatePricingUpdateInput({
        printRates: validRates,
        fileSizeServiceCharges: validCharges,
      }).ok,
    ).toBe(true);
  });

  it("rejects duplicate rates, negative paise, and changed band boundaries", () => {
    const duplicate = validRates.map((rate, index) =>
      index === 7 ? { ...validRates[0] } : rate,
    );
    expect(
      validatePricingUpdateInput({
        printRates: duplicate,
        fileSizeServiceCharges: validCharges,
      }).ok,
    ).toBe(false);
    expect(
      validatePricingUpdateInput({
        printRates: validRates.map((rate, index) =>
          index === 0 ? { ...rate, pricePerPagePaise: -1 } : rate,
        ),
        fileSizeServiceCharges: validCharges,
      }).ok,
    ).toBe(false);
    expect(
      validatePricingUpdateInput({
        printRates: validRates,
        fileSizeServiceCharges: validCharges.map((band, index) =>
          index === 0
            ? { ...band, maxBytesInclusive: band.maxBytesInclusive + 1 }
            : band,
        ),
      }).ok,
    ).toBe(false);
  });

  it("validates priorityPrinting configuration and passes it through", () => {
    const valid = validatePricingUpdateInput({
      printRates: validRates,
      fileSizeServiceCharges: validCharges,
      priorityPrinting: {
        enabled: true,
        feePaise: 2500,
      },
    });
    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect(valid.value.priorityPrinting).toEqual({
        enabled: true,
        feePaise: 2500,
      });
    }

    const invalidFee = validatePricingUpdateInput({
      printRates: validRates,
      fileSizeServiceCharges: validCharges,
      priorityPrinting: {
        enabled: true,
        feePaise: -100,
      },
    });
    expect(invalidFee.ok).toBe(false);
  });
});
