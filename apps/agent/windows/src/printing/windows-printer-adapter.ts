import { execFile } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
  PrintJobStatus,
  PrinterAdapter,
  PrinterCapabilities,
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
  Color?: boolean;
  CapabilityDescriptions?: string[];
  PrinterPaperNames?: string[];
  PortName?: string;
  DriverName?: string;
}

export class WindowsPrinterAdapter implements PrinterAdapter {
  private readonly executor: PowerShellExecutor;
  private readonly capabilitiesCache = new Map<
    string,
    { caps: PrinterCapabilities; cachedAtMs: number }
  >();
  private readonly statusCache = new Map<
    string,
    { status: PrinterStatus; cachedAtMs: number }
  >();

  constructor(executor: PowerShellExecutor = defaultPowerShellExecutor) {
    this.executor = executor;
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

  async listPrinters(): Promise<readonly PrinterSummary[]> {
    this.ensureWindows();

    const psCommand = `
Get-CimInstance Win32_Printer | Select-Object Name, Default, WorkOffline, PrinterStatus, DetectedErrorState, ExtendedPrinterStatus, CapabilityDescriptions, PortName, DriverName | ConvertTo-Json -Compress
    `.trim();

    try {
      const output = (await this.executor(psCommand)).trim();
      if (!output) return [];

      const parsed: unknown = JSON.parse(output);
      const list: CimPrinterOutput[] = Array.isArray(parsed)
        ? (parsed as CimPrinterOutput[])
        : [parsed as CimPrinterOutput];

      return list
        .filter(
          (p) => p && typeof p.Name === "string" && p.Name.trim().length > 0,
        )
        .map((p) => {
          const classification = classifyPrinter({
            name: p.Name,
            portName: p.PortName ?? null,
            driverName: p.DriverName ?? null,
          });

          const status = this.parsePrinterStatus(p);
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
    } catch (err: unknown) {
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
Get-CimInstance Win32_Printer | Where-Object { $_.Name -eq $printer } | Select-Object Name, Color, CapabilityDescriptions, PrinterPaperNames | ConvertTo-Json -Compress
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
        capsText.includes("black and white") ||
        caps.length > 0
      ) {
        colour = false;
      }

      let duplex: boolean | "UNKNOWN" = "UNKNOWN";
      if (capsText.includes("duplex") || capsText.includes("two-sided")) {
        duplex = true;
      } else if (
        capsText.includes("simplex") ||
        capsText.includes("single-sided") ||
        caps.length > 0
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

      const result: PrinterCapabilities = {
        colour,
        duplex,
        paperSizes: Array.from(paperSizesSet),
      };
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

  private parsePrinterStatus(p: CimPrinterOutput): PrinterStatus {
    if (p.WorkOffline) {
      return {
        availability: "OFFLINE",
        message: "Printer is set to work offline",
      };
    }

    switch (p.DetectedErrorState) {
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

    // PrinterStatus: 3 = Idle, 4 = Printing, 5 = Warmup, 7 = Offline
    if (p.PrinterStatus === 7) {
      return { availability: "OFFLINE", message: "Printer is offline" };
    }
    if (
      p.PrinterStatus === 3 ||
      p.PrinterStatus === 4 ||
      p.PrinterStatus === 5
    ) {
      return { availability: "ONLINE" };
    }
    if (p.DetectedErrorState === 2) {
      // No Error
      return { availability: "ONLINE" };
    }

    return { availability: "ONLINE" };
  }

  async getStatus(printerId: string): Promise<PrinterStatus> {
    this.ensureWindows();

    const cached = this.statusCache.get(printerId);
    if (cached && Date.now() - cached.cachedAtMs < 5_000) {
      return cached.status;
    }

    const escapedName = printerId.replace(/'/g, "''");
    const psCommand = `
$printer = '${escapedName}'
Get-CimInstance Win32_Printer | Where-Object { $_.Name -eq $printer } | Select-Object Name, WorkOffline, PrinterStatus, DetectedErrorState | ConvertTo-Json -Compress
    `.trim();

    try {
      const output = (await this.executor(psCommand)).trim();
      if (!output) {
        return { availability: "OFFLINE", message: "Printer not found" };
      }

      const p = JSON.parse(output) as CimPrinterOutput;
      const status = this.parsePrinterStatus(p);
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

    const psScript = `
$printer = '${escapedPrinterName}'
$pdf = '${escapedPdfPath}'
$docIdentifier = '${escapedDocIdentifier}'
$settings = '${escapedSettings}'

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
}

# 2. Record pre-submission spooler job IDs for this exact printer
$beforeIds = @(Get-CimInstance Win32_PrintJob -ErrorAction SilentlyContinue | Where-Object { $_.Name.StartsWith("$printer,") } | ForEach-Object { [int]$_.JobId })

if (-not $sumatra -or -not (Test-Path $sumatra)) {
    throw "Deterministic PDF printing requires SumatraPDF.exe. No unverified Windows PrintTo fallback is permitted."
}

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $sumatra
$psi.Arguments = "-print-to \`"$printer\`" -print-settings \`"$settings\`" -silent \`"$pdf\`""
$psi.CreateNoWindow = $true
$psi.UseShellExecute = $false
$psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
$proc = [System.Diagnostics.Process]::Start($psi)
if (-not $proc) {
    throw "SumatraPDF print process could not be started."
}

# 3. Correlate spooler job strictly using document identifier, printer queue, and pre-submission IDs
$fileName = [System.IO.Path]::GetFileName($pdf)
$fileNameWithoutExt = [System.IO.Path]::GetFileNameWithoutExtension($pdf)

$matchedJob = $null
$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()

# Poll while process is running to catch jobs before fast despool
while (-not $proc.HasExited -and $stopwatch.ElapsedMilliseconds -lt 25000) {
    Start-Sleep -Milliseconds 80
    $runningJobs = @(Get-CimInstance Win32_PrintJob -ErrorAction SilentlyContinue | Where-Object {
        $_.Name.StartsWith("$printer,") -and
        $beforeIds -notcontains [int]$_.JobId -and
        ($_.Document.Contains($docIdentifier) -or $_.Document.Contains($fileNameWithoutExt) -or $_.Document.Contains($fileName))
    })
    if ($runningJobs.Count -gt 0) {
        $matchedJob = $runningJobs[0]
        break
    }
}

$exited = $proc.WaitForExit(5000)
if (-not $exited) {
    $proc.Kill()
    throw "SumatraPDF print process timed out after 30 seconds."
}
if ($proc.ExitCode -ne 0) {
    throw "SumatraPDF exited with error code $($proc.ExitCode)."
}

# If not caught while running, poll briefly post-exit
if (-not $matchedJob) {
    for ($i = 0; $i -lt 10; $i++) {
        $afterJobs = @(Get-CimInstance Win32_PrintJob -ErrorAction SilentlyContinue | Where-Object {
            $_.Name.StartsWith("$printer,") -and
            $beforeIds -notcontains [int]$_.JobId -and
            ($_.Document.Contains($docIdentifier) -or $_.Document.Contains($fileNameWithoutExt) -or $_.Document.Contains($fileName))
        })
        if ($afterJobs.Count -gt 0) {
            $matchedJob = $afterJobs[0]
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
    } | ConvertTo-Json -Compress
} else {
    # Check printer queue state: if printer is clean with no error state,
    # the small job despooled directly into hardware buffer
    $printerObj = Get-CimInstance Win32_Printer -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq $printer } | Select-Object -First 1 WorkOffline, PrinterStatus, DetectedErrorState
    $isClean = (-not $printerObj.WorkOffline) -and ($null -eq $printerObj.DetectedErrorState -or $printerObj.DetectedErrorState -eq 0 -or $printerObj.DetectedErrorState -eq 2)
    if ($isClean) {
        @{
            spoolJobId = "despooled-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
            engineUsed = "sumatrapdf"
            fastDespooled = $true
        } | ConvertTo-Json -Compress
    } else {
        @{
            spoolJobId = "unobserved-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
            engineUsed = "sumatrapdf"
            fastDespooled = $false
        } | ConvertTo-Json -Compress
    }
}
    `.trim();

    try {
      const output = (await this.executor(psScript)).trim();
      let spoolJobId: string;
      let engineUsed: string | undefined;
      let fastDespooled: boolean | undefined;

      try {
        const parsed = JSON.parse(output) as {
          spoolJobId?: string;
          engineUsed?: string;
          fastDespooled?: boolean;
        };
        spoolJobId = parsed.spoolJobId || `unobserved-${Date.now()}`;
        engineUsed = parsed.engineUsed;
        fastDespooled = parsed.fastDespooled;
      } catch {
        // Fallback for simple string output in tests
        spoolJobId = output || `unobserved-${Date.now()}`;
      }

      return { spoolJobId, engineUsed, fastDespooled };
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

if (-not $job) {
  "REMOVED"
} else {
  @{
    JobId = [string]$job.JobId
    JobStatus = [string]$job.JobStatus
    Status = [string]$job.Status
    StatusMask = [int]$job.StatusMask
  } | ConvertTo-Json -Compress
}
    `.trim();

    try {
      const output = (await this.executor(psScript)).trim();
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
      };

      const mask = parsed.StatusMask ?? 0;
      const jobStatus = (parsed.JobStatus ?? "").toLowerCase();
      const status = (parsed.Status ?? "").toLowerCase();

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
    const spoolJobId = `dev-spool-${Date.now()}`;
    this.simulatedJobs.set(spoolJobId, {
      printerId: submission.printerId,
      submittedAt: Date.now(),
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
