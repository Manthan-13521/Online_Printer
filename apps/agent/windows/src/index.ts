import * as os from "node:os";
import {
  AgentApiError,
  AgentAuthError,
  AgentClient,
  normalizeAgentServerUrl,
} from "./agent-client.js";
import { AgentDaemon } from "./agent-daemon.js";
import {
  DevelopmentPrinterAdapter,
  WindowsPrinterAdapter,
  createDefaultPrinterAdapter,
} from "./printing/windows-printer-adapter.js";
import {
  DevelopmentCredentialStore,
  WindowsDpapiCredentialStore,
  createDefaultCredentialStore,
  type AgentCredentials,
  type CredentialStore,
} from "./storage/credential-store.js";

export type {
  PrintJobStatus,
  PrinterAdapter,
  PrinterCapabilities,
  PrinterStatus,
  PrinterSummary,
  PrintSubmission,
  PrintSettings,
  SpoolJobState,
  SubmittedPrintJob,
} from "./printing/printer-adapter.js";
export {
  generateDiagnosticPdfBuffer,
  createDiagnosticPdfFile,
} from "./printing/diagnostic-pdf.js";
export {
  IDENTIFICATION_SHEET_PRINT_SETTINGS,
  IdentificationSheetError,
  createIdentificationSheetFile,
  generateIdentificationSheetBuffer,
  printIdentificationSheet,
  withIdentificationSheetFile,
} from "./printing/identification-sheet.js";
export type {
  IdentificationSheetErrorCode,
  IdentificationSheetRenderOptions,
} from "./printing/identification-sheet.js";
export { buildOrderPrintPlan } from "./printing/order-print-plan.js";
export type {
  BuildOrderPrintPlanInput,
  OrderPrintPlanStep,
} from "./printing/order-print-plan.js";
export { monitorSpoolJob } from "./printing/spool-monitor.js";
export {
  downloadAndValidateCustomerPdf,
  CustomerPdfError,
} from "./printing/customer-pdf.js";
export { PaidPrintExecutor } from "./paid-print-executor.js";
export { ExecutionJournalStore } from "./storage/execution-journal.js";
export { UnavailablePrinterAdapter } from "./printing/unavailable-printer-adapter.js";
export {
  AgentClient,
  AgentApiError,
  AgentAuthError,
  normalizeAgentServerUrl,
  AgentDaemon,
  WindowsPrinterAdapter,
  DevelopmentPrinterAdapter,
  createDefaultPrinterAdapter,
  WindowsDpapiCredentialStore,
  DevelopmentCredentialStore,
  createDefaultCredentialStore,
};
export type { AgentCredentials, CredentialStore };

async function runCli(): Promise<void> {
  const args = process.argv.slice(2);

  const pairIndex = args.indexOf("--pair");
  const pairCodeArg =
    pairIndex !== -1 ? args[pairIndex + 1] : process.env.PRINTGO_PAIR_CODE;

  const serverIndex = args.indexOf("--server");
  const serverUrl =
    (serverIndex !== -1 ? args[serverIndex + 1] : undefined) ||
    process.env.PRINTGO_SERVER_URL ||
    "http://127.0.0.1:8787";

  const nameIndex = args.indexOf("--name");
  const displayName =
    (nameIndex !== -1 ? args[nameIndex + 1] : undefined) ||
    process.env.PRINTGO_AGENT_NAME ||
    `${os.hostname()} (PrintGo Agent)`;

  const shouldClear = args.includes("--clear");

  const credentialStore = createDefaultCredentialStore();
  const printerAdapter = createDefaultPrinterAdapter();
  const client = new AgentClient();

  if (shouldClear) {
    await credentialStore.clear();
    console.log("[PrintGo Agent] Local credentials cleared.");
    return;
  }

  const daemon = new AgentDaemon({
    client,
    credentialStore,
    printerAdapter,
  });

  if (pairCodeArg) {
    console.log("[PrintGo Agent] Initiating pairing with a one-time code...");
    try {
      await daemon.pair(serverUrl, pairCodeArg, displayName);
    } catch (err: unknown) {
      console.error(
        `[PrintGo Agent] Pairing failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
  }

  const started = await daemon.start();
  if (!started) {
    console.log(
      "[PrintGo Agent] No credentials configured. Use --pair <CODE> or set PRINTGO_PAIR_CODE to pair this agent with PrintGo.",
    );
    return;
  }

  const handleShutdown = () => {
    console.log("\n[PrintGo Agent] Shutting down agent daemon...");
    daemon.stop();
    process.exit(0);
  };

  process.on("SIGINT", handleShutdown);
  process.on("SIGTERM", handleShutdown);
}

// Only execute CLI if executed directly
if (
  process.argv[1] &&
  (process.argv[1].endsWith("src/index.ts") ||
    process.argv[1].endsWith("dist/index.js"))
) {
  runCli().catch((err: unknown) => {
    console.error("[PrintGo Agent] Fatal error:", err);
    process.exit(1);
  });
}
