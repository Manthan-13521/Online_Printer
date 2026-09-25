import { describe, expect, it } from "vitest";

import { moneyFromPaise } from "./index";

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
