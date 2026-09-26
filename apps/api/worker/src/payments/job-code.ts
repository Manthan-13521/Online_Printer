const JOB_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const JOB_CODE_LENGTH = 6;

export function generateJobCode(
  fillRandom: (bytes: Uint8Array) => Uint8Array = (bytes) =>
    crypto.getRandomValues(bytes),
): string {
  const bytes = fillRandom(new Uint8Array(JOB_CODE_LENGTH));
  let suffix = "";
  for (const byte of bytes) {
    suffix += JOB_CODE_ALPHABET[byte % JOB_CODE_ALPHABET.length];
  }
  return `PG-${suffix}`;
}
