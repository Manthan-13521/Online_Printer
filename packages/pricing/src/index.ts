export type CurrencyCode = "INR";

export interface Money {
  /** Integer smallest currency units. INR values are paise. */
  amountPaise: number;
  currency: CurrencyCode;
}

export function moneyFromPaise(amountPaise: number): Money {
  if (!Number.isSafeInteger(amountPaise) || amountPaise < 0) {
    throw new RangeError("Money must be a non-negative safe integer in paise.");
  }

  return { amountPaise, currency: "INR" };
}
