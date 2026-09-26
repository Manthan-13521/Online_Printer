import { describe, expect, it } from "vitest";

import {
  COMPLETED_RETENTION_MS,
  FAILED_OR_CANCELLED_PAYMENT_RETENTION_MS,
  FILE_SIZE_2_MIB,
  FILE_SIZE_5_MIB,
  FILE_SIZE_10_MIB,
  FILE_SIZE_25_MIB,
  CUSTOMER_TRACKING_LIFETIME_MS,
  AGENT_PAIR_CODE_LIFETIME_MS,
  AGENT_HEARTBEAT_INTERVAL_MS,
  AGENT_HEARTBEAT_TIMEOUT_MS,
  UNPAID_RETENTION_MS,
  UNRESOLVED_PAID_FAILURE_RETENTION_MS,
} from "./constants";
import { getFileSizeServiceChargeBand } from "./file-size";

describe("file-size service-charge boundaries", () => {
  it.each([
    [FILE_SIZE_2_MIB, FILE_SIZE_2_MIB],
    [FILE_SIZE_2_MIB + 1, FILE_SIZE_5_MIB],
    [FILE_SIZE_5_MIB, FILE_SIZE_5_MIB],
    [FILE_SIZE_5_MIB + 1, FILE_SIZE_10_MIB],
    [FILE_SIZE_10_MIB, FILE_SIZE_10_MIB],
    [FILE_SIZE_10_MIB + 1, FILE_SIZE_25_MIB],
    [FILE_SIZE_25_MIB, FILE_SIZE_25_MIB],
  ])("places %i bytes in the band ending at %i", (size, maximum) => {
    expect(getFileSizeServiceChargeBand(size)?.maxBytesInclusive).toBe(maximum);
  });

  it("rejects one byte above the V1 ceiling", () => {
    expect(getFileSizeServiceChargeBand(FILE_SIZE_25_MIB + 1)).toBeUndefined();
  });
});

describe("retention constants", () => {
  it("matches the finalized retention and agent durations exactly", () => {
    expect(UNPAID_RETENTION_MS).toBe(10 * 60 * 1_000);
    expect(FAILED_OR_CANCELLED_PAYMENT_RETENTION_MS).toBe(30 * 60 * 1_000);
    expect(COMPLETED_RETENTION_MS).toBe(12 * 60 * 60 * 1_000);
    expect(UNRESOLVED_PAID_FAILURE_RETENTION_MS).toBe(24 * 60 * 60 * 1_000);
    expect(CUSTOMER_TRACKING_LIFETIME_MS).toBe(14 * 24 * 60 * 60 * 1_000);
    expect(AGENT_PAIR_CODE_LIFETIME_MS).toBe(10 * 60 * 1_000);
    expect(AGENT_HEARTBEAT_INTERVAL_MS).toBe(30 * 1_000);
    expect(AGENT_HEARTBEAT_TIMEOUT_MS).toBe(90 * 1_000);
  });
});
