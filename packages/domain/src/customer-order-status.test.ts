import { describe, expect, it } from "vitest";

import { ORDER_STATUSES } from "./vocabularies";
import {
  CUSTOMER_ORDER_STATUSES,
  toCustomerOrderStatus,
} from "./customer-order-status";

describe("customer order status mapping", () => {
  it.each(ORDER_STATUSES)(
    "maps internal status %s to safe wording",
    (status) => {
      const customer = toCustomerOrderStatus(status);
      expect(CUSTOMER_ORDER_STATUSES).toContain(customer.code);
      expect(customer.label).not.toMatch(/CLAIM|SPOOL|ADMIN|FAILED/iu);
      expect(customer.message).not.toMatch(/spooler|windows|toner|job id/iu);
    },
  );

  it("uses calm customer wording for printer and failure states", () => {
    expect(toCustomerOrderStatus("PRINT_BLOCKED")).toEqual(
      expect.objectContaining({
        code: "PRINTER_NEEDS_ATTENTION",
        label: "Printer needs attention",
      }),
    );
    expect(toCustomerOrderStatus("PRINT_FAILED")).toEqual(
      expect.objectContaining({ code: "SHOP_HANDLING_ISSUE" }),
    );
  });
});
