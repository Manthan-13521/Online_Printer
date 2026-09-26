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

  submitPdfJob(submission: PrintSubmission): Promise<SubmittedPrintJob> {
    void submission;
    return Promise.reject(
      new Error("Printing jobs is intentionally deferred until Phase 8."),
    );
  }

  getJobStatus(spoolJobId: string): Promise<PrintJobStatus> {
    void spoolJobId;
    return Promise.reject(
      new Error(
        "Job status inspection is intentionally deferred until Phase 8.",
      ),
    );
  }

  cancelJob(spoolJobId: string): Promise<void> {
    void spoolJobId;
    return Promise.reject(
      new Error("Job cancellation is intentionally deferred until Phase 8."),
    );
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
    void submission;
    return Promise.reject(
      new Error("Printing jobs is intentionally deferred until Phase 8."),
    );
  }

  getJobStatus(spoolJobId: string): Promise<PrintJobStatus> {
    void spoolJobId;
    return Promise.reject(
      new Error(
        "Job status inspection is intentionally deferred until Phase 8.",
      ),
    );
  }

  cancelJob(spoolJobId: string): Promise<void> {
    void spoolJobId;
    return Promise.reject(
      new Error("Job cancellation is intentionally deferred until Phase 8."),
    );
  }
}

export function createDefaultPrinterAdapter(): PrinterAdapter {
  if (process.platform === "win32") {
    return new WindowsPrinterAdapter();
  }
  return new DevelopmentPrinterAdapter();
}
