import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
export function checkSumatraPdfInstalled(): boolean {
  if (process.platform !== "win32") {
    return true;
  }
  const envPath = process.env.PRINTGO_SUMATRA_PATH;
  if (envPath && fs.existsSync(envPath)) {
    return true;
  }

  const candidatePaths = [
    path.resolve(process.cwd(), "vendor/SumatraPDF.exe"),
    path.resolve(path.dirname(process.execPath), "vendor/SumatraPDF.exe"),
    path.resolve(path.dirname(process.execPath), "SumatraPDF.exe"),
    process.env.ProgramFiles
      ? path.join(process.env.ProgramFiles, "SumatraPDF", "SumatraPDF.exe")
      : "",
    process.env["ProgramFiles(x86)"]
      ? path.join(
          process.env["ProgramFiles(x86)"],
          "SumatraPDF",
          "SumatraPDF.exe",
        )
      : "",
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "SumatraPDF", "SumatraPDF.exe")
      : "",
  ].filter(Boolean);

  for (const cand of candidatePaths) {
    if (fs.existsSync(cand)) {
      return true;
    }
  }
  return false;
}

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
  runCli,
};
export type { AgentCredentials, CredentialStore };

async function runCli(): Promise<void> {
  const args = process.argv.slice(2);

  const pairIndex = args.indexOf("--pair");
  const candidatePairCode = pairIndex !== -1 ? args[pairIndex + 1] : undefined;
  let pairCodeArg =
    candidatePairCode && !candidatePairCode.startsWith("--")
      ? candidatePairCode
      : process.env.PRINTGO_PAIR_CODE;

  const serverIndex =
    args.indexOf("--server") !== -1
      ? args.indexOf("--server")
      : args.indexOf("--api-url");
  const candidateServerUrl =
    serverIndex !== -1 ? args[serverIndex + 1] : undefined;
  const serverUrl =
    candidateServerUrl ||
    process.env.PRINTGO_SERVER_URL ||
    process.env.PRINTGO_API_URL ||
    (process.env.NODE_ENV === "development"
      ? "http://127.0.0.1:8787"
      : "https://printgo-api.printgo-worker.workers.dev");

  const nameIndex = args.indexOf("--name");
  const candidateName = nameIndex !== -1 ? args[nameIndex + 1] : undefined;
  const displayName =
    candidateName ||
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

  // Preflight check for SumatraPDF on Windows
  if (process.platform === "win32") {
    if (!checkSumatraPdfInstalled()) {
      console.warn(
        "\n[PrintGo Agent] ⚠️  WARNING: SumatraPDF.exe was not detected in standard locations or PATH.\n" +
          "  Deterministic PDF printing requires SumatraPDF.exe.\n" +
          "  Please download SumatraPDF and place it in the agent folder, or install it to Program Files.\n",
      );
    }
  }

  // If not paired yet and no pairing code provided, check if we can prompt interactively
  const existingCredentials = await credentialStore.load();
  if (!existingCredentials && !pairCodeArg && process.stdin.isTTY) {
    try {
      const readline = await import("node:readline/promises");
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      const input = await rl.question(
        "[PrintGo Agent] No existing pairing credentials found.\nEnter 6-digit pairing code from PrintGo Admin (or press Enter to skip): ",
      );
      rl.close();
      if (input.trim()) {
        pairCodeArg = input.trim();
      }
    } catch {
      // Interactive prompt fallback ignored if stdin is closed/aborted
    }
  }

  const daemon = new AgentDaemon({
    client,
    credentialStore,
    printerAdapter,
  });

  if (pairCodeArg) {
    console.log(`[PrintGo Agent] Initiating pairing with ${serverUrl}...`);
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
      "[PrintGo Agent] No credentials configured. Use --pair <CODE> or enter pairing code to pair this agent with PrintGo.",
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

// Only execute CLI if executed directly or in standalone binary bundle
const isSea =
  typeof (process as unknown as { isSea?: () => boolean }).isSea ===
    "function" && (process as unknown as { isSea: () => boolean }).isSea();

if (
  isSea ||
  !process.argv[1] ||
  process.argv[1].endsWith("src/index.ts") ||
  process.argv[1].endsWith("dist/index.js") ||
  process.argv[1].endsWith("bundle.cjs") ||
  process.argv[1].endsWith("agent.cjs") ||
  process.argv[1].toLowerCase().endsWith(".exe")
) {
  runCli().catch((err: unknown) => {
    console.error("[PrintGo Agent] Fatal error:", err);
    process.exit(1);
  });
}
