import { describe, expect, it } from "vitest";

import {
  indexToPickupCode,
  pickupCodeToIndex,
  TOTAL_PICKUP_CODES,
} from "./pickup-code";

describe("pickup code sequence generation and parsing", () => {
  it("formats the start of the sequence correctly", () => {
    expect(indexToPickupCode(0)).toBe("PA-001");
    expect(indexToPickupCode(1)).toBe("PA-002");
    expect(indexToPickupCode(998)).toBe("PA-999");
  });

  it("advances letter correctly at boundary", () => {
    expect(indexToPickupCode(999)).toBe("PB-001");
    expect(indexToPickupCode(1997)).toBe("PB-999");
    expect(indexToPickupCode(1998)).toBe("PC-001");
  });

  it("formats end of sequence and wraps cleanly", () => {
    expect(indexToPickupCode(25973)).toBe("PZ-999");
    expect(indexToPickupCode(25974)).toBe("PA-001");
    expect(indexToPickupCode(TOTAL_PICKUP_CODES)).toBe("PA-001");
    expect(indexToPickupCode(TOTAL_PICKUP_CODES + 1)).toBe("PA-002");
  });

  it("handles negative indices gracefully", () => {
    expect(indexToPickupCode(-1)).toBe("PZ-999");
  });

  it("parses valid pickup codes back to exact indices", () => {
    expect(pickupCodeToIndex("PA-001")).toBe(0);
    expect(pickupCodeToIndex("PA-999")).toBe(998);
    expect(pickupCodeToIndex("PB-001")).toBe(999);
    expect(pickupCodeToIndex("PZ-999")).toBe(25973);
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(pickupCodeToIndex("  pa-001 ")).toBe(0);
    expect(pickupCodeToIndex("pz-999")).toBe(25973);
  });

  it("returns null for invalid codes", () => {
    expect(pickupCodeToIndex("PA-000")).toBeNull();
    expect(pickupCodeToIndex("PA-1000")).toBeNull();
    expect(pickupCodeToIndex("P1-001")).toBeNull();
    expect(pickupCodeToIndex("QA-001")).toBeNull();
    expect(pickupCodeToIndex("INVALID")).toBeNull();
  });
});
