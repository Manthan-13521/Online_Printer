export type {
  PrintJobStatus,
  PrinterAdapter,
  PrinterCapabilities,
  PrinterStatus,
  PrinterSummary,
  PrintSubmission,
  SubmittedPrintJob,
} from "./printing/printer-adapter.js";
export { UnavailablePrinterAdapter } from "./printing/unavailable-printer-adapter.js";

console.info(
  "PrintGo Windows Agent foundation is ready; pairing and printing are not enabled in Phase 0.",
);
