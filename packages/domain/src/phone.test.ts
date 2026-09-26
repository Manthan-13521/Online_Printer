import { describe, expect, it } from "vitest";

import { maskPhoneNumber } from "./phone.js";

describe("maskPhoneNumber", () => {
  it("masks a standard 10-digit Indian mobile number preserving only last 4 digits", () => {
    expect(maskPhoneNumber("9876543210")).toBe("******3210");
    expect(maskPhoneNumber("8888804321")).toBe("******4321");
  });

  it("handles numbers with country code, spaces, and plus signs", () => {
    expect(maskPhoneNumber("+91 98765 43210")).toBe("******3210");
    expect(maskPhoneNumber("+91-9876543210")).toBe("******3210");
    expect(maskPhoneNumber("091 98765 43210")).toBe("******3210");
  });

  it("handles numbers with hyphens and parentheses", () => {
    expect(maskPhoneNumber("(022) 2345-6789")).toBe("******6789");
  });

  it("safely handles numbers with fewer than 4 digits without leaking", () => {
    expect(maskPhoneNumber("123")).toBe("******");
    expect(maskPhoneNumber("12")).toBe("******");
    expect(maskPhoneNumber("1")).toBe("******");
  });

  it("safely handles null, undefined, empty, and non-numeric inputs", () => {
    expect(maskPhoneNumber("")).toBe("******");
    expect(maskPhoneNumber("   ")).toBe("******");
    expect(maskPhoneNumber(null)).toBe("******");
    expect(maskPhoneNumber(undefined)).toBe("******");
    expect(maskPhoneNumber("abcdefg")).toBe("******");
  });

  it("never exposes more than 4 digits under any condition", () => {
    const outputs = [
      maskPhoneNumber("9999999999"),
      maskPhoneNumber("+919999999999"),
      maskPhoneNumber("123456789012345"),
    ];

    for (const out of outputs) {
      expect(out.startsWith("******")).toBe(true);
      const exposed = out.slice(6);
      expect(exposed.length).toBeLessThanOrEqual(4);
    }
  });
});
