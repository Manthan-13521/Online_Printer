import { BYTES_PER_MIB } from "@printgo/shared";

export const MIB = BYTES_PER_MIB;
export const FILE_SIZE_2_MIB = 2 * MIB;
export const FILE_SIZE_5_MIB = 5 * MIB;
export const FILE_SIZE_10_MIB = 10 * MIB;
export const FILE_SIZE_25_MIB = 25 * MIB;

export const FILE_SIZE_SERVICE_CHARGE_BANDS = [
  { minBytesExclusive: 0, maxBytesInclusive: FILE_SIZE_2_MIB },
  {
    minBytesExclusive: FILE_SIZE_2_MIB,
    maxBytesInclusive: FILE_SIZE_5_MIB,
  },
  {
    minBytesExclusive: FILE_SIZE_5_MIB,
    maxBytesInclusive: FILE_SIZE_10_MIB,
  },
  {
    minBytesExclusive: FILE_SIZE_10_MIB,
    maxBytesInclusive: FILE_SIZE_25_MIB,
  },
] as const;

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const UNPAID_RETENTION_MS = 10 * MINUTE_MS;
export const FAILED_OR_CANCELLED_PAYMENT_RETENTION_MS = 30 * MINUTE_MS;
export const COMPLETED_RETENTION_MS = 12 * HOUR_MS;
export const UNRESOLVED_PAID_FAILURE_RETENTION_MS = 24 * HOUR_MS;
