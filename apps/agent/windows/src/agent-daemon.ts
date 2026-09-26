import * as fs from "node:fs/promises";
import type {
  AgentHeartbeatRequest,
  AgentPrinterReport,
  AgentTestPrintCommand,
} from "@printgo/api-contract";
import { AGENT_HEARTBEAT_INTERVAL_MS } from "@printgo/domain";
import { AgentAuthError, AgentClient } from "./agent-client.js";
import { createDiagnosticPdfFile } from "./printing/diagnostic-pdf.js";
import type { PrinterAdapter } from "./printing/printer-adapter.js";
import { monitorSpoolJob } from "./printing/spool-monitor.js";
import type {
  AgentCredentials,
  CredentialStore,
} from "./storage/credential-store.js";

export interface AgentDaemonOptions {
  client?: AgentClient;
  credentialStore: CredentialStore;
  printerAdapter: PrinterAdapter;
  heartbeatIntervalMs?: number;
  agentVersion?: string;
  onStatusChange?: (status: string) => void;
  onError?: (err: Error) => void;
}

export class AgentDaemon {
  private readonly client: AgentClient;
  private readonly credentialStore: CredentialStore;
  private readonly printerAdapter: PrinterAdapter;
  private readonly heartbeatIntervalMs: number;
  private readonly agentVersion: string;
  private readonly onStatusChange: ((status: string) => void) | undefined;
  private readonly onError: ((err: Error) => void) | undefined;

  private credentials: AgentCredentials | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private isBeating = false;
  private readonly executedCommandIds = new Set<string>();

  constructor(options: AgentDaemonOptions) {
    this.client = options.client ?? new AgentClient();
    this.credentialStore = options.credentialStore;
    this.printerAdapter = options.printerAdapter;
    this.heartbeatIntervalMs =
      options.heartbeatIntervalMs ?? AGENT_HEARTBEAT_INTERVAL_MS;
    this.agentVersion = options.agentVersion ?? "2.0.0";
    this.onStatusChange = options.onStatusChange;
    this.onError = options.onError;
  }

  async pair(
    serverUrl: string,
    pairCode: string,
    displayName: string,
  ): Promise<AgentCredentials> {
    this.log(`Pairing with server ${serverUrl} using a one-time code...`);
    const pairResult = await this.client.pair(serverUrl, pairCode, displayName);

    const creds: AgentCredentials = {
      agentId: pairResult.agentId,
      agentSecret: pairResult.agentSecret,
      serverUrl,
      displayName: pairResult.displayName,
    };

    await this.credentialStore.save(creds);
    this.credentials = creds;
    this.log(
      `Successfully paired as "${pairResult.displayName}" (${pairResult.agentId})`,
    );
    return creds;
  }

  async start(): Promise<boolean> {
    if (this.running) return true;

    this.credentials = await this.credentialStore.load();
    if (!this.credentials) {
      this.log("No credentials found. Daemon is idle awaiting pairing.");
      return false;
    }

    this.running = true;
    this.log(
      `Starting heartbeat daemon for agent ${this.credentials.agentId} (${this.credentials.displayName})...`,
    );

    // Perform immediate first heartbeat
    await this.pulse();

    // Schedule regular heartbeat if still running
    if (this.running) {
      this.timer = setInterval(() => {
        void this.pulse();
      }, this.heartbeatIntervalMs);
    }

    return this.running;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
    this.log("Agent daemon stopped.");
  }

  async pulse(): Promise<void> {
    if (!this.credentials || this.isBeating) return;
    this.isBeating = true;

    try {
      const summaries = await this.printerAdapter.listPrinters();
      const printerReports: AgentPrinterReport[] = [];

      for (const summary of summaries) {
        const [caps, status] = await Promise.all([
          this.printerAdapter.getCapabilities(summary.id),
          this.printerAdapter.getStatus(summary.id),
        ]);

        printerReports.push({
          windowsPrinterName: summary.id,
          displayName: summary.displayName,
          isDefault: summary.isDefault,
          status:
            status.availability === "AVAILABLE"
              ? "ONLINE"
              : status.availability,
          statusReason: status.message ?? null,
          capabilities: {
            colour: caps.colour,
            duplex: caps.duplex,
            paperSizes: caps.paperSizes,
          },
        });
      }

      const request: AgentHeartbeatRequest = {
        agentVersion: this.agentVersion,
        operationalState: "ONLINE",
        printers: printerReports,
      };

      const heartbeatData = await this.client.sendHeartbeat(
        this.credentials.serverUrl,
        this.credentials.agentId,
        this.credentials.agentSecret,
        request,
      );

      this.log(
        `Heartbeat acknowledged by ${this.credentials.serverUrl} (${printerReports.length} printers reported).`,
      );

      // Check if server returned a diagnostic test command
      if (heartbeatData.nextCommand?.type === "TEST_PRINT") {
        await this.handleTestPrintCommand(heartbeatData.nextCommand);
      }
    } catch (err: unknown) {
      if (err instanceof AgentAuthError) {
        this.log(
          `Agent authorization failed: ${err.message}. Stopping daemon.`,
        );
        this.stop();
        if (this.onError) this.onError(err);
      } else {
        this.log(
          `Heartbeat error: ${err instanceof Error ? err.message : String(err)}`,
        );
        if (this.onError && err instanceof Error) this.onError(err);
      }
    } finally {
      this.isBeating = false;
    }
  }

  private async handleTestPrintCommand(
    command: AgentTestPrintCommand,
  ): Promise<void> {
    if (!this.credentials) return;

    // Idempotency: each command ID is executed at most once
    if (this.executedCommandIds.has(command.commandId)) {
      this.log(
        `Command ${command.commandId} was already executed. Ignoring duplicate.`,
      );
      return;
    }

    // Expiration check: ignore expired commands
    if (Date.now() >= command.expiresAtMs) {
      this.log(`Command ${command.commandId} has expired. Ignoring.`);
      return;
    }

    this.executedCommandIds.add(command.commandId);
    this.log(
      `Executing test print command ${command.commandId} for printer ${command.windowsPrinterName}...`,
    );

    let tempPdfPath: string | null = null;
    try {
      // 1. Generate local diagnostic document
      tempPdfPath = await createDiagnosticPdfFile({
        printerDisplayName: command.windowsPrinterName,
        agentDisplayName: this.credentials.displayName,
        commandId: command.commandId,
      });

      // 2. Submit to Windows printer via adapter
      const submission = await this.printerAdapter.submitPdfJob({
        printerId: command.windowsPrinterName,
        localPdfPath: tempPdfPath,
        documentTitle: `printgo-test-${command.commandId}`,
        copies: 1,
        settings: {
          printerName: command.windowsPrinterName,
          copies: 1,
          paperSize: "A4",
          colorMode: "BLACK_AND_WHITE",
          sides: "ONE_SIDED",
          pageRange: "1",
        },
      });

      this.log(
        `Test page submitted to spooler (Spool ID: ${submission.spoolJobId}). Reporting SUBMITTED...`,
      );

      // Report SUBMITTED status to Worker
      await this.client.reportCommand(
        this.credentials.serverUrl,
        this.credentials.agentId,
        this.credentials.agentSecret,
        command.commandId,
        {
          status: "SUBMITTED",
          spoolerJobId: submission.spoolJobId,
        },
      );

      // 3. Monitor spool status (bounded wait)
      const observed = await monitorSpoolJob(
        this.printerAdapter,
        command.windowsPrinterName,
        submission.spoolJobId,
      );

      this.log(
        `Observed spool status for job ${submission.spoolJobId}: ${observed.state}`,
      );

      // 4. Report final result
      let finalStatus: "SUCCEEDED" | "BLOCKED" | "FAILED" = "SUCCEEDED";
      if (observed.state === "BLOCKED") {
        finalStatus = "BLOCKED";
      } else if (observed.state === "FAILED") {
        finalStatus = "FAILED";
      }

      await this.client.reportCommand(
        this.credentials.serverUrl,
        this.credentials.agentId,
        this.credentials.agentSecret,
        command.commandId,
        {
          status: finalStatus,
          spoolerJobId: submission.spoolJobId,
          failureCode: observed.failureCode ?? null,
          failureDetail: observed.message ?? null,
        },
      );
    } catch (err: unknown) {
      this.log(
        `Test print failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      try {
        await this.client.reportCommand(
          this.credentials.serverUrl,
          this.credentials.agentId,
          this.credentials.agentSecret,
          command.commandId,
          {
            status: "FAILED",
            failureCode: "PRINTER_ERROR",
            failureDetail: err instanceof Error ? err.message : String(err),
          },
        );
      } catch {
        // Best-effort reporting
      }
    } finally {
      // 5. Always clean up temporary diagnostic PDF file
      if (tempPdfPath) {
        await fs.unlink(tempPdfPath).catch(() => {});
      }
    }
  }

  private log(message: string): void {
    if (this.onStatusChange) {
      this.onStatusChange(message);
    } else {
      console.log(`[PrintGo Agent] ${message}`);
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  getCredentials(): AgentCredentials | null {
    return this.credentials;
  }
}
