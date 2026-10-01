export const TOTAL_PICKUP_CODES = 26 * 999; // 25,974

/**
 * Converts a 0-based sequence index (0 .. 25973) into a pickup code.
 * Pattern: PA-001 ... PA-999, PB-001 ... PB-999, ..., PZ-999.
 * Wraps safely on overflow.
 */
export function indexToPickupCode(index: number): string {
  const normalized =
    ((index % TOTAL_PICKUP_CODES) + TOTAL_PICKUP_CODES) % TOTAL_PICKUP_CODES;
  const letterIndex = Math.floor(normalized / 999);
  const letter = String.fromCharCode(65 + letterIndex);
  const num = (normalized % 999) + 1;
  return `P${letter}-${num.toString().padStart(3, "0")}`;
}

/**
 * Converts a formatted pickup code (e.g. "PA-001" or "PZ-999") back to its 0-based sequence index.
 * Returns null if the code does not match the valid format.
 */
export function pickupCodeToIndex(code: string): number | null {
  const match = /^P([A-Z])-(\d{3})$/.exec(code.trim().toUpperCase());
  if (!match || !match[1] || !match[2]) return null;
  const letterIndex = match[1].charCodeAt(0) - 65;
  const num = parseInt(match[2], 10);
  if (letterIndex < 0 || letterIndex > 25 || num < 1 || num > 999) return null;
  return letterIndex * 999 + (num - 1);
}

export const PICKUP_CODE_PATTERN = /^P[A-Z]-\d{3}$/;
