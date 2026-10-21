import type { ColorMode, PaperSize, SidesMode } from "@printgo/domain";

export interface LocalOrderFile {
  clientId: string;
  fileId?: string;
  file: File | null;
  name: string;
  size: number;
  pageCount: number;
  uploaded: boolean;
  uploadStatus:
    | "SELECTED"
    | "VALIDATING"
    | "UPLOADING"
    | "FINALIZING"
    | "UPLOADED"
    | "FAILED";
  uploadProgress: number;
  uploadError: string | null;
  pageMode: "ALL" | "CUSTOM";
  customPages: string;
  copies: number;
  paperSize: PaperSize;
  colorMode: ColorMode;
  sides: SidesMode;
}

export function isValidPhone(phone: string): boolean {
  return /^[+0-9][0-9 ()-]{5,29}$/u.test(phone.trim());
}

export const humanFileSize = (bytes: number): string =>
  `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

export function trackingCodeFromPath(): string | null {
  const match = /^\/track\/([^/]+)\/?$/u.exec(window.location.pathname);
  return match ? decodeURIComponent(match[1] ?? "") : null;
}

export function customerErrorMessage(caught: unknown): string {
  const code = caught instanceof Error ? caught.message : "";
  if (code === "ONLINE_PRINTING_DISABLED")
    return "Online printing was switched off. No upload was authorized.";
  if (code === "CASH_ORDERS_DISABLED")
    return "Cash orders are currently disabled by the shop.";
  if (code === "PICKUP_CASH_NOT_ALLOWED")
    return "Scheduled tomorrow pickup orders must be paid online to guarantee printing before pickup.";
  if (code === "PRINTER_NOT_READY")
    return "The shop printer is currently not ready to print.";
  if (code === "DRAFT_EXPIRED")
    return "This upload session expired. Please upload your PDF again.";
  if (code === "UPLOAD_INVALID")
    return "We couldn't read this PDF. Please check the file and try again.";
  if (code === "UPLOAD_ABORTED") return "Upload was cancelled.";
  if (code === "UPLOAD_HTTP_403" || code === "UPLOAD_HTTP_400")
    return "The secure upload link expired or was rejected. Click 'Try upload again' to get a fresh one.";
  if (code === "UPLOAD_NETWORK_ERROR")
    return "The upload was interrupted. Keep the app open and don't switch tabs while uploading. Check connection and try again.";
  if (code === "Failed to fetch")
    return "Could not reach the shop server. Please check your internet connection.";
  if (code === "DRAFT_INVALID" || code === "INVALID_DRAFT") {
    return "Please enter a valid customer name and phone number (at least 6 digits) before continuing.";
  }
  if (
    code &&
    !code.startsWith("UPLOAD_") &&
    code !== "REQUEST_FAILED" &&
    code !== "QUOTE_STATE_INVALID"
  ) {
    return code;
  }
  return "The request could not be completed. Your selections are preserved; please try again.";
}

export function paymentErrorMessage(caught: unknown): string {
  const code = caught instanceof Error ? caught.message : "";
  if (
    code &&
    code !== "PRINTER_NOT_READY" &&
    code !== "REQUEST_FAILED" &&
    code !== "Failed to fetch" &&
    code !== "CHECKOUT_LOAD_FAILED" &&
    code !== "PAYMENT_NOT_CAPTURED" &&
    code !== "PAYMENT_SIGNATURE_INVALID" &&
    code !== "PAYMENT_PROVIDER_UNAVAILABLE" &&
    code !== "TRACKING_ACCESS_UNAVAILABLE" &&
    code !== "TRACKING_ACCESS_CONFLICT"
  ) {
    return code;
  }
  if (code === "PRINTER_NOT_READY")
    return "Online payment is temporarily unavailable because the shop printer is not ready.";
  if (code === "PICKUP_CASH_NOT_ALLOWED")
    return "Scheduled tomorrow pickup orders must be paid online to guarantee printing before pickup.";
  if (code === "PAYMENT_NOT_CAPTURED")
    return "Payment is still being confirmed. No print job has been created yet.";
  if (code === "PAYMENT_SIGNATURE_INVALID")
    return "Payment verification failed. Please contact the shop before trying again.";
  if (code === "PAYMENT_PROVIDER_UNAVAILABLE" || code === "Failed to fetch")
    return "The payment service could not be reached. Please check your connection and try again.";
  if (code === "CHECKOUT_LOAD_FAILED")
    return "The secure payment window could not be loaded. Please try again.";
  if (
    code === "TRACKING_ACCESS_UNAVAILABLE" ||
    code === "TRACKING_ACCESS_CONFLICT"
  )
    return "Payment was received, but tracking confirmation encountered an issue. Please contact shop staff with your payment ID.";
  return "Payment could not be completed. You have not been shown a successful print job.";
}
