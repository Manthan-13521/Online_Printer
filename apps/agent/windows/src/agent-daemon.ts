import * as fs from "node:fs/promises";
import type {
  AgentHeartbeatRequest,
  AgentPrinterReport,
  AgentTestPrintCommand,
} from "@printgo/api-contract";
import { AgentAuthError, AgentClient } from "./agent-client.js";
import { createDiagnosticPdfFile } from "./printing/diagnostic-pdf.js";
import type { PrinterAdapter } from "./printing/printer-adapter.js";
import { monitorSpoolJob } from "./printing/spool-monitor.js";
import type {
  AgentCredentials,
  CredentialStore,
} from "./storage/credential-store.js";
import { PaidPrintExecutor } from "./paid-print-executor.js";
import { ExecutionJournalStore } from "./storage/execution-journal.js";
import {
  writeAgentStatus,
  type PrinterStatusInfo,
} from "./storage/status-file.js";

export interface AgentDaemonOptions {
  client?: AgentClient;
  credentialStore: CredentialStore;
  printerAdapter: PrinterAdapter;
  heartbeatIntervalMs?: number;
  printerRefreshMs?: number;
  random?: () => number;
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

  private readonly printerRefreshMs: number;
  private readonly random: () => number;
  private printerReports: AgentPrinterReport[] = [];
  private lastPrinterRefreshMs = -Infinity;
  private lastReportedPrinters = "";
  private nextDelayMs = 5_000;
  private failures = 0;
  private lastStatusWriteMs = -Infinity;

  private credentials: AgentCredentials | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private isBeating = false;
  private readonly executedCommandIds = new Map<string, number>();
  private readonly paidPrintExecutor: PaidPrintExecutor;

  constructor(options: AgentDaemonOptions) {
    this.client = options.client ?? new AgentClient();
    this.credentialStore = options.credentialStore;
    this.printerAdapter = options.printerAdapter;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5_000;
    this.printerRefreshMs = options.printerRefreshMs ?? 60_000;
    this.random = options.random ?? Math.random;
    if (
      !Number.isFinite(this.heartbeatIntervalMs) ||
      this.heartbeatIntervalMs < 100 ||
      this.heartbeatIntervalMs > 30_000 ||
      !Number.isFinite(this.printerRefreshMs) ||
      this.printerRefreshMs < 1_000 ||
      this.printerRefreshMs > 60_000
    )
      throw new Error("Invalid Agent polling intervals.");
    this.agentVersion = options.agentVersion ?? "2.0.0";
    this.onStatusChange = options.onStatusChange;
    this.onError = options.onError;
    this.paidPrintExecutor = new PaidPrintExecutor(
      this.client,
      this.printerAdapter,
      new ExecutionJournalStore(),
      (message) => this.log(message),
      () => {
        this.nextDelayMs = 0;
      },
    );
  }

  async pair(
    serverUrl: string,
    pairCode: string,
    displayName: string,
  ): Promise<AgentCredentials> {
    if (typeof this.credentialStore.verifyReadiness === "function") {
      this.log("Verifying local credential protection system...");
      await this.credentialStore.verifyReadiness();
    }

    this.log(`Pairing with server ${serverUrl} using a one-time code...`);
    const pairResult = await this.client.pair(serverUrl, pairCode, displayName);

    const creds: AgentCredentials = {
      agentId: pairResult.agentId,
      agentSecret: pairResult.agentSecret,
      serverUrl,
      displayName: pairResult.displayName,
    };

    try {
      await this.credentialStore.save(creds);
    } catch (saveError: unknown) {
      this.log(
        `WARNING: Agent was paired on server, but saving credentials locally failed: ${saveError instanceof Error ? saveError.message : String(saveError)}. You can revoke the unpaired agent in PrintGo Admin and generate a new pairing code.`,
      );
      throw saveError;
    }

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
      void writeAgentStatus({
        operationalState: "UNPAIRED",
        agentVersion: this.agentVersion,
        agentId: null,
        displayName: null,
        serverUrl: null,
        lastHeartbeatMs: null,
        printers: [],
        updatedAtMs: Date.now(),
      }).catch(() => undefined);
      return false;
    }

    this.running = true;
    this.log(
      `Starting heartbeat daemon for agent ${this.credentials.agentId} (${this.credentials.displayName})...`,
    );

    // Perform immediate first heartbeat
    await this.pulse();

    this.schedulePulse();

    return this.running;
  }

  private schedulePulse(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pulse()
        .catch((err: unknown) => {
          // Last-resort boundary: a programming or callback failure in one
          // iteration must not become an unhandled rejection that kills the
          // long-running Agent.
          const error = err instanceof Error ? err : new Error(String(err));
          this.log(`Unexpected Agent iteration failure: ${error.message}`);
          this.notifyError(error);
        })
        .finally(() => this.schedulePulse());
    }, this.nextDelayMs);
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.running = false;
    this.log("Agent daemon stopped.");
    void writeAgentStatus({
      operationalState: "OFFLINE",
      agentVersion: this.agentVersion,
      agentId: this.credentials?.agentId ?? null,
      displayName: this.credentials?.displayName ?? null,
      serverUrl: this.credentials?.serverUrl ?? null,
      lastHeartbeatMs: null,
      printers: [],
      updatedAtMs: Date.now(),
    }).catch(() => undefined);
  }

  async pulse(): Promise<void> {
    if (!this.credentials || this.isBeating) return;
    this.isBeating = true;

    try {
      const unhealthy =
        this.printerReports.length === 0 ||
        this.printerReports.some((p) => p.status !== "ONLINE");
      const refreshEveryMs = unhealthy
        ? Math.min(30_000, this.printerRefreshMs)
        : this.printerRefreshMs;
      const refreshPrinters =
        Date.now() - this.lastPrinterRefreshMs >=
        (this.nextDelayMs === 0 ? 60_000 : refreshEveryMs);
      if (refreshPrinters) {
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
            isEligibleForProductionPrint:
              summary.isEligibleForProductionPrint ?? true,
            isVirtual: summary.isVirtual ?? false,
            portName: summary.portName ?? null,
            driverName: summary.driverName ?? null,
          });
        }

        this.printerReports = printerReports;
        this.lastPrinterRefreshMs = Date.now();
      }
      const printerReports = this.printerReports;
      const printerSnapshot = JSON.stringify(printerReports);
      const reportChanged = printerSnapshot !== this.lastReportedPrinters;
      const request: Omit<AgentHeartbeatRequest, "printers"> & {
        printers?: AgentPrinterReport[];
      } = {
        agentVersion: this.agentVersion,
        operationalState: "ONLINE",
        ...(reportChanged ? { printers: printerReports } : {}),
      };

      const heartbeatData = await this.client.sendHeartbeat(
        this.credentials.serverUrl,
        this.credentials.agentId,
        this.credentials.agentSecret,
        request,
      );

      this.lastReportedPrinters = printerSnapshot;
      this.failures = 0;
      const ready = printerReports.some(
        (p) =>
          p.status === "ONLINE" &&
          p.isEligibleForProductionPrint !== false &&
          !p.isVirtual,
      );
      this.nextDelayMs =
        heartbeatData.onlinePrintingEnabled === false || !ready
          ? 30_000
          : this.heartbeatIntervalMs;
      if (Date.now() - this.lastStatusWriteMs >= 60_000 || refreshPrinters) {
        this.lastStatusWriteMs = Date.now();

        const printerStatusList: PrinterStatusInfo[] = printerReports.map(
          (p) => ({
            name: p.windowsPrinterName,
            displayName: p.displayName,
            status: p.status,
            statusReason: p.statusReason ?? null,
            isDefault: p.isDefault ?? false,
            isEligible: p.isEligibleForProductionPrint ?? true,
          }),
        );
        void writeAgentStatus({
          operationalState: "ONLINE",
          agentVersion: this.agentVersion,
          agentId: this.credentials.agentId,
          displayName: this.credentials.displayName,
          serverUrl: this.credentials.serverUrl,
          lastHeartbeatMs: Date.now(),
          printers: printerStatusList,
          updatedAtMs: Date.now(),
        }).catch(() => undefined);
      }

      // Check if server returned a diagnostic test command
      if (heartbeatData.nextCommand?.type === "TEST_PRINT") {
        await this.handleTestPrintCommand(heartbeatData.nextCommand);
      }
      if (heartbeatData.printJob?.type === "PAID_PRINT_JOB") {
        try {
          await this.paidPrintExecutor.handle(
            this.credentials,
            heartbeatData.printJob,
          );
        } catch (err: unknown) {
          const error = err instanceof Error ? err : new Error(String(err));
          this.log(
            `Paid print operation failed inside its safety boundary: ${error.message}`,
          );
          this.notifyError(error);
        }
      }
    } catch (err: unknown) {
      if (err instanceof AgentAuthError) {
        this.log(
          `Agent authorization failed: ${err.message}. Stopping daemon.`,
        );
        this.stop();
        this.notifyError(err);
      } else {
        this.failures++;
        this.lastPrinterRefreshMs = -Infinity;
        this.nextDelayMs =
          Math.min(
            30_000,
            this.heartbeatIntervalMs * 2 ** Math.min(this.failures, 6),
          ) *
          (0.8 + this.random() * 0.2);
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.log(
          `Agent communication failed: ${errorMsg}; retrying with bounded backoff.`,
        );
        if (err instanceof Error) this.notifyError(err);
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

    for (const [id, expiry] of this.executedCommandIds) {
      if (expiry <= Date.now()) this.executedCommandIds.delete(id);
    }
    this.executedCommandIds.set(command.commandId, command.expiresAtMs);
    this.log(
      `Executing test print command ${command.commandId} for printer ${command.windowsPrinterName}...`,
    );

    let tempPdfPath: string | null = null;
    try {
      // An explicit operator test also refreshes local inventory/capability
      // caches. Keep this inside the per-command boundary: discovery failure
      // is a failed test, not an Agent-process failure.
      await this.printerAdapter.listPrinters(true);
      this.lastPrinterRefreshMs = -Infinity;

      // 1. Generate local diagnostic document
      tempPdfPath = await createDiagnosticPdfFile({
        shopName: command.shopName,
        printerDisplayName: command.printerDisplayName,
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
      const error = err instanceof Error ? err : new Error(String(err));
      this.log(
        `Test print failed: ${error.message}. The Agent will remain running.`,
      );
      this.notifyError(error);
      try {
        await this.client.reportCommand(
          this.credentials.serverUrl,
          this.credentials.agentId,
          this.credentials.agentSecret,
          command.commandId,
          {
            status: "FAILED",
            failureCode: "PRINTER_ERROR",
            failureDetail: error.message,
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
      try {
        this.onStatusChange(message);
      } catch (err: unknown) {
        console.error(
          "[PrintGo Agent] Status callback failed:",
          err instanceof Error ? err.message : String(err),
        );
      }
    } else {
      console.log(`[PrintGo Agent] ${message}`);
    }
  }

  private notifyError(error: Error): void {
    if (!this.onError) return;
    try {
      this.onError(error);
    } catch (callbackError: unknown) {
      this.log(
        `Error callback failed: ${callbackError instanceof Error ? callbackError.message : String(callbackError)}`,
      );
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  getCredentials(): AgentCredentials | null {
    return this.credentials;
  }
}
