const PAIR_CODE_ALPHABET = "0123456789";
const PAIR_CODE_LENGTH = 8;

export function generatePairCode(
  fillRandom: (bytes: Uint8Array) => Uint8Array = (bytes) =>
    crypto.getRandomValues(bytes),
): string {
  const bytes = fillRandom(new Uint8Array(PAIR_CODE_LENGTH));
  let code = "";
  for (let i = 0; i < PAIR_CODE_LENGTH; i += 1) {
    if (i === 4) code += "-";
    code += PAIR_CODE_ALPHABET[(bytes[i] ?? 0) % PAIR_CODE_ALPHABET.length];
  }
  return code;
}

export function normalizePairCode(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replaceAll("-", "")
    .replaceAll(/\s+/gu, "")
    .replaceAll("O", "0")
    .replaceAll("I", "1")
    .replaceAll("L", "1");
}

export function generateAgentSecret(
  fillRandom: (bytes: Uint8Array) => Uint8Array = (bytes) =>
    crypto.getRandomValues(bytes),
): string {
  const bytes = fillRandom(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}
