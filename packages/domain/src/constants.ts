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
export const DAY_MS = 24 * HOUR_MS;
export const UNPAID_RETENTION_MS = 10 * MINUTE_MS;
export const FAILED_OR_CANCELLED_PAYMENT_RETENTION_MS = 30 * MINUTE_MS;
export const COMPLETED_RETENTION_MS = 1 * HOUR_MS;
export const COMPLETED_PDF_RETENTION_MS = 1 * HOUR_MS;
export const COMPLETED_CUSTOMER_PII_PURGE_MS = 5 * HOUR_MS;
export const UNRESOLVED_PAID_FAILURE_RETENTION_MS = 24 * HOUR_MS;
export const CUSTOMER_TRACKING_LIFETIME_MS = 14 * DAY_MS;
export const AGENT_PAIR_CODE_LIFETIME_MS = 10 * MINUTE_MS;
export const AGENT_HEARTBEAT_INTERVAL_MS = 30 * 1_000;
export const AGENT_HEARTBEAT_TIMEOUT_MS = 90 * 1_000;
export const TEST_PRINT_COMMAND_LIFETIME_MS = 5 * MINUTE_MS;
export const PRINT_CLAIM_LEASE_MS = 5 * MINUTE_MS;
export const PRINT_DOWNLOAD_AUTHORIZATION_MS = 5 * MINUTE_MS;
export const MIN_PRINT_COPIES = 1;
export const MAX_PRINT_COPIES = 100;
export const WEBHOOK_PROCESSING_STALE_TIMEOUT_MS = 5 * MINUTE_MS;
