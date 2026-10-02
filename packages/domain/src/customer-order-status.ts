import type { OrderStatus } from "./vocabularies.js";

export const CUSTOMER_ORDER_STATUSES = [
  "PREPARING",
  "PAYMENT_PENDING",
  "PAYMENT_NOT_RECEIVED",
  "WAITING_TO_PRINT",
  "PRINTING",
  "PRINTER_NEEDS_ATTENTION",
  "SHOP_HANDLING_ISSUE",
  "PRINTED",
  "WAITING_FOR_STAFF",
  "FINISHING",
  "COMPLETED",
  "CANCELLED",
] as const;

export type CustomerOrderStatus = (typeof CUSTOMER_ORDER_STATUSES)[number];

export interface CustomerOrderStatusPresentation {
  code: CustomerOrderStatus;
  label: string;
  message: string;
}

export const CUSTOMER_ORDER_STATUS_PRESENTATION: Readonly<
  Record<CustomerOrderStatus, CustomerOrderStatusPresentation>
> = {
  PREPARING: {
    code: "PREPARING",
    label: "Preparing order",
    message: "Your print request is being prepared.",
  },
  PAYMENT_PENDING: {
    code: "PAYMENT_PENDING",
    label: "Confirming payment",
    message: "The shop is confirming your payment.",
  },
  PAYMENT_NOT_RECEIVED: {
    code: "PAYMENT_NOT_RECEIVED",
    label: "Payment not received",
    message: "A verified payment was not received for this request.",
  },
  WAITING_TO_PRINT: {
    code: "WAITING_TO_PRINT",
    label: "Waiting to print",
    message: "Your paid print job is waiting for the shop printer.",
  },
  PRINTING: {
    code: "PRINTING",
    label: "Printing",
    message: "Your document is being printed.",
  },
  PRINTER_NEEDS_ATTENTION: {
    code: "PRINTER_NEEDS_ATTENTION",
    label: "Printer needs attention",
    message: "The printer needs attention. The shop is handling it.",
  },
  SHOP_HANDLING_ISSUE: {
    code: "SHOP_HANDLING_ISSUE",
    label: "Shop is handling a print issue",
    message: "The shop is handling an issue with your print job.",
  },
  PRINTED: {
    code: "PRINTED",
    label: "Printed",
    message: "Your document has been printed.",
  },
  WAITING_FOR_STAFF: {
    code: "WAITING_FOR_STAFF",
    label: "Waiting for Staff",
    message:
      "Your order requires manual handling and is waiting for shop staff.",
  },
  FINISHING: {
    code: "FINISHING",
    label: "Finishing",
    message: "Your documents are printed and undergoing staff finishing.",
  },
  COMPLETED: {
    code: "COMPLETED",
    label: "Completed",
    message: "Your print job is complete.",
  },
  CANCELLED: {
    code: "CANCELLED",
    label: "Cancelled",
    message: "This print job was cancelled.",
  },
};

export function toCustomerOrderStatus(
  status: OrderStatus,
): CustomerOrderStatusPresentation {
  switch (status) {
    case "CREATED":
    case "UPLOADING":
    case "UPLOADED":
      return CUSTOMER_ORDER_STATUS_PRESENTATION.PREPARING;
    case "PAYMENT_PENDING":
      return CUSTOMER_ORDER_STATUS_PRESENTATION.PAYMENT_PENDING;
    case "PAYMENT_FAILED":
    case "PAYMENT_CANCELLED":
      return CUSTOMER_ORDER_STATUS_PRESENTATION.PAYMENT_NOT_RECEIVED;
    case "PAID":
    case "QUEUED":
    case "CLAIMED":
      return CUSTOMER_ORDER_STATUS_PRESENTATION.WAITING_TO_PRINT;
    case "SPOOLING":
    case "PRINTING":
      return CUSTOMER_ORDER_STATUS_PRESENTATION.PRINTING;
    case "PRINT_BLOCKED":
      return CUSTOMER_ORDER_STATUS_PRESENTATION.PRINTER_NEEDS_ATTENTION;
    case "PRINT_FAILED":
    case "ADMIN_ACTION_REQUIRED":
      return CUSTOMER_ORDER_STATUS_PRESENTATION.SHOP_HANDLING_ISSUE;
    case "RETRY_PENDING":
      return CUSTOMER_ORDER_STATUS_PRESENTATION.WAITING_TO_PRINT;
    case "NEEDS_ADMIN":
    case "COMPLETION_UNKNOWN":
    case "MANUAL_PRINT":
      return CUSTOMER_ORDER_STATUS_PRESENTATION.WAITING_FOR_STAFF;
    case "PRINTED":
      return CUSTOMER_ORDER_STATUS_PRESENTATION.PRINTED;
    case "AWAITING_FINISHING":
      return CUSTOMER_ORDER_STATUS_PRESENTATION.FINISHING;
    case "COMPLETED":
      return CUSTOMER_ORDER_STATUS_PRESENTATION.COMPLETED;
    case "CANCELLED":
      return CUSTOMER_ORDER_STATUS_PRESENTATION.CANCELLED;
  }
}
