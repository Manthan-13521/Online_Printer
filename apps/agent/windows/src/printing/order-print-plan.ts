import type { IdentificationSheetPlacement } from "@printgo/domain";

export type OrderPrintPlanStep =
  | { readonly type: "IDENTIFICATION_SHEET"; readonly copies: 1 }
  | { readonly type: "CUSTOMER_DOCUMENT"; readonly copies: number };

export interface BuildOrderPrintPlanInput {
  identificationSheetEnabled: boolean;
  identificationSheetPlacement: IdentificationSheetPlacement;
  customerDocumentCopies: number;
}

/** Pure sequencing only: Phase 9 does not execute customer-document steps. */
export function buildOrderPrintPlan(
  input: BuildOrderPrintPlanInput,
): readonly OrderPrintPlanStep[] {
  if (
    !Number.isSafeInteger(input.customerDocumentCopies) ||
    input.customerDocumentCopies < 1
  ) {
    throw new RangeError(
      "Customer document copies must be a positive integer.",
    );
  }

  const customer: OrderPrintPlanStep = {
    type: "CUSTOMER_DOCUMENT",
    copies: input.customerDocumentCopies,
  };
  if (!input.identificationSheetEnabled) return [customer];

  const sheet: OrderPrintPlanStep = {
    type: "IDENTIFICATION_SHEET",
    copies: 1,
  };
  return input.identificationSheetPlacement === "FIRST"
    ? [sheet, customer]
    : [customer, sheet];
}
