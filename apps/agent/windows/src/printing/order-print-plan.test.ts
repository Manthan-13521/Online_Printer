import { describe, expect, it } from "vitest";

import { buildOrderPrintPlan } from "./order-print-plan.js";

describe("buildOrderPrintPlan", () => {
  it("places exactly one identification sheet first", () => {
    expect(
      buildOrderPrintPlan({
        identificationSheetEnabled: true,
        identificationSheetPlacement: "FIRST",
        customerDocumentCopies: 10,
      }),
    ).toEqual([
      { type: "IDENTIFICATION_SHEET", copies: 1 },
      { type: "CUSTOMER_DOCUMENT", copies: 10 },
    ]);
  });

  it("places exactly one identification sheet last", () => {
    expect(
      buildOrderPrintPlan({
        identificationSheetEnabled: true,
        identificationSheetPlacement: "LAST",
        customerDocumentCopies: 3,
      }),
    ).toEqual([
      { type: "CUSTOMER_DOCUMENT", copies: 3 },
      { type: "IDENTIFICATION_SHEET", copies: 1 },
    ]);
  });

  it("omits the identification sheet when disabled", () => {
    expect(
      buildOrderPrintPlan({
        identificationSheetEnabled: false,
        identificationSheetPlacement: "FIRST",
        customerDocumentCopies: 2,
      }),
    ).toEqual([{ type: "CUSTOMER_DOCUMENT", copies: 2 }]);
  });

  it("rejects an invalid customer copy count", () => {
    expect(() =>
      buildOrderPrintPlan({
        identificationSheetEnabled: true,
        identificationSheetPlacement: "FIRST",
        customerDocumentCopies: 0,
      }),
    ).toThrow(/positive integer/i);
  });
});
