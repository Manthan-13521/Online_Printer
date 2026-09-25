import { describe, expect, it } from "vitest";

import {
  assertOrderStatusTransition,
  canTransitionOrderStatus,
} from "./order-transitions";
import type { OrderStatus } from "./vocabularies";

describe("order status transitions", () => {
  it("accepts the normal paid print path", () => {
    const path: readonly OrderStatus[] = [
      "CREATED",
      "UPLOADING",
      "UPLOADED",
      "PAYMENT_PENDING",
      "PAID",
      "QUEUED",
      "CLAIMED",
      "SPOOLING",
      "PRINTING",
      "PRINTED",
      "COMPLETED",
    ];

    for (let index = 0; index < path.length - 1; index += 1) {
      expect(canTransitionOrderStatus(path[index]!, path[index + 1]!)).toBe(
        true,
      );
    }
  });

  it("rejects skipped workflow states", () => {
    expect(canTransitionOrderStatus("CREATED", "PAID")).toBe(false);
    expect(() => assertOrderStatusTransition("QUEUED", "PRINTING")).toThrow(
      "Invalid order status transition: QUEUED -> PRINTING",
    );
  });

  it("allows a blocked existing spool job to resume without a new claim", () => {
    expect(canTransitionOrderStatus("PRINTING", "PRINT_BLOCKED")).toBe(true);
    expect(canTransitionOrderStatus("PRINT_BLOCKED", "PRINTING")).toBe(true);
    expect(canTransitionOrderStatus("PRINT_BLOCKED", "QUEUED")).toBe(false);
  });

  it("allows a confirmed failure to follow a controlled retry path", () => {
    expect(canTransitionOrderStatus("PRINTING", "PRINT_FAILED")).toBe(true);
    expect(canTransitionOrderStatus("PRINT_FAILED", "QUEUED")).toBe(true);
    expect(
      canTransitionOrderStatus("PRINT_FAILED", "ADMIN_ACTION_REQUIRED"),
    ).toBe(true);
  });

  it("treats completed and cancelled orders as terminal", () => {
    expect(canTransitionOrderStatus("COMPLETED", "QUEUED")).toBe(false);
    expect(canTransitionOrderStatus("CANCELLED", "CREATED")).toBe(false);
  });
});
