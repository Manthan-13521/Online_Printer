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

export function parseRupeesToPaise(value: string): number | null {
  const normalized = value.trim();
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/u.exec(normalized);
  if (!match) return null;
  const rupees = Number(match[1]);
  const fraction = (match[2] ?? "").padEnd(2, "0");
  const paise = rupees * 100 + Number(fraction);
  return Number.isSafeInteger(paise) ? paise : null;
}

export function formatPaiseAsRupeesInput(amountPaise: number): string {
  const money = moneyFromPaise(amountPaise);
  const rupees = Math.floor(money.amountPaise / 100);
  const paise = money.amountPaise % 100;
  return paise === 0
    ? String(rupees)
    : `${rupees}.${String(paise).padStart(2, "0")}`;
}

export function formatInr(amountPaise: number): string {
  const money = moneyFromPaise(amountPaise);
  const rupees = Math.floor(money.amountPaise / 100);
  const paise = String(money.amountPaise % 100).padStart(2, "0");
  return `₹${rupees.toLocaleString("en-IN")}.${paise}`;
}
