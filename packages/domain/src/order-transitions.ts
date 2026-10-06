import type { OrderStatus } from "./vocabularies.js";

const ORDER_STATUS_TRANSITIONS = {
  CREATED: ["UPLOADING", "CANCELLED"],
  UPLOADING: ["UPLOADED", "CANCELLED"],
  UPLOADED: ["PAYMENT_PENDING", "CANCELLED"],
  PAYMENT_PENDING: ["PAID", "PAYMENT_FAILED", "PAYMENT_CANCELLED"],
  PAYMENT_FAILED: ["PAYMENT_PENDING", "CANCELLED"],
  PAYMENT_CANCELLED: ["PAYMENT_PENDING", "CANCELLED"],
  PAID: ["QUEUED", "MANUAL_PRINT"],
  QUEUED: ["CLAIMED"],
  CLAIMED: [
    "QUEUED",
    "SPOOLING",
    "PRINT_BLOCKED",
    "RETRY_PENDING",
    "NEEDS_ADMIN",
    "COMPLETION_UNKNOWN",
    "ADMIN_ACTION_REQUIRED",
  ],
  SPOOLING: [
    "PRINTING",
    "PRINT_BLOCKED",
    "PRINT_FAILED",
    "RETRY_PENDING",
    "NEEDS_ADMIN",
    "COMPLETION_UNKNOWN",
    "ADMIN_ACTION_REQUIRED",
  ],
  PRINTING: [
    "PRINT_BLOCKED",
    "PRINT_FAILED",
    "RETRY_PENDING",
    "NEEDS_ADMIN",
    "COMPLETION_UNKNOWN",
    "ADMIN_ACTION_REQUIRED",
    "PRINTED",
  ],
  PRINT_BLOCKED: [
    "CLAIMED",
    "SPOOLING",
    "PRINTING",
    "PRINT_FAILED",
    "RETRY_PENDING",
    "NEEDS_ADMIN",
    "COMPLETION_UNKNOWN",
    "ADMIN_ACTION_REQUIRED",
  ],
  PRINT_FAILED: [
    "QUEUED",
    "RETRY_PENDING",
    "NEEDS_ADMIN",
    "ADMIN_ACTION_REQUIRED",
  ],
  RETRY_PENDING: ["QUEUED", "CLAIMED", "NEEDS_ADMIN", "CANCELLED"],
  NEEDS_ADMIN: ["QUEUED", "PRINTED", "COMPLETED", "CANCELLED"],
  COMPLETION_UNKNOWN: ["QUEUED", "PRINTED", "COMPLETED", "CANCELLED"],
  ADMIN_ACTION_REQUIRED: ["QUEUED", "PRINTED", "COMPLETED", "CANCELLED"],
  PRINTED: ["COMPLETED", "AWAITING_FINISHING"],
  MANUAL_PRINT: ["AWAITING_FINISHING", "COMPLETED", "CANCELLED"],
  AWAITING_FINISHING: ["COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
} as const satisfies Record<OrderStatus, readonly OrderStatus[]>;

export function canTransitionOrderStatus(
  from: OrderStatus,
  to: OrderStatus,
): boolean {
  return (ORDER_STATUS_TRANSITIONS[from] as readonly OrderStatus[]).includes(
    to,
  );
}

export class InvalidOrderStatusTransitionError extends Error {
  constructor(from: OrderStatus, to: OrderStatus) {
    super(`Invalid order status transition: ${from} -> ${to}`);
    this.name = "InvalidOrderStatusTransitionError";
  }
}

export function assertOrderStatusTransition(
  from: OrderStatus,
  to: OrderStatus,
): void {
  if (!canTransitionOrderStatus(from, to)) {
    throw new InvalidOrderStatusTransitionError(from, to);
  }
}
