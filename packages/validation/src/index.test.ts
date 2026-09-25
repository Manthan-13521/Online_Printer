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
  normalizeLoginIdentifier,
  validateAdminLoginInput,
  validateAdminPasswordChangeInput,
  validatePassword,
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
