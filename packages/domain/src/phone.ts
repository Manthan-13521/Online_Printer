/**
 * Centralized privacy utility for customer phone number masking.
 *
 * Ensures that full phone numbers are never printed on physical identification
 * sheets, exposed in operational logs, or displayed where only verification
 * digits are needed.
 */
export function maskPhoneNumber(phone: string | null | undefined): string {
  if (!phone || typeof phone !== "string") {
    return "******";
  }

  // Extract all numeric digits
  const digits = phone.replace(/\D/g, "");

  // If there are fewer than 4 digits, return generic mask without leaking
  if (digits.length < 4) {
    return "******";
  }

  // Retain only the trailing 4 digits
  const lastFour = digits.slice(-4);
  return `******${lastFour}`;
}
