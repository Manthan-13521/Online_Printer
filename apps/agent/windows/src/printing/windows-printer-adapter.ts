import { execFile } from "node:child_process";
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
  CapabilityDescriptions?: string[];
}

export class WindowsPrinterAdapter implements PrinterAdapter {
  private readonly executor: PowerShellExecutor;

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
Get-CimInstance Win32_Printer | Select-Object Name, Default, WorkOffline, PrinterStatus, DetectedErrorState, ExtendedPrinterStatus, CapabilityDescriptions | ConvertTo-Json -Compress
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
        .map((p) => ({
          id: p.Name,
          displayName: p.Name,
          isDefault: Boolean(p.Default),
        }));
    } catch (err: unknown) {
      console.error("Failed to query Win32_Printer:", err);
      return [];
    }
  }

  async getCapabilities(printerId: string): Promise<PrinterCapabilities> {
    this.ensureWindows();

    const escapedName = printerId.replace(/'/g, "''");
    const psCommand = `
Get-CimInstance Win32_Printer -Filter "Name = '$([regex]::Escape('${escapedName}'))'" | Select-Object Name, CapabilityDescriptions | ConvertTo-Json -Compress
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

      const colour =
        capsText.includes("color") || capsText.includes("colour")
          ? true
          : "UNKNOWN";
      const duplex =
        capsText.includes("duplex") || capsText.includes("two-sided")
          ? true
          : "UNKNOWN";

      return {
        colour,
        duplex,
        paperSizes: ["A4", "LETTER"],
      };
    } catch {
      return {
        colour: "UNKNOWN",
        duplex: "UNKNOWN",
        paperSizes: ["A4", "LETTER"],
      };
    }
  }

  async getStatus(printerId: string): Promise<PrinterStatus> {
    this.ensureWindows();

    const escapedName = printerId.replace(/'/g, "''");
    const psCommand = `
Get-CimInstance Win32_Printer -Filter "Name = '$([regex]::Escape('${escapedName}'))'" | Select-Object Name, WorkOffline, PrinterStatus, DetectedErrorState | ConvertTo-Json -Compress
    `.trim();

    try {
      const output = (await this.executor(psCommand)).trim();
      if (!output) {
        return { availability: "OFFLINE", message: "Printer not found" };
      }

      const p = JSON.parse(output) as CimPrinterOutput;

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
      throw new Error("Target printer ID is required for print submission.");
    }
    if (
      !submission.localPdfPath ||
      submission.localPdfPath.trim().length === 0
    ) {
      throw new Error("Local PDF path is required for print submission.");
    }

    const escapedPrinterName = submission.printerId.replace(/'/g, "''");
    const escapedPdfPath = submission.localPdfPath.replace(/'/g, "''");

    const psScript = `
$printer = '${escapedPrinterName}'
$pdf = '${escapedPdfPath}'

$beforeIds = @(Get-CimInstance Win32_PrintJob -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "$printer,*" } | ForEach-Object { [int]$_.JobId })

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $pdf
$psi.Verb = "PrintTo"
$psi.Arguments = "\`"$printer\`""
$psi.CreateNoWindow = $true
$psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
$proc = [System.Diagnostics.Process]::Start($psi)
if ($proc) {
  $proc.WaitForExit(10000)
}
Start-Sleep -Milliseconds 400

$afterJobs = @(Get-CimInstance Win32_PrintJob -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "$printer,*" })
$newJob = $afterJobs | Where-Object { $beforeIds -notcontains [int]$_.JobId } | Select-Object -First 1

if ($newJob) {
  $newJob.JobId
} else {
  "spool-submitted"
}
    `.trim();

    try {
      const output = (await this.executor(psScript)).trim();
      const spoolJobId = output || `spool-${Date.now()}`;
      return { spoolJobId };
    } catch (err: unknown) {
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
  $_.Name -like "$printer,*" -and ($_.Name -like "*$targetId*" -or ($isInt -and [int]$_.JobId -eq $intId))
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
  $_.Name -like "$printer,*" -and ($_.Name -like "*$targetId*" -or ($isInt -and [int]$_.JobId -eq $intId))
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

  submitPdfJob(submission: PrintSubmission): Promise<SubmittedPrintJob> {
    const spoolJobId = `dev-spool-${Date.now()}`;
    this.simulatedJobs.set(spoolJobId, {
      printerId: submission.printerId,
      submittedAt: Date.now(),
    });
    return Promise.resolve({ spoolJobId });
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
