import { describe, expect, it } from "vitest";

import {
  formatInr,
  formatPaiseAsRupeesInput,
  moneyFromPaise,
  parseRupeesToPaise,
} from "./index";

describe("money foundations", () => {
  it("keeps authoritative INR values as integer paise", () => {
    expect(moneyFromPaise(4_200)).toEqual({
      amountPaise: 4_200,
      currency: "INR",
    });
  });

  it("rejects negative and fractional paise", () => {
    expect(() => moneyFromPaise(-1)).toThrow(RangeError);
    expect(() => moneyFromPaise(19.99)).toThrow(RangeError);
  });
});

describe("rupee input and display", () => {
  it.each([
    ["0", 0],
    ["2", 200],
    ["2.5", 250],
    ["2.50", 250],
    ["0.01", 1],
    ["10.00", 1_000],
  ])("parses %s exactly as %i paise", (input, expected) => {
    expect(parseRupeesToPaise(input)).toBe(expected);
  });

  it.each(["-1", "2.001", "abc", "", "NaN", "Infinity"])(
    "rejects invalid rupee input %j",
    (input) => {
      expect(parseRupeesToPaise(input)).toBeNull();
    },
  );

  it("formats paise without using floating-point money", () => {
    expect(formatInr(200)).toBe("₹2.00");
    expect(formatInr(250)).toBe("₹2.50");
    expect(formatInr(1_000)).toBe("₹10.00");
    expect(formatPaiseAsRupeesInput(250)).toBe("2.50");
  });
});
