import * as fs from "node:fs/promises";
import type {
  AgentHeartbeatRequest,
  AgentPrinterReport,
  AgentPrintJob,
  AgentTestPrintCommand,
  AgentClearSpoolerCommand,
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
import { type AgentLogger, getAgentLogger } from "./logging/agent-logger.js";

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
  logger?: AgentLogger;
}

export class AgentDaemon {
  private readonly client: AgentClient;
  private readonly credentialStore: CredentialStore;
  private readonly printerAdapter: PrinterAdapter;
  private readonly heartbeatIntervalMs: number;
  private readonly agentVersion: string;
  private readonly onStatusChange: ((status: string) => void) | undefined;
  private readonly onError: ((err: Error) => void) | undefined;
  private readonly logger: AgentLogger | undefined;
  private hasReportedConnected = false;
  private hasReportedPrinterReady = false;

  private readonly printerRefreshMs: number;
  private readonly random: () => number;
  private printerReports: AgentPrinterReport[] = [];
  private lastPrinterRefreshMs = -Infinity;
  private lastReportedPrinters = "";
  private nextDelayMs = 5_000;
  private idlePolls = 0;
  private failures = 0;
  private lastStatusWriteMs = -Infinity;

  // OPT-8: Event-driven printer health and stability tracking
  private consecutiveHealthyChecks = 0;
  private isPrinterMonitoringStable = false;
  private unsubscribePrinterEvents: (() => void) | null = null;

  private credentials: AgentCredentials | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private isBeating = false;
  // Phase 1: Survives the WAKE_UP race when a pulse is in progress
  private pendingWakeup = false;
  // Phase 2: Marks an explicit printer probe request (e.g. from recovery or health check)
  private pendingProbe = false;
  // Phase 2: Marks a wakeup-initiated pulse to skip redundant printer refresh
  private wakeupTriggered = false;
  private ws: WebSocket | null = null;
  private wsReconnectDelayMs = 2_000;
  private wsPingTimer: NodeJS.Timeout | null = null;
  private readonly executedCommandIds = new Map<string, number>();
  private readonly executionJournal: ExecutionJournalStore =
    new ExecutionJournalStore();
  private readonly activeLanes = new Map<
    string,
    { job: AgentPrintJob; deviceKey: string; promise: Promise<void> }
  >();
  private readonly activePhysicalDevices = new Map<string, string>();
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
      this.heartbeatIntervalMs > 65_000 ||
      !Number.isFinite(this.printerRefreshMs) ||
      this.printerRefreshMs < 1_000 ||
      this.printerRefreshMs > 120_000
    )
      throw new Error("Invalid Agent polling intervals.");
    this.agentVersion = options.agentVersion ?? "2.0.0";
    this.onStatusChange = options.onStatusChange;
    this.onError = options.onError;
    this.logger = options.logger;
    this.paidPrintExecutor = new PaidPrintExecutor(
      this.client,
      this.printerAdapter,
      this.executionJournal,
      (message) => this.log(message),
      () => {
        this.nextDelayMs = 0;
        this.reschedulePulse();
      },
      this.logger,
      (printerName, reason) => this.markPrinterFault(printerName, reason),
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

    await this.executionJournal.migrateLegacy();
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
    this.logger?.starting();
    this.log(
      `Starting heartbeat daemon for agent ${this.credentials.agentId} (${this.credentials.displayName})...`,
    );

    // Perform immediate first heartbeat
    await this.pulse();

    this.connectWebSocket();
    this.schedulePulse();

    return this.running;
  }

  private connectWebSocket(): void {
    if (!this.running || !this.credentials) return;

    // Cleanup existing connection
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.close();
    }
    if (this.wsPingTimer) {
      clearInterval(this.wsPingTimer);
      this.wsPingTimer = null;
    }

    try {
      const wsUrl = new URL(this.credentials.serverUrl);
      wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
      wsUrl.pathname = "/api/agent/ws";
      wsUrl.searchParams.set("token", this.credentials.agentSecret);

      this.ws = new WebSocket(wsUrl.toString(), ["printgo-agent-v1"]);

      this.ws.onopen = () => {
        this.log(
          "Connected to server WebSocket. Immediate work-check pulse scheduled.",
        );
        this.wsReconnectDelayMs = 2_000;
        this.nextDelayMs = 0;
        this.wakeupTriggered = true;
        if (this.isBeating) {
          this.pendingWakeup = true;
        }
        this.reschedulePulse();

        // Periodic keep-alive ping (every 30s) prevents NAT gateway and Cloudflare idle connection drops
        if (this.wsPingTimer) {
          clearInterval(this.wsPingTimer);
          this.wsPingTimer = null;
        }
        this.wsPingTimer = setInterval(() => {
          if (
            this.ws &&
            (this.ws as unknown as { readyState?: number }).readyState === 1
          ) {
            try {
              this.ws.send(JSON.stringify({ type: "PING" }));
            } catch {
              // Ignored
            }
          }
        }, 30_000);
        this.wsPingTimer.unref?.();
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(String(event.data)) as { type?: string };
          if (data.type === "WAKE_UP") {
            this.log("Received instant wake-up notification");
            this.nextDelayMs = 0;
            this.wakeupTriggered = true;
            if (this.isBeating) {
              // Pulse is in progress — flag it so the finally block
              // will schedule an immediate follow-up instead of idle delay.
              this.pendingWakeup = true;
            }
            this.reschedulePulse();
          } else if (data.type === "PROBE_PRINTER") {
            const targetPrinterId = (
              data as { type: string; printerId?: string }
            ).printerId;
            this.log(
              `Received PROBE_PRINTER request for printer: ${targetPrinterId ?? "all"}`,
            );
            // Force immediate fresh hardware probe on next pulse.
            // Explicitly set pendingProbe and clear wakeupTriggered so racing WAKE_UP cannot suppress it.
            this.pendingProbe = true;
            this.wakeupTriggered = false;
            this.lastPrinterRefreshMs = -Infinity;
            this.nextDelayMs = 0;
            if (this.isBeating) {
              this.pendingWakeup = true;
            }
            this.reschedulePulse();
          }
        } catch {
          // Ignore invalid messages
        }
      };

      this.ws.onerror = () => {
        // Ignored, onclose will handle reconnect
      };

      this.ws.onclose = () => {
        this.ws = null;
        if (this.wsPingTimer) {
          clearInterval(this.wsPingTimer);
          this.wsPingTimer = null;
        }
        if (this.running) {
          const delay = this.wsReconnectDelayMs;
          this.wsReconnectDelayMs = Math.min(15_000, delay * 2);
          setTimeout(() => this.connectWebSocket(), delay);
        }
      };
    } catch (err) {
      this.log(
        `Failed to initiate WebSocket: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (this.running) {
        const delay = this.wsReconnectDelayMs;
        this.wsReconnectDelayMs = Math.min(15_000, delay * 2);
        setTimeout(() => this.connectWebSocket(), delay);
      }
    }
  }

  private schedulePulse(): void {
    if (!this.running) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
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

  private reschedulePulse(): void {
    if (!this.running) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.schedulePulse();
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    if (this.wsPingTimer) {
      clearInterval(this.wsPingTimer);
      this.wsPingTimer = null;
    }
    this.unsubscribeFromPrinterEvents();
    this.consecutiveHealthyChecks = 0;
    this.isPrinterMonitoringStable = false;
    this.running = false;
    this.hasReportedConnected = false;
    this.hasReportedPrinterReady = false;
    this.activeLanes.clear();
    this.activePhysicalDevices.clear();
    this.logger?.info("Stopped");
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
      const productionPrintersForRefresh = this.printerReports.filter(
        (p) => p.isEligibleForProductionPrint !== false && !p.isVirtual,
      );
      const printersToCheckForRefresh =
        productionPrintersForRefresh.length > 0
          ? productionPrintersForRefresh
          : this.printerReports;
      const unhealthy =
        printersToCheckForRefresh.length === 0 ||
        printersToCheckForRefresh.some((p) => p.status !== "ONLINE");
      // A blocked/unhealthy printer needs a local health probe every 30 seconds;
      // when healthy and stable, safety fallback probe is every 15 minutes;
      // otherwise, during startup/recovery, probes run every 60 seconds.
      const refreshEveryMs = unhealthy
        ? 30_000
        : this.isPrinterMonitoringStable
          ? 15 * 60 * 1_000
          : this.printerRefreshMs;
      const isExplicitProbe =
        this.pendingProbe || this.lastPrinterRefreshMs === -Infinity;
      this.pendingProbe = false;

      // Phase 2: On a wakeup-triggered pulse, skip printer refresh if we have
      // recent healthy reports — speed matters more than a redundant probe.
      // NEVER skip if an explicit probe was requested!
      const skipRefreshForWakeup =
        !isExplicitProbe &&
        this.wakeupTriggered &&
        this.printerReports.length > 0 &&
        this.printerReports.some(
          (p) =>
            p.status === "ONLINE" &&
            p.isEligibleForProductionPrint !== false &&
            !p.isVirtual,
        );
      this.wakeupTriggered = false; // consume the flag
      const refreshPrinters =
        !skipRefreshForWakeup &&
        (isExplicitProbe ||
          this.lastPrinterRefreshMs === -Infinity ||
          Date.now() - this.lastPrinterRefreshMs >= refreshEveryMs);
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

        // Check health of production-eligible printers (or all if none explicitly flagged)
        const productionPrinters = printerReports.filter(
          (p) => p.isEligibleForProductionPrint !== false && !p.isVirtual,
        );
        const printersToCheck =
          productionPrinters.length > 0 ? productionPrinters : printerReports;

        const allHealthy =
          printersToCheck.length > 0 &&
          printersToCheck.every((p) => p.status === "ONLINE");

        if (allHealthy) {
          this.consecutiveHealthyChecks++;
          if (
            this.consecutiveHealthyChecks >= 5 &&
            !this.isPrinterMonitoringStable
          ) {
            this.isPrinterMonitoringStable = true;
            this.subscribeToPrinterEvents();
            this.log(
              "PRINTER_MONITORING_STABLE: 5 consecutive healthy checks achieved. Switched to event-driven monitoring with 15-minute safety fallback.",
            );
          }
        } else {
          if (
            this.isPrinterMonitoringStable ||
            this.consecutiveHealthyChecks > 0
          ) {
            this.log(
              "Printer health check found offline or unhealthy printer(s). Resetting stability to startup mode (60s checks).",
            );
          }
          this.consecutiveHealthyChecks = 0;
          this.isPrinterMonitoringStable = false;
          this.unsubscribeFromPrinterEvents();
        }
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
      if (!this.hasReportedConnected) {
        this.hasReportedConnected = true;
        this.logger?.connected();
        this.log("AGENT_CONNECTED");
      }
      const ready = printerReports.some(
        (p) =>
          p.status === "ONLINE" &&
          p.isEligibleForProductionPrint !== false &&
          !p.isVirtual,
      );
      if (ready) {
        if (!this.hasReportedPrinterReady) {
          this.hasReportedPrinterReady = true;
          this.logger?.printerReady();
          this.log("PRINTER_READY");
        }
      } else {
        this.hasReportedPrinterReady = false;
        this.logger?.setPrinterNotReady();
      }
      const rawJobs: AgentPrintJob[] = [];
      if (heartbeatData.printJobs && heartbeatData.printJobs.length > 0) {
        for (const job of heartbeatData.printJobs) {
          rawJobs.push(job);
        }
      } else if (heartbeatData.printJob?.type === "PAID_PRINT_JOB") {
        rawJobs.push(heartbeatData.printJob);
      }

      const hadWork = Boolean(
        heartbeatData.nextCommand ||
        rawJobs.length > 0 ||
        this.activeLanes.size > 0,
      );
      if (hadWork || (reportChanged && ready)) {
        this.idlePolls = 0;
      } else {
        this.idlePolls = Math.min(this.idlePolls + 1, 4);
      }
      const productionPrintersForDelay = this.printerReports.filter(
        (p) => p.isEligibleForProductionPrint !== false && !p.isVirtual,
      );
      const printersToCheckForDelay =
        productionPrintersForDelay.length > 0
          ? productionPrintersForDelay
          : this.printerReports;
      const anyFaulted =
        printersToCheckForDelay.length === 0 ||
        printersToCheckForDelay.some((p) => p.status !== "ONLINE");

      if (rawJobs.length > 0 || this.activeLanes.size > 0) {
        this.nextDelayMs = 6_000;
      } else if (anyFaulted) {
        // While any printer fault persists, recheck hardware locally every 30 seconds in actual elapsed scheduling
        this.nextDelayMs = 30_000;
      } else if (heartbeatData.onlinePrintingEnabled === false || !ready) {
        this.nextDelayMs = 60_000;
      } else {
        // 60s idle heartbeat schedule: perfectly aligned with the 40s D1 write throttle and 90s claim cutoff.
        // Guarantees an idle agent's D1 heartbeat is never older than 60s (preventing false offline states after 2, 5, 10, 30 min idle),
        // while consuming only ~900 requests/day (<1.0% of Cloudflare Free Tier).
        this.nextDelayMs = 60_000;
      }
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

      // Check if server returned a diagnostic test or recovery control command
      if (heartbeatData.nextCommand?.type === "TEST_PRINT") {
        await this.handleTestPrintCommand(heartbeatData.nextCommand);
      } else if (heartbeatData.nextCommand?.type === "CLEAR_SPOOLER") {
        const clearSucceeded = await this.handleClearSpoolerCommand(
          heartbeatData.nextCommand,
        );
        if (!clearSucceeded) {
          this.log(
            "CLEAR_SPOOLER command was not cleared successfully. Aborting job processing for printer safety.",
          );
          return;
        }
      }

      const lanePromises: Promise<void>[] = [];
      for (const job of rawJobs) {
        if (job.type !== "PAID_PRINT_JOB") continue;
        if (this.activeLanes.has(job.orderId)) continue;

        const deviceKey =
          job.physicalDeviceId || job.printerId || job.windowsPrinterName;
        if (this.activePhysicalDevices.has(deviceKey)) {
          this.log(
            `Physical device "${deviceKey}" is currently busy with order ${this.activePhysicalDevices.get(deviceKey)}. Deferring parallel execution of order ${job.orderId}.`,
          );
          continue;
        }

        this.activePhysicalDevices.set(deviceKey, job.orderId);

        const lanePromise = (async () => {
          try {
            const printOutcome = await this.paidPrintExecutor.handle(
              this.credentials!,
              job,
            );
            if (printOutcome === "PREFLIGHT_DEFERRED") {
              this.nextDelayMs = 30_000;
              this.reschedulePulse();
            } else if (printOutcome === "BLOCKED_RELEASED") {
              this.nextDelayMs = 6_000;
              this.reschedulePulse();
            }
          } catch (err: unknown) {
            const error = err instanceof Error ? err : new Error(String(err));
            this.log(
              `Paid print operation failed inside its safety boundary: ${error.message}`,
            );
            this.notifyError(error);
          } finally {
            this.activeLanes.delete(job.orderId);
            this.activePhysicalDevices.delete(deviceKey);
          }
        })();

        this.activeLanes.set(job.orderId, {
          job,
          deviceKey,
          promise: lanePromise,
        });
        lanePromises.push(lanePromise);
      }

      if (lanePromises.length > 0) {
        await Promise.all(
          lanePromises.map((p) => Promise.race([p, Promise.resolve()])),
        );
      }
    } catch (err: unknown) {
      this.hasReportedConnected = false;
      this.logger?.setDisconnected();
      if (err instanceof AgentAuthError) {
        this.log(
          `Agent authorization failed: ${err.message}. Stopping daemon.`,
        );
        this.stop();
        this.notifyError(err);
      } else {
        this.failures++;
        this.idlePolls = 0;
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
      if (this.pendingWakeup) {
        this.pendingWakeup = false;
        this.nextDelayMs = 0;
        if (!this.pendingProbe) {
          this.wakeupTriggered = true;
        }
        this.log(
          this.pendingProbe
            ? "Processing deferred PROBE_PRINTER signal from concurrent pulse"
            : "Processing deferred WAKE_UP signal from concurrent pulse",
        );
      }
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

      // 1. Generate local diagnostic document according to requested test type
      const testType = command.testType ?? "STANDARD";
      tempPdfPath = await createDiagnosticPdfFile({
        shopName: command.shopName,
        printerDisplayName: command.printerDisplayName,
        testType,
      });

      const paperSize =
        command.testSettings?.paperSize ?? (testType === "A3" ? "A3" : "A4");
      const colorMode =
        command.testSettings?.colorMode === "COLOR" || testType === "COLOR"
          ? "COLOUR"
          : "BLACK_AND_WHITE";
      const sides =
        command.testSettings?.sides === "DOUBLE" || testType === "DUPLEX"
          ? "TWO_SIDED_LONG"
          : "ONE_SIDED";
      const pageRange = testType === "DUPLEX" ? "1-2" : "1";

      // 2. Submit to Windows printer via adapter with accurate requested settings
      const submission = await this.printerAdapter.submitPdfJob({
        printerId: command.windowsPrinterName,
        localPdfPath: tempPdfPath,
        documentTitle: `printgo-test-${command.commandId}`,
        copies: 1,
        settings: {
          printerName: command.windowsPrinterName,
          copies: 1,
          paperSize,
          colorMode,
          sides,
          pageRange,
        },
        isDiagnosticTestPrint: true,
      });

      if (
        submission.fastDespooled ||
        submission.spoolJobId.startsWith("despooled-") ||
        submission.spoolJobId.startsWith("unobserved-")
      ) {
        this.log(
          `Test page for ${command.windowsPrinterName} could not be positively correlated in spooler (${submission.spoolJobId}). Reporting FAILED.`,
        );
        await this.client.reportCommand(
          this.credentials.serverUrl,
          this.credentials.agentId,
          this.credentials.agentSecret,
          command.commandId,
          {
            status: "FAILED",
            spoolerJobId: submission.spoolJobId,
            failureCode: "PRINTER_ERROR",
            failureDetail:
              "Windows accepted the print command but the spooler job could not be correlated safely.",
          },
        );
        return;
      }

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
      } else if (
        observed.state === "FAILED" ||
        observed.state === "UNKNOWN" ||
        observed.state !== "COMPLETED_OR_REMOVED"
      ) {
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
          failureCode:
            observed.failureCode ??
            (finalStatus === "FAILED" ? "PRINTER_ERROR" : null),
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

  private async handleClearSpoolerCommand(
    command: AgentClearSpoolerCommand,
  ): Promise<boolean> {
    if (!this.credentials) return false;

    if (this.executedCommandIds.has(command.commandId)) {
      this.log(`Command ${command.commandId} was already executed. Ignoring.`);
      return true;
    }
    if (Date.now() >= command.expiresAtMs) {
      this.log(`Command ${command.commandId} has expired. Ignoring.`);
      return false;
    }
    for (const [id, expiry] of this.executedCommandIds) {
      if (expiry <= Date.now()) this.executedCommandIds.delete(id);
    }
    this.executedCommandIds.set(command.commandId, command.expiresAtMs);

    this.log(
      `Executing CLEAR_SPOOLER command ${command.commandId} for printer ${command.windowsPrinterName}...`,
    );

    try {
      let cancelledJobIds: string[] = [];
      if (typeof this.printerAdapter.clearPrintGoSpoolJobs === "function") {
        const result = await this.printerAdapter.clearPrintGoSpoolJobs(
          command.windowsPrinterName,
        );
        cancelledJobIds = result.cancelledJobIds;
      }
      this.log(
        `CLEAR_SPOOLER cancelled ${cancelledJobIds.length} PrintGo job(s) from spooler for printer ${command.windowsPrinterName}.`,
      );

      // Report SUCCEEDED to server
      await this.client.reportCommand(
        this.credentials.serverUrl,
        this.credentials.agentId,
        this.credentials.agentSecret,
        command.commandId,
        {
          status: "SUCCEEDED",
          cancelledJobIds,
        },
      );
      return true;
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.log(`CLEAR_SPOOLER failed: ${errorMsg}`);
      await this.client
        .reportCommand(
          this.credentials.serverUrl,
          this.credentials.agentId,
          this.credentials.agentSecret,
          command.commandId,
          {
            status: "FAILED",
            failureCode: "PRINTER_ERROR",
            failureDetail: errorMsg,
          },
        )
        .catch(() => undefined);
      return false;
    }
  }

  private log(message: string): void {
    if (this.onStatusChange) {
      try {
        this.onStatusChange(message);
      } catch (err: unknown) {
        if (this.logger) {
          this.logger.error(
            `Status callback failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        } else {
          console.error(
            "[PGO] Status callback failed:",
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    } else {
      if (this.logger) {
        this.logger.handleDaemonStatus(message);
      } else {
        getAgentLogger().handleDaemonStatus(message);
      }
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

  markPrinterFault(printerName: string, reason?: string | null): void {
    const wasStable = this.isPrinterMonitoringStable;
    const prevChecks = this.consecutiveHealthyChecks;
    this.consecutiveHealthyChecks = 0;
    this.isPrinterMonitoringStable = false;
    this.unsubscribeFromPrinterEvents();
    this.lastPrinterRefreshMs = -Infinity;
    if (wasStable || prevChecks > 0) {
      this.log(
        `Printer fault detected on "${printerName}" (${reason ?? "fault"}). Resetting printer monitoring stability to startup mode (60s checks).`,
      );
    }
    this.nextDelayMs = 0;
    this.reschedulePulse();
  }

  private subscribeToPrinterEvents(): void {
    if (this.unsubscribePrinterEvents) return;
    if (typeof this.printerAdapter.subscribePrinterEvents === "function") {
      try {
        const unsubscribe = this.printerAdapter.subscribePrinterEvents(
          (event) => {
            const pName = event.printerName ?? "unknown";
            const eType = event.eventType ?? "STATUS_CHANGE";
            this.log(`Printer event received for "${pName}": ${eType}`);
            if (
              eType === "OFFLINE" ||
              eType === "ERROR" ||
              eType === "JAM" ||
              eType === "PAPER_OUT" ||
              eType === "PAUSED"
            ) {
              this.markPrinterFault(pName, eType);
            } else {
              this.lastPrinterRefreshMs = -Infinity;
              this.nextDelayMs = 0;
              this.reschedulePulse();
            }
          },
        );
        this.unsubscribePrinterEvents = unsubscribe;
      } catch (err: unknown) {
        this.log(
          `Failed to subscribe to printer events: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private unsubscribeFromPrinterEvents(): void {
    if (this.unsubscribePrinterEvents) {
      try {
        this.unsubscribePrinterEvents();
      } catch {
        // Ignore unsubscribe error
      }
      this.unsubscribePrinterEvents = null;
    }
  }

  isWebSocketConnected(): boolean {
    return (
      this.ws !== null &&
      ((this.ws as unknown as { readyState?: number }).readyState === 1 ||
        (this.ws as unknown as { readyState?: string }).readyState === "open")
    );
  }

  getConsecutiveHealthyChecks(): number {
    return this.consecutiveHealthyChecks;
  }

  isPrinterStable(): boolean {
    return this.isPrinterMonitoringStable;
  }

  isPendingWakeup(): boolean {
    return this.pendingWakeup;
  }

  isPendingProbe(): boolean {
    return this.pendingProbe;
  }

  isWakeupTriggered(): boolean {
    return this.wakeupTriggered;
  }

  isRunning(): boolean {
    return this.running;
  }

  getCredentials(): AgentCredentials | null {
    return this.credentials;
  }
}
