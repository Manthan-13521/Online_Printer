import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
  PrintJobStatus,
  PrinterAdapter,
  PrinterCapabilities,
  PrinterChangeEvent,
  PrinterStatus,
  PrinterSummary,
  PrintSubmission,
  SubmittedPrintJob,
} from "./printer-adapter.js";
import { classifyPrinter } from "@printgo/domain";
import {
  InvalidPrintSettingError,
  PrinterNotFoundError,
  UnsupportedPrintSettingError,
} from "./printer-adapter.js";
import { validateAndNormalizePrintSettings } from "./print-settings.js";

const execFileAsync = promisify(execFile);

export interface PowerShellExecutor {
  (command: string): Promise<string>;
}

export interface SocketProbe {
  (host: string, port: number, timeoutMs: number): Promise<boolean>;
}

export const defaultSocketProbe: SocketProbe = async (
  host: string,
  port: number,
  timeoutMs: number,
): Promise<boolean> => {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let resolved = false;

    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        socket.destroy();
      }
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      cleanup();
      resolve(true);
    });
    socket.once("timeout", () => {
      cleanup();
      resolve(false);
    });
    socket.once("error", () => {
      cleanup();
      resolve(false);
    });

    try {
      socket.connect(port, host);
    } catch {
      cleanup();
      resolve(false);
    }
  });
};

export function extractHostFromPortName(
  portName: string | null | undefined,
): string | null {
  if (!portName) return null;
  const trimmed = portName.trim();
  const ipPrefix =
    /^IP_([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})$/i.exec(trimmed);
  if (ipPrefix?.[1]) return ipPrefix[1];
  const directIp =
    /^([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})(?::\d+)?$/i.exec(
      trimmed,
    );
  if (directIp?.[1]) return directIp[1];
  const tcpPrefix =
    /^TCP_([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})$/i.exec(trimmed);
  if (tcpPrefix?.[1]) return tcpPrefix[1];
  return null;
}

const defaultPowerShellExecutor: PowerShellExecutor = async (
  command: string,
) => {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { maxBuffer: 2 * 1024 * 1024 },
  );
  return stdout;
};

interface CimPrinterOutput {
  Name: string;
  Default?: boolean;
  WorkOffline?: boolean;
  PrinterStatus?: number;
  DetectedErrorState?: number;
  ExtendedPrinterStatus?: number;
  ModernStatus?: string | null;
  Color?: boolean;
  Duplex?: boolean;
  Capabilities?: number[];
  CapabilityDescriptions?: string[];
  PrinterPaperNames?: string[];
  PortName?: string;
  DriverName?: string;
}

export class WindowsPrinterAdapter implements PrinterAdapter {
  private readonly executor: PowerShellExecutor;
  private readonly socketProbe: SocketProbe;
  private inventory: readonly PrinterSummary[] = [];
  private inventoryAtMs = -Infinity;

  private readonly capabilitiesCache = new Map<
    string,
    { caps: PrinterCapabilities; cachedAtMs: number }
  >();
  private readonly statusCache = new Map<
    string,
    { status: PrinterStatus; cachedAtMs: number }
  >();
  private readonly eventListeners = new Set<
    (event: PrinterChangeEvent) => void
  >();
  // Phase 4: Cache the resolved SumatraPDF.exe path after first successful lookup
  private resolvedSumatraPath: string | null = null;

  constructor(
    executor: PowerShellExecutor = defaultPowerShellExecutor,
    socketProbe: SocketProbe = defaultSocketProbe,
  ) {
    this.executor = executor;
    this.socketProbe = socketProbe;
  }

  /**
   * Phase 4: Resolve SumatraPDF.exe on the Node.js side once and cache it.
   * Falls back to null if not found — the PS script will error with a clear message.
   */
  private resolveSumatraPath(): string | null {
    if (this.resolvedSumatraPath) return this.resolvedSumatraPath;

    const currentDir =
      typeof __dirname !== "undefined"
        ? __dirname
        : path.dirname(fileURLToPath(import.meta.url));

    const candidates = [
      process.env.PRINTGO_SUMATRA_PATH,
      path.resolve(path.dirname(process.execPath), "SumatraPDF.exe"),
      path.resolve(process.cwd(), "SumatraPDF.exe"),
      path.resolve(currentDir, "../../vendor/SumatraPDF.exe"),
    ].filter(Boolean) as string[];

    for (const c of candidates) {
      try {
        if (existsSync(c)) {
          this.resolvedSumatraPath = c;
          return c;
        }
      } catch {
        /* continue */
      }
    }
    return null;
  }

  subscribePrinterEvents(
    onEvent: (event: PrinterChangeEvent) => void,
  ): () => void {
    this.eventListeners.add(onEvent);
    return () => {
      this.eventListeners.delete(onEvent);
    };
  }

  notifyPrinterChange(event: PrinterChangeEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch {
        // Safe dispatch
      }
    }
  }

  private async probeNetworkPrinter(
    portName?: string | null,
  ): Promise<boolean | undefined> {
    const host = extractHostFromPortName(portName);
    if (!host) return undefined;
    return this.socketProbe(host, 9100, 2500);
  }

  private ensureWindows(): void {
    if (
      process.platform !== "win32" &&
      this.executor === defaultPowerShellExecutor
    ) {
      throw new Error(
        "WindowsPrinterAdapter requires Windows OS (win32). For macOS/Linux development, use DevelopmentPrinterAdapter.",
      );
    }
  }

  async listPrinters(forceRefresh = false): Promise<readonly PrinterSummary[]> {
    this.ensureWindows();

    const full = forceRefresh || Date.now() - this.inventoryAtMs >= 300_000;
    // One process refreshes health for all queues; inventory/capabilities share the slow reconciliation.
    const fields = full
      ? "Name, Default, WorkOffline, PrinterStatus, DetectedErrorState, ExtendedPrinterStatus, Color, CapabilityDescriptions, PrinterPaperNames, PortName, DriverName"
      : "Name, WorkOffline, PrinterStatus, DetectedErrorState, DriverName, PortName";
    const psCommand = `
$modern = @{}
try {
  Get-Printer -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.Name) { $modern[$_.Name] = [string]$_.PrinterStatus }
  }
} catch {}
Get-CimInstance Win32_Printer | Select-Object ${fields} | ForEach-Object {
  $_ | Add-Member -NotePropertyName ModernStatus -NotePropertyValue ($modern[$_.Name]) -Force -PassThru
} | ConvertTo-Json -Compress
    `.trim();

    try {
      const output = (await this.executor(psCommand)).trim();
      if (!output) {
        this.inventory = [];
        this.inventoryAtMs = -Infinity;
        this.capabilitiesCache.clear();
        this.statusCache.clear();
        return [];
      }

      const parsed: unknown = JSON.parse(output);
      const list: CimPrinterOutput[] = Array.isArray(parsed)
        ? (parsed as CimPrinterOutput[])
        : [parsed as CimPrinterOutput];

      const valid = list.filter(
        (p) => p && typeof p.Name === "string" && p.Name.trim().length > 0,
      );
      const names = new Set(valid.map((p) => p.Name));
      for (const name of this.capabilitiesCache.keys())
        if (!names.has(name)) this.capabilitiesCache.delete(name);
      for (const name of this.statusCache.keys())
        if (!names.has(name)) this.statusCache.delete(name);

      const reachability = await Promise.all(
        valid.map((p) => this.probeNetworkPrinter(p.PortName)),
      );
      for (let i = 0; i < valid.length; i++) {
        const p = valid[i]!;
        this.statusCache.set(p.Name, {
          status: this.parsePrinterStatus(p, reachability[i]),
          cachedAtMs: Date.now(),
        });
      }
      if (!full) {
        const changed =
          valid.some((p) => {
            const old = this.inventory.find((i) => i.id === p.Name);
            return (
              !old ||
              (old.driverName ?? null) !== (p.DriverName ?? null) ||
              (old.portName ?? null) !== (p.PortName ?? null)
            );
          }) || valid.length !== this.inventory.length;
        if (changed) return this.listPrinters(true);
        if (
          valid.some(
            (p, i) =>
              this.parsePrinterStatus(p, reachability[i]).availability !==
              "ONLINE",
          )
        )
          this.inventoryAtMs = -Infinity;
        return this.inventory;
      }
      this.inventoryAtMs = Date.now();
      this.inventory = list
        .filter(
          (p) => p && typeof p.Name === "string" && p.Name.trim().length > 0,
        )
        .map((p, i) => {
          const classification = classifyPrinter({
            name: p.Name,
            portName: p.PortName ?? null,
            driverName: p.DriverName ?? null,
          });

          this.capabilitiesCache.set(p.Name, {
            caps: this.parseCapabilities(p),
            cachedAtMs: Date.now(),
          });
          const status = this.parsePrinterStatus(p, reachability[i]);
          this.statusCache.set(p.Name, {
            status,
            cachedAtMs: Date.now(),
          });

          return {
            id: p.Name,
            displayName: p.Name,
            isDefault: Boolean(p.Default),
            portName: p.PortName ?? null,
            driverName: p.DriverName ?? null,
            isVirtual: classification.isVirtual,
            isEligibleForProductionPrint:
              classification.isEligibleForProductionPrint,
          };
        });
      return this.inventory;
    } catch (err: unknown) {
      this.inventory = [];
      this.inventoryAtMs = -Infinity;
      this.capabilitiesCache.clear();
      this.statusCache.clear();
      console.error("Failed to query Win32_Printer:", err);
      return [];
    }
  }

  async getCapabilities(printerId: string): Promise<PrinterCapabilities> {
    this.ensureWindows();

    const cached = this.capabilitiesCache.get(printerId);
    if (cached && Date.now() - cached.cachedAtMs < 600_000) {
      return cached.caps;
    }

    const escapedName = printerId.replace(/'/g, "''");
    const psCommand = `
$printer = '${escapedName}'
Get-CimInstance Win32_Printer | Where-Object { $_.Name -eq $printer } | Select-Object Name, Color, Duplex, Capabilities, CapabilityDescriptions, PrinterPaperNames | ConvertTo-Json -Compress
    `.trim();

    try {
      const output = (await this.executor(psCommand)).trim();
      if (!output) {
        return {
          colour: "UNKNOWN",
          duplex: "UNKNOWN",
          paperSizes: ["A4", "LETTER"],
        };
      }

      const p = JSON.parse(output) as CimPrinterOutput;
      const result = this.parseCapabilities(p);
      this.capabilitiesCache.set(printerId, {
        caps: result,
        cachedAtMs: Date.now(),
      });
      return result;
    } catch {
      return {
        colour: "UNKNOWN",
        duplex: "UNKNOWN",
        paperSizes: ["A4", "LETTER"],
      };
    }
  }

  private parseCapabilities(p: CimPrinterOutput): PrinterCapabilities {
    const caps = Array.isArray(p.CapabilityDescriptions)
      ? p.CapabilityDescriptions
      : [];
    const capsText = caps.join(" ").toLowerCase();

    let colour: boolean | "UNKNOWN" = "UNKNOWN";
    if (typeof p.Color === "boolean") {
      colour = p.Color;
    } else if (capsText.includes("color") || capsText.includes("colour")) {
      colour = true;
    } else if (
      capsText.includes("monochrome") ||
      capsText.includes("mono") ||
      capsText.includes("black and white")
    ) {
      colour = false;
    }

    let duplex: boolean | "UNKNOWN" = "UNKNOWN";
    if (typeof p.Duplex === "boolean") {
      duplex = p.Duplex;
    } else if (capsText.includes("duplex") || capsText.includes("two-sided")) {
      duplex = true;
    } else if (
      capsText.includes("simplex") ||
      capsText.includes("single-sided")
    ) {
      duplex = false;
    }

    const paperSizesSet = new Set<string>(["A4", "LETTER"]);
    if (Array.isArray(p.PrinterPaperNames)) {
      for (const name of p.PrinterPaperNames) {
        const upper = String(name).trim().toUpperCase();
        if (upper) paperSizesSet.add(upper);
      }
    }
    if (capsText.includes("a3")) {
      paperSizesSet.add("A3");
    }

    return {
      colour,
      duplex,
      paperSizes: Array.from(paperSizesSet),
    };
  }

  private parsePrinterStatus(
    p: CimPrinterOutput,
    isNetworkReachable?: boolean,
  ): PrinterStatus {
    if (p.WorkOffline) {
      return {
        availability: "OFFLINE",
        message: "Printer is set to work offline",
      };
    }

    switch (p.DetectedErrorState) {
      case 9:
        return { availability: "OFFLINE", message: "Printer is offline" };
      case 10:
        return { availability: "BLOCKED", message: "Printer requires service" };
      case 8:
        return { availability: "BLOCKED", message: "Paper Jam" };
      case 7:
        return { availability: "BLOCKED", message: "Door or Cover Open" };
      case 4:
        return { availability: "BLOCKED", message: "Out of Paper" };
      case 6:
        return { availability: "BLOCKED", message: "Out of Toner" };
      case 11:
        return { availability: "BLOCKED", message: "Output Bin Full" };
      default:
        break;
    }

    // PrinterStatus: 2 = Unknown, 3 = Idle, 4 = Printing, 5 = Warmup,
    // 6 = Stopped Printing, 7 = Offline.
    if (p.PrinterStatus === 7 || p.PrinterStatus === 6) {
      return {
        availability: "OFFLINE",
        message: "Printer is offline or stopped",
      };
    }

    // If Windows explicitly reports the printer is actively Printing (4) or in Warmup (5),
    // it is actively working; port 9100 may be busy receiving the job.
    if (p.PrinterStatus === 4 || p.PrinterStatus === 5) {
      return { availability: "ONLINE" };
    }

    // ExtendedPrinterStatus provides more granular fault codes when the driver supports it.
    // 8=Paused, 9=Error, 20=Paper Jam, 21=Out of Paper → BLOCKED.
    // We skip ambiguous codes (1=Other, 2=Unknown) to avoid false positives.
    if (p.ExtendedPrinterStatus !== undefined) {
      if (p.ExtendedPrinterStatus === 8) {
        return { availability: "BLOCKED", message: "Printer is paused" };
      }
      if (p.ExtendedPrinterStatus === 9) {
        return { availability: "BLOCKED", message: "Printer error reported" };
      }
      if (p.ExtendedPrinterStatus === 20) {
        return { availability: "BLOCKED", message: "Paper Jam" };
      }
      if (p.ExtendedPrinterStatus === 21) {
        return { availability: "BLOCKED", message: "Out of Paper" };
      }
    }

    // Modern MSFT_Printer status (from Get-Printer) for explicit faults
    const modern = p.ModernStatus
      ? String(p.ModernStatus).trim().toLowerCase()
      : null;
    if (modern) {
      if (
        modern === "offline" ||
        modern === "8" ||
        modern === "notavailable" ||
        modern === "13" ||
        modern === "serverunknown" ||
        modern === "24"
      ) {
        return { availability: "OFFLINE", message: "Printer is offline" };
      }
      if (modern === "paused" || modern === "1") {
        return { availability: "BLOCKED", message: "Printer is paused" };
      }
      if (modern === "error" || modern === "2") {
        return { availability: "BLOCKED", message: "Printer error reported" };
      }
      if (
        modern === "paperjam" ||
        modern === "4" ||
        modern === "paperproblem" ||
        modern === "7"
      ) {
        return { availability: "BLOCKED", message: "Paper Jam" };
      }
      if (modern === "paperout" || modern === "5") {
        return { availability: "BLOCKED", message: "Out of Paper" };
      }
      if (modern === "dooropen" || modern === "23") {
        return { availability: "BLOCKED", message: "Door or Cover Open" };
      }
      if (modern === "notoner" || modern === "19") {
        return { availability: "BLOCKED", message: "Out of Toner" };
      }
      if (modern === "outputbinfull" || modern === "12") {
        return { availability: "BLOCKED", message: "Output Bin Full" };
      }
      if (modern === "userintervention" || modern === "21") {
        return {
          availability: "BLOCKED",
          message: "User intervention required",
        };
      }
    }

    const host = extractHostFromPortName(p.PortName);
    if (host !== null) {
      if (isNetworkReachable === false) {
        return {
          availability: "OFFLINE",
          message: `Network printer unreachable at ${host}`,
        };
      }
      if (isNetworkReachable === true) {
        return { availability: "ONLINE" };
      }
    }

    // PrinterStatus === 3 means Idle — the printer is ready and waiting for a job.
    if (p.PrinterStatus === 3) {
      return { availability: "ONLINE" };
    }

    // When CIM reports PrinterStatus === 2 (Unknown) for WSD/USB printers,
    // modern Windows PrintManagement API (Get-Printer / MSFT_Printer) often reports
    // 'Normal', 'Idle', 'Ready', or actively printing/busy.
    if (modern) {
      const isModernReady =
        modern === "normal" ||
        modern === "0" ||
        modern === "idle" ||
        modern === "ready" ||
        modern === "printing" ||
        modern === "11" ||
        modern === "busy" ||
        modern === "10" ||
        modern === "processing" ||
        modern === "15" ||
        modern === "warmingup" ||
        modern === "17" ||
        modern === "powersave" ||
        modern === "25";
      if (isModernReady) {
        return { availability: "ONLINE" };
      }
    }

    // NOTE: Without positive proof of readiness from CIM, socket probe, or Get-Printer,
    // return UNKNOWN to fail closed. NEVER blindly convert UNKNOWN into ONLINE.
    return {
      availability: "UNKNOWN",
      message: "Printer readiness is not reported by Windows",
    };
  }

  async getStatus(
    printerId: string,
    opts?: { maxCacheAgeMs?: number },
  ): Promise<PrinterStatus> {
    this.ensureWindows();

    const maxAge = opts?.maxCacheAgeMs ?? 5_000;
    const cached = this.statusCache.get(printerId);
    if (cached && Date.now() - cached.cachedAtMs < maxAge) {
      const isHealthy =
        cached.status.availability === "ONLINE" ||
        cached.status.availability === "AVAILABLE";
      // Extended cache only trusts healthy results — fail closed on stale unhealthy data
      if (maxAge > 5_000 && !isHealthy) {
        // Stale unhealthy cache — fall through to fresh probe
      } else {
        return cached.status;
      }
    }

    const escapedName = printerId.replace(/'/g, "''");
    const psCommand = `
$printer = '${escapedName}'
$modern = $null
try {
  $mp = Get-Printer -Name $printer -ErrorAction SilentlyContinue
  if ($mp) { $modern = [string]$mp.PrinterStatus }
} catch {}
Get-CimInstance Win32_Printer | Where-Object { $_.Name -eq $printer } | Select-Object Name, WorkOffline, PrinterStatus, DetectedErrorState, ExtendedPrinterStatus, PortName | ForEach-Object {
  $_ | Add-Member -NotePropertyName ModernStatus -NotePropertyValue $modern -Force -PassThru
} | ConvertTo-Json -Compress
    `.trim();

    try {
      const output = (await this.executor(psCommand)).trim();
      if (!output) {
        return { availability: "OFFLINE", message: "Printer not found" };
      }

      const p = JSON.parse(output) as CimPrinterOutput;
      const isReachable = await this.probeNetworkPrinter(p.PortName);
      const status = this.parsePrinterStatus(p, isReachable);
      this.statusCache.set(printerId, {
        status,
        cachedAtMs: Date.now(),
      });
      return status;
    } catch (err: unknown) {
      return {
        availability: "UNKNOWN",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async submitPdfJob(submission: PrintSubmission): Promise<SubmittedPrintJob> {
    this.ensureWindows();

    if (!submission.printerId || submission.printerId.trim().length === 0) {
      throw new InvalidPrintSettingError(
        "Target printer ID is required for print submission.",
      );
    }
    if (
      !submission.localPdfPath ||
      submission.localPdfPath.trim().length === 0
    ) {
      throw new InvalidPrintSettingError(
        "Local PDF path is required for print submission.",
      );
    }

    // 1. Fetch printer capabilities and validate print settings (Fail closed on silent downgrade)
    const caps = await this.getCapabilities(submission.printerId);
    const settings = validateAndNormalizePrintSettings(submission, caps);

    // 2. Build deterministic print settings string for SumatraPDF
    // Format: "3x,paper=A4,monochrome,duplexlong,2-7,fit"
    const settingsParts: string[] = [
      `${settings.copies}x`,
      `paper=${settings.paperSize}`,
      settings.colorMode === "COLOUR" ? "color" : "monochrome",
      settings.sides === "TWO_SIDED_LONG"
        ? "duplexlong"
        : settings.sides === "TWO_SIDED_SHORT"
          ? "duplexshort"
          : "simplex",
    ];
    if (settings.pageRange) {
      settingsParts.push(settings.pageRange);
    }
    if (settings.orientation) {
      settingsParts.push(settings.orientation);
    }
    settingsParts.push("fit");
    const settingsString = settingsParts.join(",");

    const docIdentifier =
      submission.documentTitle ??
      path.basename(
        submission.localPdfPath,
        path.extname(submission.localPdfPath),
      );

    const escapedPrinterName = settings.printerName.replace(/'/g, "''");
    const escapedPdfPath = submission.localPdfPath.replace(/'/g, "''");
    const escapedSettings = settingsString.replace(/'/g, "''");
    const escapedDocIdentifier = docIdentifier.replace(/'/g, "''");

    // Phase 4: Use Node.js-side cached SumatraPDF path when available
    const cachedSumatraPath = this.resolveSumatraPath();
    const currentDir =
      typeof __dirname !== "undefined"
        ? __dirname
        : path.dirname(fileURLToPath(import.meta.url));
    const bundledSumatraPath = path.resolve(
      currentDir,
      "../../vendor/SumatraPDF.exe",
    );
    const cwdSumatraPath = path.resolve(process.cwd(), "SumatraPDF.exe");
    const execDirSumatraPath = path.resolve(
      path.dirname(process.execPath),
      "SumatraPDF.exe",
    );

    const escapedBundledSumatraPath = bundledSumatraPath.replace(/'/g, "''");
    const escapedCwdSumatraPath = cwdSumatraPath.replace(/'/g, "''");
    const escapedExecDirSumatraPath = execDirSumatraPath.replace(/'/g, "''");

    const sumatraResolutionPs = cachedSumatraPath
      ? `
# 1. SumatraPDF path pre-resolved by Node.js (Phase 4 optimization)
$sumatra = '${cachedSumatraPath.replace(/'/g, "''")}'
if (-not (Test-Path $sumatra)) {
    throw "Pre-resolved SumatraPDF path not found: $sumatra"
}`
      : `
# 1. Resolve SumatraPDF executable location
$sumatra = $env:PRINTGO_SUMATRA_PATH
if (-not $sumatra -or -not (Test-Path $sumatra)) {
    $candidates = @(
        '${escapedExecDirSumatraPath}',
        '${escapedCwdSumatraPath}',
        '${escapedBundledSumatraPath}',
        "$env:ProgramFiles\\SumatraPDF\\SumatraPDF.exe",
        "\${env:ProgramFiles(x86)}\\SumatraPDF\\SumatraPDF.exe",
        "$env:LOCALAPPDATA\\SumatraPDF\\SumatraPDF.exe"
    )
    foreach ($cand in $candidates) {
        if ($cand -and (Test-Path $cand)) {
            $sumatra = $cand
            break
        }
    }
}
if (-not $sumatra -or -not (Test-Path $sumatra)) {
    $cmd = Get-Command SumatraPDF.exe -ErrorAction SilentlyContinue
    if ($cmd) {
        $sumatra = $cmd.Source
    }
}`;

    const psScript = `
$printer = '${escapedPrinterName}'
$pdf = '${escapedPdfPath}'
$docIdentifier = '${escapedDocIdentifier}'
$settings = '${escapedSettings}'

${sumatraResolutionPs}

# Fresh readiness in this same process, before any physical side effect. Never trust the idle snapshot here.
$ready = Get-CimInstance Win32_Printer -ErrorAction Stop | Where-Object { $_.Name -eq $printer }
$modernReady = $null
try {
    $mp = Get-Printer -Name $printer -ErrorAction SilentlyContinue
    if ($mp) { $modernReady = [string]$mp.PrinterStatus }
} catch {}

if (-not $ready -or $ready.WorkOffline -or $ready.PrinterStatus -in @(6,7) -or
    $ready.DetectedErrorState -in @(4,6,7,8,9,10,11) -or
    ($modernReady -and $modernReady.ToLower() -in @('offline', '8', 'error', '2', 'paperjam', '4', 'paperout', '5', 'dooropen', '23', 'notoner', '19', 'paused', '1', 'notavailable', '13', 'serverunknown', '24'))) {
    throw "Printer readiness could not be confirmed before submission."
}

# 2. Record pre-submission spooler job IDs for this exact printer
$useCim = $false
$beforeIds = @()
try {
    $beforeIds = @(Get-PrintJob -PrinterName $printer -ErrorAction Stop | ForEach-Object { [int]$_.Id })
} catch {
    $useCim = $true
    $beforeIds = @(Get-CimInstance Win32_PrintJob -ErrorAction SilentlyContinue | Where-Object { $_.Name.StartsWith("$printer,") } | ForEach-Object { [int]$_.JobId })
}

if (-not $sumatra -or -not (Test-Path $sumatra)) {
    throw "Deterministic PDF printing requires SumatraPDF.exe. No unverified Windows PrintTo fallback is permitted."
}

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $sumatra
$psi.Arguments = "-print-to \`"$printer\`" -print-settings \`"$settings\`" -silent -exit-on-print \`"$pdf\`""
$psi.CreateNoWindow = $true
$psi.UseShellExecute = $false
$psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
$processStartedAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$proc = [System.Diagnostics.Process]::Start($psi)
if (-not $proc) {
    throw "SumatraPDF print process could not be started."
}

# 3. Correlate spooler job strictly using document identifier, printer queue, and pre-submission IDs
$fileName = [System.IO.Path]::GetFileName($pdf)
$fileNameWithoutExt = [System.IO.Path]::GetFileNameWithoutExtension($pdf)

$spoolCapturedAtMs = $null
$matchedJob = $null
$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()

function Find-MatchedJob {
    if (-not $useCim) {
        $rJobs = @(Get-PrintJob -PrinterName $printer -ErrorAction SilentlyContinue | Where-Object { $beforeIds -notcontains [int]$_.Id })
        if ($rJobs.Count -gt 0) {
            $tMatch = $rJobs | Where-Object { $_.DocumentName -and ($_.DocumentName.Contains($docIdentifier) -or $_.DocumentName.Contains($fileNameWithoutExt) -or $_.DocumentName.Contains($fileName)) }
            $m = if ($tMatch) { $tMatch[0] } else { $rJobs[0] }
            return [pscustomobject]@{ JobId = $m.Id; Document = $m.DocumentName }
        }
    } else {
        $rJobs = @(Get-CimInstance Win32_PrintJob -ErrorAction SilentlyContinue | Where-Object { $_.Name.StartsWith("$printer,") -and $beforeIds -notcontains [int]$_.JobId })
        if ($rJobs.Count -gt 0) {
            $tMatch = $rJobs | Where-Object { $_.Document -and ($_.Document.Contains($docIdentifier) -or $_.Document.Contains($fileNameWithoutExt) -or $_.Document.Contains($fileName)) }
            return if ($tMatch) { $tMatch[0] } else { $rJobs[0] }
        }
    }
    return $null
}

# Poll while process is running to catch jobs before fast despool
$iteration = 0
while (-not $proc.HasExited -and $stopwatch.ElapsedMilliseconds -lt 25000) {
    $sleepMs = if ($iteration -lt 3) { 30 } else { 80 }
    Start-Sleep -Milliseconds $sleepMs
    $matchedJob = Find-MatchedJob
    if ($matchedJob) {
        $spoolCapturedAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        break
    }
    $iteration++
}

# 4. Wait for SumatraPDF process to complete transmission cleanly
$waitTimeoutMs = if ($matchedJob) { 45000 } else { 15000 }
$exited = $proc.WaitForExit($waitTimeoutMs)
if (-not $exited) {
    $proc.Kill()
    if (-not $matchedJob) {
        throw "SumatraPDF print process timed out after 30 seconds."
    }
}
if ($exited -and $proc.ExitCode -ne 0 -and -not $matchedJob) {
    throw "SumatraPDF exited with error code $($proc.ExitCode)."
}

# If not caught while running, poll briefly post-exit
if (-not $matchedJob) {
    $pollLoops = if ($useCim) { 10 } else { 25 }
    $sleepMs = if ($useCim) { 150 } else { 50 }
    for ($i = 0; $i -lt $pollLoops; $i++) {
        $matchedJob = Find-MatchedJob
        if ($matchedJob) {
            $spoolCapturedAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            break
        }
        Start-Sleep -Milliseconds $sleepMs
    }
}


# If not caught while running, poll briefly post-exit
if (-not $matchedJob) {
    for ($i = 0; $i -lt 15; $i++) {
        $afterJobs = @(Get-CimInstance Win32_PrintJob -ErrorAction SilentlyContinue | Where-Object {
            $_.Name.StartsWith("$printer,") -and
            $beforeIds -notcontains [int]$_.JobId
        })
        if ($afterJobs.Count -gt 0) {
            $titleMatch = $afterJobs | Where-Object {
                $_.Document -and ($_.Document.Contains($docIdentifier) -or $_.Document.Contains($fileNameWithoutExt) -or $_.Document.Contains($fileName))
            }
            $matchedJob = if ($titleMatch) { $titleMatch[0] } else { $afterJobs[0] }
            $spoolCapturedAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            break
        }
        Start-Sleep -Milliseconds 100
    }
}

if ($matchedJob) {
    @{
        spoolJobId = [string]$matchedJob.JobId
        engineUsed = "sumatrapdf"
        fastDespooled = $false
        timings = @{ processStartedAtMs = $processStartedAtMs; spoolCapturedAtMs = $spoolCapturedAtMs; acceptedAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
    } | ConvertTo-Json -Compress
} else {
    # No positively correlated job ID: never infer success from a healthy printer.
    @{
        spoolJobId = "unobserved-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
        engineUsed = "sumatrapdf"
        fastDespooled = $false
        timings = @{ processStartedAtMs = $processStartedAtMs; spoolCapturedAtMs = $null; acceptedAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
    } | ConvertTo-Json -Compress
}
    `.trim();

    try {
      const output = (await this.executor(psScript)).trim();
      let spoolJobId: string;
      let engineUsed: string | undefined;
      let fastDespooled: boolean | undefined;
      let timings: SubmittedPrintJob["timings"];

      try {
        const parsed = JSON.parse(output) as {
          spoolJobId?: string;
          engineUsed?: string;
          fastDespooled?: boolean;
          timings?: SubmittedPrintJob["timings"];
        };
        spoolJobId = parsed.spoolJobId || `unobserved-${Date.now()}`;
        engineUsed = parsed.engineUsed;
        fastDespooled = parsed.fastDespooled;
        timings = parsed.timings;
      } catch {
        // Fallback for simple string output in tests
        spoolJobId = output || `unobserved-${Date.now()}`;
      }

      return {
        spoolJobId,
        engineUsed,
        fastDespooled,
        ...(timings ? { timings } : {}),
      };
    } catch (err: unknown) {
      if (
        err instanceof UnsupportedPrintSettingError ||
        err instanceof InvalidPrintSettingError ||
        err instanceof PrinterNotFoundError
      ) {
        throw err;
      }
      throw new Error(
        `Failed to submit print job to printer '${submission.printerId}': ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  async getJobStatus(
    printerId: string,
    spoolJobId: string,
  ): Promise<PrintJobStatus> {
    this.ensureWindows();

    if (
      spoolJobId.startsWith("unobserved-") ||
      spoolJobId.startsWith("despooled-") ||
      !/^\d+$/.test(spoolJobId)
    ) {
      return {
        state: "UNKNOWN",
        spoolJobId,
        failureCode: "UNKNOWN",
        message:
          "Spool job ID was unobserved or non-numeric; cannot verify completion from spooler queue absence.",
      };
    }

    const escapedPrinterName = printerId.replace(/'/g, "''");
    const escapedJobId = spoolJobId.replace(/'/g, "''");

    const psScript = `
$printer = '${escapedPrinterName}'
$targetId = '${escapedJobId}'
$intId = 0
$isInt = [int]::TryParse($targetId, [ref]$intId)

if (-not $isInt) {
  "INVALID_ID"
} else {
  $job = Get-CimInstance Win32_PrintJob -ErrorAction SilentlyContinue | Where-Object {
    $_.Name.StartsWith("$printer,") -and [int]$_.JobId -eq $intId
  } | Select-Object -First 1

  if (-not $job) {
    "REMOVED"
  } else {
    @{
      JobId = [string]$job.JobId
      JobStatus = [string]$job.JobStatus
      Status = [string]$job.Status
      StatusMask = [int]$job.StatusMask
      TotalPages = [int]$job.TotalPages
      PagesPrinted = [int]$job.PagesPrinted
    } | ConvertTo-Json -Compress
  }
}
    `.trim();

    try {
      const output = (await this.executor(psScript)).trim();
      if (output === "INVALID_ID") {
        return {
          state: "UNKNOWN",
          spoolJobId,
          failureCode: "UNKNOWN",
          message: "Invalid or non-numeric spool job ID.",
        };
      }
      if (!output || output === "REMOVED") {
        return {
          state: "COMPLETED_OR_REMOVED",
          spoolJobId,
          message: "Spool job completed and handed off to printer.",
        };
      }

      const parsed = JSON.parse(output) as {
        JobId?: string;
        JobStatus?: string;
        Status?: string;
        StatusMask?: number;
        TotalPages?: number;
        PagesPrinted?: number;
      };

      const mask = parsed.StatusMask ?? 0;
      const jobStatus = (parsed.JobStatus ?? "").toLowerCase();
      const status = (parsed.Status ?? "").toLowerCase();
      const totalPages = parsed.TotalPages ?? 0;
      const pagesPrinted = parsed.PagesPrinted ?? 0;

      // Check for completion states (including Windows retained completed jobs)
      if (
        (mask & 0x1000) !== 0 ||
        (mask & 0x0080) !== 0 ||
        jobStatus.includes("complete") ||
        jobStatus.includes("printed") ||
        (totalPages > 0 && pagesPrinted >= totalPages)
      ) {
        return {
          state: "COMPLETED_OR_REMOVED",
          spoolJobId,
          message: "Spool job completed and handed off to printer.",
        };
      }

      // Check for blocked states (CRITICAL RULE: BLOCKED != FAILED)
      if (
        (mask & 0x0040) !== 0 ||
        jobStatus.includes("paperout") ||
        jobStatus.includes("paper out")
      ) {
        return {
          state: "BLOCKED",
          spoolJobId,
          failureCode: "PAPER_OUT",
          message: "Printer is out of paper.",
        };
      }
      if (jobStatus.includes("jam")) {
        return {
          state: "BLOCKED",
          spoolJobId,
          failureCode: "PAPER_JAM",
          message: "Printer paper jam.",
        };
      }
      if (jobStatus.includes("door") || jobStatus.includes("cover")) {
        return {
          state: "BLOCKED",
          spoolJobId,
          failureCode: "DOOR_OPEN",
          message: "Printer door or cover open.",
        };
      }
      if (
        (mask & 0x0400) !== 0 ||
        jobStatus.includes("user intervention") ||
        jobStatus.includes("userintervention")
      ) {
        return {
          state: "BLOCKED",
          spoolJobId,
          failureCode: "USER_INTERVENTION",
          message: "User intervention required.",
        };
      }
      if ((mask & 0x0020) !== 0 || jobStatus.includes("offline")) {
        return {
          state: "BLOCKED",
          spoolJobId,
          failureCode: "OFFLINE",
          message: "Printer is offline.",
        };
      }
      if ((mask & 0x0200) !== 0) {
        return {
          state: "BLOCKED",
          spoolJobId,
          failureCode: "PRINTER_ERROR",
          message: "Printer device queue is blocked.",
        };
      }

      // Check for failure states
      if (
        (mask & 0x0002) !== 0 ||
        status === "error" ||
        jobStatus === "error"
      ) {
        return {
          state: "FAILED",
          spoolJobId,
          failureCode: "PRINTER_ERROR",
          message: "Spooler error occurred.",
        };
      }

      // In-flight progress states
      if ((mask & 0x0008) !== 0 || jobStatus.includes("spooling")) {
        return { state: "SPOOLING", spoolJobId };
      }
      if ((mask & 0x0010) !== 0 || jobStatus.includes("printing")) {
        return { state: "PRINTING", spoolJobId };
      }

      return { state: "QUEUED", spoolJobId };
    } catch (err: unknown) {
      return {
        state: "UNKNOWN",
        spoolJobId,
        failureCode: "UNKNOWN",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async cancelJob(printerId: string, spoolJobId: string): Promise<void> {
    this.ensureWindows();
    const escapedPrinterName = printerId.replace(/'/g, "''");
    const escapedJobId = spoolJobId.replace(/'/g, "''");

    const psScript = `
$printer = '${escapedPrinterName}'
$targetId = '${escapedJobId}'
$intId = 0
$isInt = [int]::TryParse($targetId, [ref]$intId)

$job = Get-CimInstance Win32_PrintJob -ErrorAction SilentlyContinue | Where-Object {
  $_.Name.StartsWith("$printer,") -and $isInt -and [int]$_.JobId -eq $intId
} | Select-Object -First 1

if ($job) {
  $job | Remove-CimInstance
}
    `.trim();

    try {
      await this.executor(psScript);
    } catch {
      // Best-effort cancellation
    }
  }

  async clearPrintGoSpoolJobs(
    printerId: string,
  ): Promise<{ cancelledJobIds: string[] }> {
    this.ensureWindows();
    const escapedPrinterName = printerId.replace(/'/g, "''");

    const psScript = `
$printer = '${escapedPrinterName}'
$jobs = @(Get-CimInstance Win32_PrintJob -ErrorAction SilentlyContinue | Where-Object {
  $_.Name.StartsWith("$printer,") -and ($_.Document -and ($_.Document.StartsWith("printgo-") -or $_.Document.Contains("printgo-")))
})
$cancelled = @()
foreach ($j in $jobs) {
  $id = [string]$j.JobId
  try {
    $j | Remove-CimInstance -ErrorAction Stop
    $cancelled += $id
  } catch {
    # Ignore individual job removal error
  }
}
@{ cancelledJobIds = $cancelled } | ConvertTo-Json -Compress
`.trim();

    try {
      const output = await this.executor(psScript);
      const parsed = JSON.parse(output.trim()) as {
        cancelledJobIds?: string[] | string;
      };
      const cancelled = Array.isArray(parsed.cancelledJobIds)
        ? parsed.cancelledJobIds.map(String)
        : parsed.cancelledJobIds
          ? [String(parsed.cancelledJobIds)]
          : [];
      return { cancelledJobIds: cancelled };
    } catch {
      return { cancelledJobIds: [] };
    }
  }
}

/**
 * Development & mock printer adapter for non-Windows platforms (macOS / Linux).
 */
export class DevelopmentPrinterAdapter implements PrinterAdapter {
  private printers: Array<{
    summary: PrinterSummary;
    capabilities: PrinterCapabilities;
    status: PrinterStatus;
  }> = [
    {
      summary: {
        id: "Shop LaserJet Pro M404dn",
        displayName: "Shop LaserJet Pro M404dn (Mono)",
        isDefault: true,
      },
      capabilities: {
        colour: false,
        duplex: true,
        paperSizes: ["A4", "LETTER"],
      },
      status: {
        availability: "ONLINE",
      },
    },
    {
      summary: {
        id: "Shop Color LaserJet Pro MFP",
        displayName: "Shop Color LaserJet Pro MFP",
        isDefault: false,
      },
      capabilities: {
        colour: true,
        duplex: true,
        paperSizes: ["A4", "LETTER"],
      },
      status: {
        availability: "ONLINE",
      },
    },
  ];

  private simulatedJobs = new Map<
    string,
    {
      printerId: string;
      submittedAt: number;
      mockStatus?: PrintJobStatus;
      documentTitle?: string | undefined;
    }
  >();

  setSimulatedJobStatus(spoolJobId: string, status: PrintJobStatus): void {
    const job = this.simulatedJobs.get(spoolJobId);
    if (job) {
      job.mockStatus = status;
    }
  }

  listPrinters(): Promise<readonly PrinterSummary[]> {
    return Promise.resolve(this.printers.map((p) => p.summary));
  }

  getCapabilities(printerId: string): Promise<PrinterCapabilities> {
    const p = this.printers.find((item) => item.summary.id === printerId);
    return Promise.resolve(
      p
        ? p.capabilities
        : {
            colour: "UNKNOWN",
            duplex: "UNKNOWN",
            paperSizes: ["A4", "LETTER"],
          },
    );
  }

  getStatus(printerId: string): Promise<PrinterStatus> {
    const p = this.printers.find((item) => item.summary.id === printerId);
    return Promise.resolve(
      p ? p.status : { availability: "OFFLINE", message: "Printer not found" },
    );
  }

  async submitPdfJob(submission: PrintSubmission): Promise<SubmittedPrintJob> {
    const caps = await this.getCapabilities(submission.printerId);
    validateAndNormalizePrintSettings(submission, caps);
    const spoolJobId = `dev-spool-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    this.simulatedJobs.set(spoolJobId, {
      printerId: submission.printerId,
      submittedAt: Date.now(),
      documentTitle: submission.documentTitle,
    });
    return { spoolJobId, engineUsed: "simulated" };
  }

  getJobStatus(printerId: string, spoolJobId: string): Promise<PrintJobStatus> {
    void printerId;
    const job = this.simulatedJobs.get(spoolJobId);
    if (!job) {
      return Promise.resolve({
        state: "COMPLETED_OR_REMOVED",
        spoolJobId,
        message: "Spool job completed and handed off to printer.",
      });
    }
    if (job.mockStatus) {
      return Promise.resolve(job.mockStatus);
    }
    const elapsed = Date.now() - job.submittedAt;
    if (elapsed < 200) {
      return Promise.resolve({ state: "SPOOLING", spoolJobId });
    }
    if (elapsed < 500) {
      return Promise.resolve({ state: "PRINTING", spoolJobId });
    }
    return Promise.resolve({
      state: "COMPLETED_OR_REMOVED",
      spoolJobId,
      message: "Spool job completed and handed off to printer.",
    });
  }

  cancelJob(printerId: string, spoolJobId: string): Promise<void> {
    void printerId;
    this.simulatedJobs.delete(spoolJobId);
    return Promise.resolve();
  }

  clearPrintGoSpoolJobs(
    printerId: string,
  ): Promise<{ cancelledJobIds: string[] }> {
    void printerId;
    const cancelledJobIds: string[] = [];
    for (const [spoolId, job] of this.simulatedJobs.entries()) {
      if (!job.documentTitle || job.documentTitle.startsWith("printgo-")) {
        cancelledJobIds.push(spoolId);
      }
    }
    for (const id of cancelledJobIds) {
      this.simulatedJobs.delete(id);
    }
    return Promise.resolve({ cancelledJobIds });
  }
}

export function createDefaultPrinterAdapter(): PrinterAdapter {
  if (process.platform === "win32") {
    return new WindowsPrinterAdapter();
  }
  if (
    process.env.NODE_ENV === "production" ||
    process.env.APP_ENV === "production"
  ) {
    throw new Error(
      "Production PrintGo Agent requires a Windows host (win32). Development printer simulation is forbidden in production.",
    );
  }
  return new DevelopmentPrinterAdapter();
}
