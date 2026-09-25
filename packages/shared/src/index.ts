export const BYTES_PER_MIB = 1_048_576;

export function mebibytesToBytes(mebibytes: number): number {
  if (!Number.isSafeInteger(mebibytes) || mebibytes < 0) {
    throw new RangeError("File-size MiB values must be non-negative integers.");
  }

  return mebibytes * BYTES_PER_MIB;
}

export function isAtOrBelowByteLimit(
  sizeBytes: number,
  limitBytes: number,
): boolean {
  if (
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes < 0 ||
    !Number.isSafeInteger(limitBytes) ||
    limitBytes < 0
  ) {
    throw new RangeError("File sizes and limits must be non-negative bytes.");
  }

  return sizeBytes <= limitBytes;
}
