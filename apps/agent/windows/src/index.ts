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
import { RotatingLog } from "./storage/rotating-log.js";
import { sanitizeLogContent } from "./support/support-package.js";
import {
  readAgentStatus,
  getDefaultStatusFilePath,
} from "./storage/status-file.js";
import { createSupportPackage } from "./support/support-package.js";

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
    path.resolve(process.cwd(), "SumatraPDF.exe"),
    path.resolve(process.cwd(), "vendor/SumatraPDF.exe"),
    path.resolve(path.dirname(process.execPath), "SumatraPDF.exe"),
    path.resolve(path.dirname(process.execPath), "vendor/SumatraPDF.exe"),
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

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`PrintGo Windows Agent (v2.1.0)
Deterministic local print agent for PrintGo shops.

Usage:
  PrintGo-Agent.exe [options]

Options:
  --pair <CODE>          Pair this agent with a one-time pairing code (XXXX-XXXX)
  --pair-only           Exit after pairing without starting the daemon
  --pair-url <URL>       Pair automatically using a printgo:// URL from Admin
  --server <URL>         Shop API server URL from the connection link or technician configuration
  --api-url <URL>        Alias for --server
  --name <NAME>          Friendly display name for this computer/agent
  --status               Show current agent and printer operational status
  --support-package      Create a sanitized diagnostic ZIP package on Desktop
  --clear                Clear stored local DPAPI authentication credentials and exit
  --reset-pairing        Reset local pairing credentials and exit (alias for --clear)
  --version, -v          Print agent version and exit
  --help, -h             Show this help message and exit

Configuration File:
  Settings can also be specified via 'printgo-config.json' in the current or executable directory:
  {
    "serverUrl": "https://printgo-api.printgo-worker.workers.dev",
    "displayName": "Shop Counter PC"
  }

SumatraPDF:
  Deterministic PDF printing requires SumatraPDF.exe.
  Download portable version from:
  https://www.sumatrapdfreader.org/download-free-pdf-viewer
  Place SumatraPDF.exe in the same folder as PrintGo-Agent.exe.`);
    return;
  }

  if (args.includes("--version") || args.includes("-v")) {
    console.log("PrintGo Windows Agent v2.1.0");
    return;
  }

  if (
    args.includes("--support-package") ||
    args.includes("--create-support-package")
  ) {
    const credStore = createDefaultCredentialStore();
    const printer = createDefaultPrinterAdapter();
    console.log(
      "[PrintGo Agent] Generating safe diagnostic support package...",
    );
    try {
      const result = await createSupportPackage({
        agentVersion: "2.1.0",
        credentialStore: credStore,
        printerAdapter: printer,
      });
      console.log(`[PrintGo Agent] ✅ Support package generated successfully:`);
      console.log(`  File: ${result.zipPath}`);
      console.log(`  Size: ${result.byteLength} bytes`);
    } catch {
      process.exitCode = 1;
      console.error("[PrintGo Agent] Failed to generate support package.");
    }
    return;
  }

  if (args.includes("--status")) {
    const status = await readAgentStatus();
    if (!status) {
      console.log(
        "[PrintGo Agent] No active status found. Daemon may not be running or is starting up.",
      );
    } else {
      console.log(`[PrintGo Agent] State: ${status.operationalState}`);
      console.log(`  Version: ${status.agentVersion}`);
      console.log(`  Agent ID: ${status.agentId ?? "Unpaired"}`);
      console.log(`  Server: ${status.serverUrl ?? "None"}`);
      console.log(
        `  Last Heartbeat: ${status.lastHeartbeatMs ? new Date(status.lastHeartbeatMs).toLocaleString() : "Never"}`,
      );
      console.log(`  Printers (${status.printers.length} detected):`);
      for (const p of status.printers) {
        console.log(
          `    - ${p.displayName} [${p.status}] ${p.isDefault ? "(Default)" : ""} ${p.isEligible ? "(Production Eligible)" : "(Virtual/Ineligible)"}`,
        );
      }
    }
    return;
  }

  // Load optional printgo-config.json
  let fileConfig: Record<string, unknown> = {};
  const configCandidatePaths = [
    path.resolve(process.cwd(), "printgo-config.json"),
    path.resolve(path.dirname(process.execPath), "printgo-config.json"),
  ];
  for (const configPath of configCandidatePaths) {
    if (fs.existsSync(configPath)) {
      try {
        const raw = fs.readFileSync(configPath, "utf8");
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          fileConfig = parsed as Record<string, unknown>;
        }
        break;
      } catch (err) {
        console.warn(
          `[PrintGo Agent] Warning: Failed to parse ${configPath}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  // Check for printgo:// custom protocol URL or --pair-url argument
  let pairUrlArg: string | undefined;
  const pairUrlIndex = args.indexOf("--pair-url");
  if (pairUrlIndex !== -1 && args[pairUrlIndex + 1]) {
    pairUrlArg = args[pairUrlIndex + 1];
  } else {
    const protocolArg = args.find((a) => a.startsWith("printgo://"));
    if (protocolArg) pairUrlArg = protocolArg;
  }

  let protocolServerUrl: string | undefined;
  let protocolPairCode: string | undefined;
  let protocolDisplayName: string | undefined;

  if (pairUrlArg) {
    try {
      // Normalize printgo://connect?server=... into standard URL parse
      const normalized = pairUrlArg.replace(/^printgo:\/\/?/i, "http://dummy/");
      const parsed = new URL(normalized);
      protocolServerUrl = parsed.searchParams.get("server") || undefined;
      protocolPairCode = parsed.searchParams.get("code") || undefined;
      protocolDisplayName = parsed.searchParams.get("name") || undefined;
    } catch (err) {
      console.warn(
        "[PrintGo Agent] Warning: Malformed pairing URL:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  const pairIndex = args.indexOf("--pair");
  const candidatePairCode = pairIndex !== -1 ? args[pairIndex + 1] : undefined;
  let pairCodeArg =
    candidatePairCode && !candidatePairCode.startsWith("--")
      ? candidatePairCode
      : protocolPairCode || process.env.PRINTGO_PAIR_CODE;

  if (pairCodeArg) {
    pairCodeArg = pairCodeArg.trim().toUpperCase();
    if (/^[A-Z0-9]{8}$/.test(pairCodeArg)) {
      pairCodeArg = `${pairCodeArg.slice(0, 4)}-${pairCodeArg.slice(4)}`;
    }
  }

  const serverIndex =
    args.indexOf("--server") !== -1
      ? args.indexOf("--server")
      : args.indexOf("--api-url");
  const candidateServerUrl =
    serverIndex !== -1 ? args[serverIndex + 1] : undefined;
  const configServerUrl =
    typeof fileConfig.serverUrl === "string"
      ? fileConfig.serverUrl
      : typeof fileConfig.apiUrl === "string"
        ? fileConfig.apiUrl
        : undefined;
  const DEFAULT_PRODUCTION_SERVER =
    "https://printgo-api.printgo-worker.workers.dev";
  const serverUrl =
    candidateServerUrl ||
    protocolServerUrl ||
    process.env.PRINTGO_SERVER_URL ||
    process.env.PRINTGO_API_URL ||
    configServerUrl ||
    (process.env.NODE_ENV === "development"
      ? "http://127.0.0.1:8787"
      : DEFAULT_PRODUCTION_SERVER);

  const nameIndex = args.indexOf("--name");
  const candidateName = nameIndex !== -1 ? args[nameIndex + 1] : undefined;
  const configDisplayName =
    typeof fileConfig.displayName === "string"
      ? fileConfig.displayName
      : typeof fileConfig.agentName === "string"
        ? fileConfig.agentName
        : undefined;
  const displayName =
    candidateName ||
    protocolDisplayName ||
    process.env.PRINTGO_AGENT_NAME ||
    configDisplayName ||
    `${os.hostname()} (PrintGo Agent)`;

  const shouldClear =
    args.includes("--clear") || args.includes("--reset-pairing");

  const credentialStore = createDefaultCredentialStore();
  const printerAdapter = createDefaultPrinterAdapter();
  const client = new AgentClient();

  if (shouldClear) {
    await credentialStore.clear();
    console.log(
      "[PrintGo Agent] Local pairing credentials have been reset successfully.",
    );
    console.log(
      "[PrintGo Agent] Run PrintGo-Agent.exe again and enter a new pairing code from the Admin panel.",
    );
    return;
  }

  // Preflight check for SumatraPDF on Windows
  if (process.platform === "win32") {
    if (!checkSumatraPdfInstalled()) {
      console.warn(
        "\n[PrintGo Agent] ⚠️  WARNING: SumatraPDF.exe was not detected in standard locations or PATH.\n" +
          "  Deterministic PDF printing requires SumatraPDF.exe.\n" +
          "  Please download SumatraPDF from: https://www.sumatrapdfreader.org/download-free-pdf-viewer\n" +
          "  and place SumatraPDF.exe in the same folder as PrintGo-Agent.exe.\n",
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
        "[PrintGo Agent] No existing pairing credentials found.\nEnter pairing code from PrintGo Admin (format: XXXX-XXXX, or press Enter to skip): ",
      );
      rl.close();
      if (input.trim()) {
        pairCodeArg = input.trim().toUpperCase();
        if (/^[A-Z0-9]{8}$/.test(pairCodeArg)) {
          pairCodeArg = `${pairCodeArg.slice(0, 4)}-${pairCodeArg.slice(4)}`;
        }
      }
    } catch {
      // Interactive prompt fallback ignored if stdin is closed/aborted
    }
  }

  let authErrorCleared = false;

  const log = new RotatingLog(
    path.join(path.dirname(getDefaultStatusFilePath()), "daemon.log"),
  );
  const daemon = new AgentDaemon({
    client,
    agentVersion: "2.1.0",
    credentialStore,
    printerAdapter,
    onStatusChange: (message) => {
      console.log(`[PrintGo Agent] ${sanitizeLogContent(message)}`);
      void log
        .write(message)
        .catch(() => console.error("Agent log could not be saved."));
    },
    onError: (err: Error) => {
      void log
        .write(`[ERROR] ${sanitizeLogContent(err.message)}`)
        .catch(() => undefined);
      if (err instanceof AgentAuthError && !authErrorCleared) {
        authErrorCleared = true;
        console.error(
          "\n[PrintGo Agent] ❌ Current pairing credentials have been revoked by the administrator or are no longer valid.",
        );
        console.error(
          "[PrintGo Agent] Clearing stale local credentials automatically...",
        );
        void credentialStore.clear().then(() => {
          console.error(
            "[PrintGo Agent] ✅ Credentials cleared. Please restart PrintGo-Agent.exe and enter a new pairing code from the Admin panel.",
          );
          process.exit(1);
        });
      }
    },
  });

  if (pairCodeArg) {
    if (!serverUrl)
      throw new Error(
        "The shop server is required. Use the Admin connection link.",
      );
    console.log("[PrintGo Agent] Initiating pairing...");
    try {
      await daemon.pair(serverUrl, pairCodeArg, displayName);
    } catch (err: unknown) {
      console.error(
        `[PrintGo Agent] Pairing failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
  }

  if (args.includes("--pair-only")) {
    if (!pairCodeArg) throw new Error("A pairing code is required.");
    return;
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
