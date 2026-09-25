import {
  FILE_SIZE_25_MIB,
  FILE_SIZE_SERVICE_CHARGE_BANDS,
} from "./constants.js";

export interface FileSizeServiceChargeBand {
  minBytesExclusive: number;
  maxBytesInclusive: number;
}

export function getFileSizeServiceChargeBand(
  sizeBytes: number,
): FileSizeServiceChargeBand | undefined {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    return undefined;
  }

  if (sizeBytes > FILE_SIZE_25_MIB) {
    return undefined;
  }

  return FILE_SIZE_SERVICE_CHARGE_BANDS.find(
    ({ minBytesExclusive, maxBytesInclusive }) =>
      sizeBytes > minBytesExclusive && sizeBytes <= maxBytesInclusive,
  );
}
