import type { CustomerOrderStatus } from "@printgo/domain";

export function getFigmaStageIndex(status: CustomerOrderStatus): number {
  switch (status) {
    // 0 = MOBILE (UPLOADING/PREPARING)
    case "PREPARING":
      return 0;

    // 1 = CLOUD (PROCESSING / PAYMENT)
    case "PAYMENT_PENDING":
      return 1;

    // 2 = PROCESSING (STAFF HANDLING / MANUAL)
    case "WAITING_FOR_STAFF":
      return 2;

    // 3 = PRINT QUEUE (QUEUED)
    case "WAITING_TO_PRINT":
      return 3;

    // 4 = PRINTER (PRINTING)
    case "PRINTING":
      return 4;

    // 5 = FINISHING (FINISHING)
    case "FINISHING":
      return 5;

    case "PRINTED":
      return 5;

    // 6 = READY / COMPLETED
    case "COMPLETED":
      return 6;

    // For error states (CANCELLED, PAYMENT_NOT_RECEIVED, etc)
    // We handle them separately in the UI rather than as a progress step.
    default:
      return -1;
  }
}

export function getFigmaStageIndexPublic(status: string): number {
  switch (status) {
    case "QUEUED":
    case "PRIORITY_QUEUE":
    case "RETRYING":
      return 3; // PRINT QUEUE

    case "WAITING_FOR_STAFF":
      return 2; // PROCESSING (STAFF HANDLING)

    case "PRINTING":
      return 4; // PRINTER

    case "PRINTER_ISSUE":
      return -1;

    case "FINISHING":
      return 5; // FINISHING

    case "READY_FOR_PICKUP":
      return 6; // READY

    default:
      return -1;
  }
}
